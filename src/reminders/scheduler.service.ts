import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Invoice, ReminderStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  REMINDERS_QUEUE,
  REMINDER_STAGES,
  getReminderJobId,
} from './reminders.constants';

const ONE_STANDARD_DAY_MS = 86_400_000;

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly dayUnitMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectQueue(REMINDERS_QUEUE) private readonly remindersQueue: Queue,
  ) {
    this.dayUnitMs = Number(
      this.configService.get<string>(
        'REMINDER_DAY_MS',
        String(ONE_STANDARD_DAY_MS),
      ),
    );
  }

  /**
   * Computes the target timestamp for a stage (3, 7, or 14 days after dueDate).
   * In production (dayUnitMs === 86400000), adjusts to 09:30–17:00 business hours
   * on weekdays (Mon-Fri) in the account's timezone.
   * In fast local test mode (e.g., REMINDER_DAY_MS=3000), schedules relative to now/dueDate.
   */
  computeScheduledFor(
    dueDate: Date,
    stage: number,
    timezone = 'UTC',
  ): Date {
    const baseTime =
      this.dayUnitMs < ONE_STANDARD_DAY_MS
        ? Math.max(dueDate.getTime(), Date.now())
        : dueDate.getTime();

    const target = new Date(baseTime + stage * this.dayUnitMs);

    // If running in fast-forward test mode, skip business-hour shifting
    if (this.dayUnitMs < ONE_STANDARD_DAY_MS) {
      return target;
    }

    return this.adjustToBusinessWindow(target, timezone);
  }

  private adjustToBusinessWindow(date: Date, timezone: string): Date {
    const candidate = new Date(date.getTime());
    const validTz = this.resolveTimezone(timezone);

    // Advance up to 7 days until we hit a weekday (Mon-Fri) inside 09:00-17:00 local time
    for (let i = 0; i < 8; i++) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: validTz,
        weekday: 'short',
        hour: 'numeric',
        hour12: false,
      }).formatToParts(candidate);

      const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
      const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '10');

      if (weekday === 'Sat') {
        candidate.setUTCDate(candidate.getUTCDate() + 2);
        continue;
      }
      if (weekday === 'Sun') {
        candidate.setUTCDate(candidate.getUTCDate() + 1);
        continue;
      }

      if (hour < 9) {
        candidate.setUTCHours(candidate.getUTCHours() + (9 - hour), 30, 0, 0);
      } else if (hour >= 17) {
        // Move to next day at ~09:30 and re-check weekday
        candidate.setUTCHours(
          candidate.getUTCHours() + (24 - hour + 9),
          30,
          0,
          0,
        );
        continue;
      }
      break;
    }

    return candidate;
  }

  private resolveTimezone(tz: string): string {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return tz;
    } catch {
      return 'UTC';
    }
  }

  /**
   * Idempotently creates and schedules Day 3, 7, and 14 reminders for an OPEN invoice.
   */
  async scheduleForInvoice(
    invoice: Invoice,
    timezone = 'UTC',
  ): Promise<void> {
    for (const stage of REMINDER_STAGES) {
      const scheduledFor = this.computeScheduledFor(
        invoice.dueDate,
        stage,
        timezone,
      );

      // Upsert via @@unique([invoiceId, stage]) so duplicate webhook deliveries never create twice
      const existing = await this.prisma.reminder.findUnique({
        where: {
          invoiceId_stage: {
            invoiceId: invoice.id,
            stage,
          },
        },
      });

      // Never re-schedule a stage that has already been sent, skipped, or is awaiting approval
      if (
        existing &&
        existing.status !== ReminderStatus.SCHEDULED
      ) {
        continue;
      }

      const reminder = existing
        ? await this.prisma.reminder.update({
            where: { id: existing.id },
            data: { scheduledFor },
          })
        : await this.prisma.reminder.create({
            data: {
              invoiceId: invoice.id,
              stage,
              scheduledFor,
              status: ReminderStatus.SCHEDULED,
            },
          });

      const jobId = getReminderJobId(invoice.id, stage);
      const delay = Math.max(0, scheduledFor.getTime() - Date.now());

      // Remove any stale delayed job with the same ID before adding with the updated delay
      const existingJob = await this.remindersQueue.getJob(jobId);
      if (existingJob) {
        try {
          await existingJob.remove();
        } catch {
          // Job may already be active; worker idempotency handles it
        }
      }

      await this.remindersQueue.add(
        `stage-${stage}`,
        {
          reminderId: reminder.id,
          invoiceId: invoice.id,
          stage,
        },
        {
          jobId,
          delay,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
        },
      );

      this.logger.log(
        `Scheduled stage ${stage} reminder for invoice ${invoice.stripeInvoiceId} (jobId=${jobId}, delayMs=${delay}, scheduledFor=${scheduledFor.toISOString()})`,
      );
    }
  }

  /**
   * Deterministic cancellation on PAID / VOID / UNCOLLECTIBLE:
   * 1. Removes pending delayed jobs from Redis by deterministic jobId
   * 2. Marks all SCHEDULED / PENDING_APPROVAL reminder rows as SKIPPED
   */
  async cancelForInvoice(invoiceId: string, reason: string): Promise<void> {
    for (const stage of REMINDER_STAGES) {
      const jobId = getReminderJobId(invoiceId, stage);
      try {
        const job = await this.remindersQueue.getJob(jobId);
        if (job) {
          await job.remove();
          this.logger.debug(`Removed queued BullMQ job ${jobId}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        this.logger.warn(
          `Could not remove job ${jobId} from queue (live check will catch it): ${msg}`,
        );
      }
    }

    const updated = await this.prisma.reminder.updateMany({
      where: {
        invoiceId,
        status: {
          in: [ReminderStatus.SCHEDULED, ReminderStatus.PENDING_APPROVAL],
        },
      },
      data: {
        status: ReminderStatus.SKIPPED,
        failureReason: reason,
      },
    });

    if (updated.count > 0) {
      this.logger.log(
        `Cancelled ${updated.count} pending reminder(s) for invoiceId=${invoiceId} (reason="${reason}")`,
      );
    }
  }
}