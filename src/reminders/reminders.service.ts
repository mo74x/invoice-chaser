import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InvoiceStatus, ReminderStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { InvoicesService } from '../invoices/invoices.service';
import { MailService } from '../mail/mail.service';
import { SchedulerService } from './scheduler.service';

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly invoicesService: InvoicesService,
    private readonly mailService: MailService,
    private readonly schedulerService: SchedulerService,
  ) { }

  async listPending(accountId: string) {
    return this.prisma.reminder.findMany({
      where: {
        status: ReminderStatus.PENDING_APPROVAL,
        invoice: { accountId },
      },
      include: {
        invoice: true,
      },
      orderBy: { scheduledFor: 'asc' },
    });
  }

  async editDraft(
    reminderId: string,
    accountId: string,
    updates: { subject?: string; body: string },
  ) {
    const reminder = await this.prisma.reminder.findFirst({
      where: { id: reminderId, invoice: { accountId } },
    });

    if (!reminder) {
      throw new NotFoundException(`Reminder ${reminderId} not found`);
    }

    if (reminder.status !== ReminderStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Only reminders in PENDING_APPROVAL status can be edited');
    }

    return this.prisma.reminder.update({
      where: { id: reminderId },
      data: {
        ...(updates.subject !== undefined ? { subject: updates.subject } : {}),
        body: updates.body,
      },
    });
  }

  async rejectReminder(
    reminderId: string,
    accountId: string,
    reason = 'Rejected by founder',
  ) {
    const reminder = await this.prisma.reminder.findFirst({
      where: { id: reminderId, invoice: { accountId } },
    });

    if (!reminder) {
      throw new NotFoundException(`Reminder ${reminderId} not found`);
    }

    if (reminder.status !== ReminderStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Only reminders in PENDING_APPROVAL status can be rejected');
    }

    return this.prisma.reminder.update({
      where: { id: reminderId },
      data: {
        status: ReminderStatus.SKIPPED,
        failureReason: reason,
      },
    });
  }

  async approveAndSend(reminderId: string, accountId?: string) {
    const reminder = await this.prisma.reminder.findFirst({
      where: {
        id: reminderId,
        ...(accountId ? { invoice: { accountId } } : {}),
      },
      include: {
        invoice: {
          include: { account: true },
        },
      },
    });

    if (!reminder) {
      throw new NotFoundException(`Reminder ${reminderId} not found`);
    }

    if (reminder.status !== ReminderStatus.PENDING_APPROVAL) {
      throw new BadRequestException(
        `Reminder ${reminderId} is in status ${reminder.status}, expected PENDING_APPROVAL`,
      );
    }

    const { invoice } = reminder;
    const { account } = invoice;

    // Re-check live Stripe status before sending approved reminder
    const liveStripeInvoice = await this.stripeService.fetchLiveInvoice(
      invoice.stripeInvoiceId,
      account.stripeAccountId,
    );
    const { invoice: syncedInvoice } =
      await this.invoicesService.upsertFromStripe(
        account.id,
        liveStripeInvoice,
      );

    if (syncedInvoice?.status !== InvoiceStatus.OPEN) {
      await this.schedulerService.cancelForInvoice(
        invoice.id,
        `Invoice is ${syncedInvoice?.status ?? liveStripeInvoice.status} at approval time`,
      );
      return {
        sent: false,
        reason: `Invoice is already ${syncedInvoice?.status ?? liveStripeInvoice.status}`,
      };
    }

    const unsubscribeUrl = this.mailService.generateUnsubscribeUrl(
      account.id,
      invoice.customerEmail,
    );
    const subject =
      reminder.subject ?? `Follow-up on invoice ${invoice.stripeInvoiceId}`;
    const bodyText = reminder.body ?? '';

    const { resendEmailId } = await this.mailService.sendReminderEmail({
      reminderId: reminder.id,
      accountId: account.id,
      senderName: account.senderName,
      senderEmail: account.senderEmail,
      toEmail: invoice.customerEmail,
      subject,
      text: bodyText,
      html: `<div style="font-family: sans-serif; white-space: pre-line;">${bodyText}</div>`,
      unsubscribeUrl,
    });

    const updated = await this.prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        status: ReminderStatus.SENT,
        resendEmailId,
        sentAt: new Date(),
      },
    });

    this.logger.log(`Approved and sent reminder ${reminder.id}`);
    return { sent: true, reminder: updated };
  }

  async skipReminder(reminderId: string, accountId?: string) {
    const reminder = await this.prisma.reminder.findFirst({
      where: {
        id: reminderId,
        ...(accountId ? { invoice: { accountId } } : {}),
      },
    });

    if (!reminder) {
      throw new NotFoundException(`Reminder ${reminderId} not found`);
    }

    if (reminder.status === ReminderStatus.SENT) {
      throw new BadRequestException('Cannot skip an already sent reminder');
    }

    return this.prisma.reminder.update({
      where: { id: reminderId },
      data: {
        status: ReminderStatus.SKIPPED,
        failureReason: 'Manually skipped by founder',
      },
    });
  }

  async pauseInvoice(invoiceId: string, accountId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, accountId },
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice ${invoiceId} not found`);
    }

    await this.schedulerService.cancelForInvoice(invoiceId, 'Paused by founder');
    return { paused: true, invoiceId };
  }

  async pauseCustomer(customerEmail: string, accountId: string) {
    await this.mailService.suppressAddressAndCancelReminders(
      accountId,
      customerEmail,
      'unsubscribed',
    );
    return { paused: true, customerEmail };
  }
}
