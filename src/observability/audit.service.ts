import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordAuditParams {
  reminderId: string;
  accountId: string;
  invoiceId: string;
  stage: number;
  event: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(params: RecordAuditParams): Promise<void> {
    this.logger.log(
      {
        accountId: params.accountId,
        invoiceId: params.invoiceId,
        reminderId: params.reminderId,
        stage: params.stage,
        auditEvent: params.event,
        ...params.metadata,
      },
      `Reminder audit: ${params.event} (invoice=${params.invoiceId}, stage=${params.stage})`,
    );

    await this.prisma.reminderAudit.create({
      data: {
        reminderId: params.reminderId,
        accountId: params.accountId,
        invoiceId: params.invoiceId,
        stage: params.stage,
        event: params.event,
        metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async getAuditTrailForInvoice(accountId: string, invoiceId: string) {
    return this.prisma.reminderAudit.findMany({
      where: { accountId, invoiceId },
      orderBy: { createdAt: 'asc' },
    });
  }
}