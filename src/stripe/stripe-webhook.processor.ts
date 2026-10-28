import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicesService } from '../invoices/invoices.service';
import { SchedulerService } from '../reminders/scheduler.service';
import { STRIPE_EVENTS_QUEUE } from './stripe.constants';
import { InvoiceStatus } from '../../generated/prisma/enums';

interface StripeEventJobData {
  eventId: string;
}

@Processor(STRIPE_EVENTS_QUEUE)
export class StripeWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(StripeWebhookProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoicesService: InvoicesService,
    private readonly schedulerService: SchedulerService,
  ) {
    super();
  }

  async process(job: Job<StripeEventJobData>): Promise<void> {
    const { eventId } = job.data;

    const record = await this.prisma.webhookEvent.findUnique({
      where: { externalId: eventId },
    });

    if (!record || record.processedAt) {
      this.logger.debug(
        `Event ${eventId} missing or already processed; skipping`,
      );
      return;
    }

    const event = record.payload as unknown as Stripe.Event;

    if (event.type === 'account.application.deauthorized') {
      await this.handleDeauthorized(event);
      await this.markProcessed(eventId);
      return;
    }

    const stripeAccountId = event.account;
    const account = stripeAccountId
      ? await this.prisma.account.findUnique({ where: { stripeAccountId } })
      : await this.prisma.account.findFirst();

    if (!account) {
      this.logger.warn(
        `No matching Account found for Stripe event ${event.id} (stripeAccount=${stripeAccountId ?? 'direct'})`,
      );
      await this.markProcessed(eventId);
      return;
    }

    const stripeInvoice = event.data.object as Stripe.Invoice;
    const { invoice, transitionedToOpen, transitionedToTerminal } =
      await this.invoicesService.upsertFromStripe(account.id, stripeInvoice);

    if (invoice) {
      this.logger.log(
        `Synced invoice ${invoice.stripeInvoiceId} status=${invoice.status} (openTransition=${transitionedToOpen}, terminalTransition=${transitionedToTerminal})`,
      );

      if (invoice.status === InvoiceStatus.OPEN) {
        await this.schedulerService.scheduleForInvoice(
          invoice,
          account.timezone,
        );
      } else {
        await this.schedulerService.cancelForInvoice(
          invoice.id,
          `Stripe event ${event.type}: invoice status is ${invoice.status}`,
        );
      }
    }

    await this.markProcessed(eventId);
  }

  private async handleDeauthorized(event: Stripe.Event): Promise<void> {
    const stripeAccountId = event.account;
    if (!stripeAccountId) return;

    await this.prisma.account.updateMany({
      where: { stripeAccountId },
      data: {
        stripeAccountId: null,
        stripeTokenEnc: null,
      },
    });
    this.logger.warn(
      `Deauthorized and cleared tokens for Stripe account ${stripeAccountId}`,
    );
  }

  private async markProcessed(externalId: string): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { externalId },
      data: { processedAt: new Date() },
    });
  }
}