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

  async approveAndSend(reminderId: string) {
    const reminder = await this.prisma.reminder.findUnique({
      where: { id: reminderId },
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

  async skipReminder(reminderId: string) {
    const reminder = await this.prisma.reminder.findUnique({
      where: { id: reminderId },
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
}