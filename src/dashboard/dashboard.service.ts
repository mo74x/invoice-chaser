import { Injectable, NotFoundException } from '@nestjs/common';
import { DeliveryStatus, InvoiceStatus, ReminderStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { formatMinorUnits } from '../mail/mail.templates';

export interface CurrencyBreakdown {
  currency: string;
  count: number;
  amountMinor: number;
  formatted: string;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, email: true, senderName: true, timezone: true },
    });

    if (!account) {
      throw new NotFoundException(`Account ${accountId} not found`);
    }

    const now = new Date();

    const [
      overdueInvoices,
      recoveredInvoices,
      remindersByStatus,
      remindersByStage,
      remindersByDelivery,
      suppressionsCount,
    ] = await Promise.all([
      // 1. Overdue OPEN invoices (dueDate is in the past)
      this.prisma.invoice.groupBy({
        by: ['currency'],
        where: {
          accountId,
          status: InvoiceStatus.OPEN,
          dueDate: { lt: now },
        },
        _count: { id: true },
        _sum: { amountDue: true },
      }),

      // 2. Recovered PAID invoices (paid after at least one SENT reminder)
      this.prisma.invoice.groupBy({
        by: ['currency'],
        where: {
          accountId,
          status: InvoiceStatus.PAID,
          reminders: {
            some: {
              status: ReminderStatus.SENT,
            },
          },
        },
        _count: { id: true },
        _sum: { amountDue: true },
      }),

      // 3. Reminder counts grouped by status
      this.prisma.reminder.groupBy({
        by: ['status'],
        where: { invoice: { accountId } },
        _count: { id: true },
      }),

      // 4. Sent reminders grouped by stage (3, 7, 14)
      this.prisma.reminder.groupBy({
        by: ['stage'],
        where: {
          status: ReminderStatus.SENT,
          invoice: { accountId },
        },
        _count: { id: true },
      }),

      // 5. Sent reminders grouped by delivery webhook status
      this.prisma.reminder.groupBy({
        by: ['deliveryStatus'],
        where: {
          status: ReminderStatus.SENT,
          invoice: { accountId },
        },
        _count: { id: true },
      }),

      // 6. Total suppressed addresses
      this.prisma.suppression.count({
        where: { accountId },
      }),
    ]);

    const formatGroup = (
      groups: Array<{
        currency: string;
        _count: { id: number };
        _sum: { amountDue: number | null };
      }>,
    ): {
      totalCount: number;
      totalAmountMinor: number;
      byCurrency: CurrencyBreakdown[];
    } => {
      const byCurrency = groups.map((g) => {
        const amountMinor = g._sum.amountDue ?? 0;
        return {
          currency: g.currency.toUpperCase(),
          count: g._count.id,
          amountMinor,
          formatted: formatMinorUnits(amountMinor, g.currency),
        };
      });

      const totalCount = byCurrency.reduce((acc, item) => acc + item.count, 0);
      const totalAmountMinor = byCurrency.reduce(
        (acc, item) => acc + item.amountMinor,
        0,
      );

      return { totalCount, totalAmountMinor, byCurrency };
    };

    const statusCounts: Record<ReminderStatus, number> = {
      [ReminderStatus.SCHEDULED]: 0,
      [ReminderStatus.PENDING_APPROVAL]: 0,
      [ReminderStatus.SENT]: 0,
      [ReminderStatus.SKIPPED]: 0,
      [ReminderStatus.FAILED]: 0,
    };
    for (const row of remindersByStatus) {
      statusCounts[row.status] = row._count.id;
    }

    const stageSentCounts: Record<number, number> = { 3: 0, 7: 0, 14: 0 };
    for (const row of remindersByStage) {
      stageSentCounts[row.stage] = row._count.id;
    }

    const deliveryCounts: Record<DeliveryStatus, number> = {
      [DeliveryStatus.NONE]: 0,
      [DeliveryStatus.DELIVERED]: 0,
      [DeliveryStatus.BOUNCED]: 0,
      [DeliveryStatus.COMPLAINED]: 0,
    };
    for (const row of remindersByDelivery) {
      deliveryCounts[row.deliveryStatus] = row._count.id;
    }

    return {
      accountId,
      generatedAt: now.toISOString(),
      overdue: formatGroup(overdueInvoices),
      recovered: formatGroup(recoveredInvoices),
      reminders: {
        byStatus: statusCounts,
        sentByStage: stageSentCounts,
        delivery: deliveryCounts,
      },
      suppressionsCount,
    };
  }
}