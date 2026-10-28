import {
  Processor,
  WorkerHost,
  OnWorkerEvent,
  InjectQueue,
} from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { InvoiceStatus, ReminderStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { InvoicesService } from '../invoices/invoices.service';
import { MailService } from '../mail/mail.service';
import { formatMinorUnits } from '../mail/mail.templates';
import { AiService } from '../ai/ai.service';
import { ToneProfile } from '../ai/interfaces/tone-profile.interface';
import { MetricsService } from '../observability/metrics.service';
import { AlertService } from '../observability/alert.service';
import { AuditService } from '../observability/audit.service';
import { SchedulerService } from './scheduler.service';
import {
  REMINDERS_QUEUE,
  REMINDERS_DLQ_QUEUE,
} from './reminders.constants';

export interface ReminderJobData {
  reminderId: string;
  invoiceId: string;
  stage: number;
}

@Processor(REMINDERS_QUEUE, {
  concurrency: 5,
  limiter: {
    max: 10,
    duration: 1000,
  },
  lockDuration: 30000,
  maxStalledCount: 2,
})
export class RemindersProcessor extends WorkerHost {
  private readonly logger = new Logger(RemindersProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly invoicesService: InvoicesService,
    private readonly mailService: MailService,
    private readonly aiService: AiService,
    private readonly schedulerService: SchedulerService,
    private readonly metricsService: MetricsService,
    private readonly alertService: AlertService,
    private readonly auditService: AuditService,
    @InjectQueue(REMINDERS_DLQ_QUEUE) private readonly dlqQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<ReminderJobData>): Promise<void> {
    const { reminderId, stage } = job.data;

    const reminder = await this.prisma.reminder.findUnique({
      where: { id: reminderId },
      include: {
        invoice: {
          include: { account: true },
        },
      },
    });

    if (!reminder) {
      this.logger.warn(`Reminder ${reminderId} not found; skipping`);
      return;
    }

    // 1. Idempotency check: only process SCHEDULED reminders
    if (reminder.status !== ReminderStatus.SCHEDULED) {
      this.logger.debug(
        `Reminder ${reminder.id} (stage ${stage}) has status=${reminder.status}; skipping`,
      );
      return;
    }

    const { invoice } = reminder;
    const { account } = invoice;

    // 2. Check suppression list (unsubscribed / bounced / complained)
    const suppressed = await this.mailService.isSuppressed(
      account.id,
      invoice.customerEmail,
    );
    if (suppressed) {
      await this.schedulerService.cancelForInvoice(
        invoice.id,
        'Customer email is on suppression list',
      );
      this.metricsService.remindersTotal.inc({
        status: 'skipped',
        stage: String(stage),
      });
      await this.auditService.log({
        reminderId: reminder.id,
        accountId: account.id,
        invoiceId: invoice.id,
        stage,
        event: 'SKIPPED_SUPPRESSED',
      });
      return;
    }

    // 3. LIVE STRIPE RE-CHECK (Section 5.2: Never trust local DB alone)
    try {
      const liveStripeInvoice = await this.stripeService.fetchLiveInvoice(
        invoice.stripeInvoiceId,
        account.stripeAccountId,
      );

      const { invoice: syncedInvoice } =
        await this.invoicesService.upsertFromStripe(
          account.id,
          liveStripeInvoice,
        );

      const liveStatus =
        syncedInvoice?.status ??
        this.invoicesService.mapStripeStatus(liveStripeInvoice.status);

      if (liveStatus !== InvoiceStatus.OPEN) {
        await this.schedulerService.cancelForInvoice(
          invoice.id,
          `Live Stripe re-check returned status ${liveStatus}`,
        );
        this.metricsService.remindersTotal.inc({
          status: 'skipped',
          stage: String(stage),
        });
        await this.auditService.log({
          reminderId: reminder.id,
          accountId: account.id,
          invoiceId: invoice.id,
          stage,
          event: 'SKIPPED_ALREADY_PAID_OR_CLOSED',
          metadata: { liveStatus },
        });
        return;
      }

      await this.auditService.log({
        reminderId: reminder.id,
        accountId: account.id,
        invoiceId: invoice.id,
        stage,
        event: 'LIVE_CHECK_PASSED',
        metadata: { stripeInvoiceId: invoice.stripeInvoiceId },
      });
    } catch (err) {
      this.metricsService.externalErrorsTotal.inc({ provider: 'stripe' });
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (invoice.status !== InvoiceStatus.OPEN) {
        await this.schedulerService.cancelForInvoice(
          invoice.id,
          `Local invoice status is ${invoice.status}`,
        );
        return;
      }
      this.logger.error(
        {
          accountId: account.id,
          invoiceId: invoice.id,
          stage,
          error: message,
        },
        `Live Stripe fetch failed for ${invoice.stripeInvoiceId}: ${message}`,
      );
      throw err;
    }

    // 4. Per-customer daily cap (max 1 reminder per customer per day across invoices)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentSentCount = await this.prisma.reminder.count({
      where: {
        status: ReminderStatus.SENT,
        sentAt: { gte: twentyFourHoursAgo },
        invoice: {
          accountId: account.id,
          customerEmail: invoice.customerEmail,
          id: { not: invoice.id },
        },
      },
    });

    if (recentSentCount > 0) {
      await this.prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: ReminderStatus.SKIPPED,
          failureReason: 'Max 1 reminder per customer per day across invoices',
        },
      });
      this.metricsService.remindersTotal.inc({
        status: 'skipped',
        stage: String(stage),
      });
      await this.auditService.log({
        reminderId: reminder.id,
        accountId: account.id,
        invoiceId: invoice.id,
        stage,
        event: 'SKIPPED_DAILY_CAP',
      });
      return;
    }

    // 5. Generate Tone-Matched Email (or reuse already-generated draft if worker is retrying after a Resend timeout)
    const unsubscribeUrl = this.mailService.generateUnsubscribeUrl(
      account.id,
      invoice.customerEmail,
    );

    const customerFirstName =
      invoice.customerName?.trim().split(/\s+/)[0] ?? '';
    const formattedAmount = formatMinorUnits(
      invoice.amountDue,
      invoice.currency,
    );
    const formattedDueDate = invoice.dueDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    const invoiceNumber = invoice.invoiceNumber ?? invoice.stripeInvoiceId;
    const payLink =
      invoice.hostedInvoiceUrl ??
      `${process.env.APP_URL ?? 'http://localhost:3000'}/invoices/${invoice.id}`;

    const rendered = await this.aiService.generateReminderEmail({
      stage,
      toneProfile: (account.toneProfile as ToneProfile | null) ?? null,
      facts: {
        customer_first_name: customerFirstName,
        invoice_number: invoiceNumber,
        amount: formattedAmount,
        due_date: formattedDueDate,
        pay_link: payLink,
        sender_name: account.senderName,
      },
      unsubscribeUrl,
    });

    if (rendered.validationErrors && rendered.validationErrors.length > 0) {
      this.metricsService.aiValidationFailuresTotal.inc({
        stage: String(stage),
        attempt: String(rendered.attempts),
      });
    }

    // Persist generated subject & body BEFORE calling Resend so audit state is durable
    await this.prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        subject: rendered.subject,
        body: rendered.text,
      },
    });

    await this.auditService.log({
      reminderId: reminder.id,
      accountId: account.id,
      invoiceId: invoice.id,
      stage,
      event: rendered.usedFallback ? 'AI_FALLBACK_TEMPLATE' : 'AI_GENERATED',
      metadata: {
        attempts: rendered.attempts,
        usedFallback: rendered.usedFallback,
      },
    });

    // 6. Approval mode check
    if (account.approvalMode) {
      await this.prisma.reminder.update({
        where: { id: reminder.id },
        data: { status: ReminderStatus.PENDING_APPROVAL },
      });
      await this.auditService.log({
        reminderId: reminder.id,
        accountId: account.id,
        invoiceId: invoice.id,
        stage,
        event: 'PENDING_APPROVAL',
      });
      return;
    }

    // 7. Crash-safe idempotent send via Resend (uses Idempotency-Key: reminder-send-${reminder.id})
    const { resendEmailId } = await this.mailService.sendReminderEmail({
      reminderId: reminder.id,
      accountId: account.id,
      senderName: account.senderName,
      senderEmail: account.senderEmail,
      toEmail: invoice.customerEmail,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      unsubscribeUrl,
    });

    await this.prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        status: ReminderStatus.SENT,
        resendEmailId,
        sentAt: new Date(),
        failureReason: null,
      },
    });

    this.metricsService.remindersTotal.inc({
      status: 'sent',
      stage: String(stage),
    });

    await this.auditService.log({
      reminderId: reminder.id,
      accountId: account.id,
      invoiceId: invoice.id,
      stage,
      event: 'SENT',
      metadata: { resendEmailId },
    });
  }

  /**
   * Dead-Letter Queue (DLQ) handler:
   * Invoked when a job attempt fails. Once all retries are exhausted, moves the job to
   * REMINDERS_DLQ_QUEUE, marks the database row FAILED, records an audit event, and fires an alert.
   */
  @OnWorkerEvent('failed')
  async onJobFailed(
    job: Job<ReminderJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 3;
    if (job.attemptsMade < maxAttempts) {
      this.logger.warn(
        {
          reminderId: job.data.reminderId,
          invoiceId: job.data.invoiceId,
          stage: job.data.stage,
          attempt: job.attemptsMade,
          maxAttempts,
        },
        `Reminder job ${job.id} failed attempt ${job.attemptsMade}/${maxAttempts}: ${error.message}`,
      );
      return;
    }

    // Retries exhausted -> Move to Dead-Letter Queue
    const { reminderId, invoiceId, stage } = job.data;

    const reminder = await this.prisma.reminder.findUnique({
      where: { id: reminderId },
      include: { invoice: true },
    });

    const accountId = reminder?.invoice.accountId ?? 'unknown';

    if (reminder && reminder.status !== ReminderStatus.SENT) {
      await this.prisma.reminder.update({
        where: { id: reminderId },
        data: {
          status: ReminderStatus.FAILED,
          failureReason: `Exhausted ${maxAttempts} attempts: ${error.message}`,
        },
      });

      await this.auditService.log({
        reminderId,
        accountId,
        invoiceId,
        stage,
        event: 'FAILED_DLQ',
        metadata: {
          attemptsMade: job.attemptsMade,
          error: error.message,
        },
      });
    }

    await this.dlqQueue.add(
      'dead-letter-reminder',
      {
        originalJobId: job.id,
        reminderId,
        invoiceId,
        accountId,
        stage,
        failedReason: error.message,
        failedAt: new Date().toISOString(),
      },
      {
        jobId: `dlq-${reminderId}`,
        removeOnComplete: false,
      },
    );

    this.metricsService.remindersTotal.inc({
      status: 'failed',
      stage: String(stage),
    });

    await this.alertService.triggerAlert({
      severity: 'CRITICAL',
      title: 'Reminder job moved to Dead-Letter Queue (DLQ)',
      accountId,
      invoiceId,
      stage,
      reason: error.message,
    });
  }
}