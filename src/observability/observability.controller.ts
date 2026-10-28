import {
  Controller,
  Get,
  Query,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';
import { AuditService } from './audit.service';
import { REMINDERS_DLQ_QUEUE } from '../reminders/reminders.constants';

@Controller()
export class ObservabilityController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly auditService: AuditService,
    @InjectQueue(REMINDERS_DLQ_QUEUE) private readonly dlqQueue: Queue,
  ) {}

  @Get('metrics')
  async getMetrics(@Res() res: Response): Promise<void> {
    const metrics = await this.metricsService.getMetricsSnapshot();
    res.setHeader('Content-Type', this.metricsService.getContentType());
    res.send(metrics);
  }

  @Get('observability/dlq')
  async listDlqJobs() {
    const jobs = await this.dlqQueue.getJobs(['waiting', 'delayed', 'failed'], 0, 50);
    return jobs.map((j) => ({
      id: j.id,
      name: j.name,
      data: j.data,
      timestamp: j.timestamp,
    }));
  }

  @Get('observability/audits')
  async getInvoiceAudits(
    @Query('accountId') accountId: string,
    @Query('invoiceId') invoiceId: string,
  ) {
    if (!accountId || !invoiceId) {
      throw new BadRequestException(
        'accountId and invoiceId query parameters are required',
      );
    }
    return this.auditService.getAuditTrailForInvoice(accountId, invoiceId);
  }
}