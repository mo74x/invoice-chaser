import { Injectable, Logger } from '@nestjs/common';
import { Invoice, InvoiceStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import Stripe from 'stripe';

const TERMINAL_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.PAID,
  InvoiceStatus.VOID,
  InvoiceStatus.UNCOLLECTIBLE,
];

export interface UpsertInvoiceResult {
  invoice: Invoice | null;
  transitionedToOpen: boolean;
  transitionedToTerminal: boolean;
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(private readonly prisma: PrismaService) {}

  mapStripeStatus(
    stripeStatus: Stripe.Invoice.Status | null,
  ): InvoiceStatus | null {
    switch (stripeStatus) {
      case 'open':
        return InvoiceStatus.OPEN;
      case 'paid':
        return InvoiceStatus.PAID;
      case 'void':
        return InvoiceStatus.VOID;
      case 'uncollectible':
        return InvoiceStatus.UNCOLLECTIBLE;
      default:
        // 'draft' or null invoices are ignored until finalized
        return null;
    }
  }

  /**
   * Upserts an invoice from a Stripe payload while guaranteeing out-of-order safety.
   * Terminal statuses (PAID, VOID, UNCOLLECTIBLE) are never overwritten by OPEN.
   */
  async upsertFromStripe(
    accountId: string,
    stripeInvoice: Stripe.Invoice,
  ): Promise<UpsertInvoiceResult> {
    const incomingStatus = this.mapStripeStatus(stripeInvoice.status);
    if (!incomingStatus) {
      this.logger.debug(
        `Skipping non-finalized invoice ${stripeInvoice.id} (status=${stripeInvoice.status})`,
      );
      return {
        invoice: null,
        transitionedToOpen: false,
        transitionedToTerminal: false,
      };
    }

    const customerEmail = stripeInvoice.customer_email;
    if (!customerEmail) {
      this.logger.warn(
        `Invoice ${stripeInvoice.id} has no customer_email; skipping sync`,
      );
      return {
        invoice: null,
        transitionedToOpen: false,
        transitionedToTerminal: false,
      };
    }

    // Due date falls back to invoice creation timestamp if no explicit due_date is set on Stripe
    const dueTimestamp = stripeInvoice.due_date ?? stripeInvoice.created;
    const dueDate = new Date(dueTimestamp * 1000);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.invoice.findUnique({
        where: { stripeInvoiceId: stripeInvoice.id },
      });

      // Out-of-order guard: never downgrade a terminal invoice back to OPEN
      if (
        existing &&
        TERMINAL_STATUSES.includes(existing.status) &&
        incomingStatus === InvoiceStatus.OPEN
      ) {
        this.logger.warn(
          `Out-of-order event ignored: Invoice ${stripeInvoice.id} is already ${existing.status}, ignoring incoming OPEN state`,
        );
        return {
          invoice: existing,
          transitionedToOpen: false,
          transitionedToTerminal: false,
        };
      }

      const effectiveStatus =
        existing && TERMINAL_STATUSES.includes(existing.status)
          ? existing.status
          : incomingStatus;

      const invoice = await tx.invoice.upsert({
        where: { stripeInvoiceId: stripeInvoice.id },
        create: {
          accountId,
          stripeInvoiceId: stripeInvoice.id,
          invoiceNumber: stripeInvoice.number ?? null,
          customerEmail: customerEmail.toLowerCase().trim(),
          customerName: stripeInvoice.customer_name ?? null,
          amountDue: stripeInvoice.amount_due,
          currency: stripeInvoice.currency.toLowerCase(),
          dueDate,
          status: effectiveStatus,
          hostedInvoiceUrl: stripeInvoice.hosted_invoice_url ?? null,
        },
        update: {
          invoiceNumber: stripeInvoice.number ?? undefined,
          customerEmail: customerEmail.toLowerCase().trim(),
          customerName: stripeInvoice.customer_name ?? undefined,
          amountDue: stripeInvoice.amount_due,
          currency: stripeInvoice.currency.toLowerCase(),
          dueDate,
          status: effectiveStatus,
          hostedInvoiceUrl: stripeInvoice.hosted_invoice_url ?? undefined,
        },
      });

      const transitionedToOpen =
        !existing && effectiveStatus === InvoiceStatus.OPEN;

      const transitionedToTerminal =
        TERMINAL_STATUSES.includes(effectiveStatus) &&
        (!existing || !TERMINAL_STATUSES.includes(existing.status));

      return { invoice, transitionedToOpen, transitionedToTerminal };
    });
  }

  /**
   * Lists invoices with their reminder statuses for a given account (GET /invoices).
   */
  async listInvoices(accountId: string, status?: InvoiceStatus) {
    return this.prisma.invoice.findMany({
      where: {
        accountId,
        ...(status ? { status } : {}),
      },
      include: {
        reminders: {
          orderBy: { stage: 'asc' },
        },
      },
      orderBy: { dueDate: 'desc' },
    });
  }
}