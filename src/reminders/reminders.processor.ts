import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InvoiceStatus, ReminderStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { InvoicesService } from '../invoices/invoices.service';
import { MailService } from '../mail/mail.service';
import {
  formatMinorUnits,
  renderFallbackTemplate,
} from '../mail/mail.templates';
import { SchedulerService } from './scheduler.service';
import { REMINDERS_QUEUE } from './reminders.constants';

export interface ReminderJobData {
  reminderId: string;
  invoiceId: string;
  stage: number;
}

@Processor(REMINDERS_QUEUE)
export class RemindersProcessor extends WorkerHost {
  private readonly logger = new Logger(RemindersProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly invoicesService: InvoicesService,
    private readonly mailService: MailService,
    private readonly schedulerService: SchedulerService,
  ) {
    super();
  }

  async process(job: Job<ReminderJobData>): Promise<void> {
    const { reminderId, invoiceId, stage } = job.data;

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
        this.logger.log(
          `Race condition prevented: Live Stripe status for ${invoice.stripeInvoiceId} is ${liveStatus}. Cancelling reminders.`,
        );
        await this.schedulerService.cancelForInvoice(
          invoice.id,
          `Live Stripe re-check returned status ${liveStatus}`,
        );
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      // If local DB already knows it's not OPEN, cancel immediately
      if (invoice.status !== InvoiceStatus.OPEN) {
        await this.schedulerService.cancelForInvoice(
          invoice.id,
          `Local invoice status is ${invoice.status}`,
        );
        return;
      }
      this.logger.error(
        `Live Stripe fetch failed for ${invoice.stripeInvoiceId}: ${message}`,
      );
      throw err; // Trigger BullMQ retry with backoff
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
          id: { not: invoice.id }, // Allow distinct stages of same invoice during fast local testing
        },
      },
    });

    if (recentSentCount > 0) {
      this.logger.log(
        `Daily customer cap reached for ${invoice.customerEmail}; skipping stage ${stage} for invoice ${invoice.stripeInvoiceId}`,
      );
      await this.prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: ReminderStatus.SKIPPED,
          failureReason: 'Max 1 reminder per customer per day across invoices',
        },
      });
      return;
    }

    // 5. Build templated email (Phase 3 will plug Claude Tone Engine in here with fallback)
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
    const unsubscribeUrl = this.mailService.generateUnsubscribeUrl(
      account.id,
      invoice.customerEmail,
    );

    const rendered = renderFallbackTemplate(stage, {
      customerFirstName,
      invoiceNumber,
      formattedAmount,
      formattedDueDate,
      payLink,
      senderName: account.senderName,
      unsubscribeUrl,
    });

    // 6. If account is in Approval Mode, store draft and pause at PENDING_APPROVAL
    if (account.approvalMode) {
      await this.prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: ReminderStatus.PENDING_APPROVAL,
          subject: rendered.subject,
          body: rendered.text,
        },
      });
      this.logger.log(
        `Reminder ${reminder.id} (stage ${stage}) moved to PENDING_APPROVAL`,
      );
      return;
    }

    // 7. Send via Resend and record result
    const { resendEmailId } = await this.mailService.sendReminderEmail({
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
        subject: rendered.subject,
        body: rendered.text,
        sentAt: new Date(),
      },
    });

    this.logger.log(
      `Sent stage ${stage} reminder for invoice ${invoice.stripeInvoiceId} to ${invoice.customerEmail} (resendEmailId=${resendEmailId})`,
    );
  }
}