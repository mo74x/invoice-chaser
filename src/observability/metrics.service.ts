import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  Registry,
  Histogram,
  Counter,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';
import { STRIPE_EVENTS_QUEUE } from '../stripe/stripe.constants';
import {
  REMINDERS_QUEUE,
  REMINDERS_DLQ_QUEUE,
} from '../reminders/reminders.constants';

@Injectable()
export class MetricsService {
  private readonly registry: Registry;

  readonly webhookLatency: Histogram<string>;
  readonly remindersTotal: Counter<string>;
  readonly aiValidationFailuresTotal: Counter<string>;
  readonly externalErrorsTotal: Counter<string>;
  readonly queueDepthGauge: Gauge<string>;
  readonly dlqDepthGauge: Gauge<string>;

  constructor(
    @InjectQueue(STRIPE_EVENTS_QUEUE)
    private readonly stripeEventsQueue: Queue,
    @InjectQueue(REMINDERS_QUEUE)
    private readonly remindersQueue: Queue,
    @InjectQueue(REMINDERS_DLQ_QUEUE)
    private readonly dlqQueue: Queue,
  ) {
    this.registry = new Registry();
    collectDefaultMetrics({
      register: this.registry,
      prefix: 'invoice_chaser_',
    });

    this.webhookLatency = new Histogram({
      name: 'invoice_chaser_webhook_latency_seconds',
      help: 'Webhook acknowledgement latency in seconds',
      labelNames: ['source', 'event_type', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1],
      registers: [this.registry],
    });

    this.remindersTotal = new Counter({
      name: 'invoice_chaser_reminders_total',
      help: 'Total reminders processed by terminal/transition status and stage',
      labelNames: ['status', 'stage'],
      registers: [this.registry],
    });

    this.aiValidationFailuresTotal = new Counter({
      name: 'invoice_chaser_ai_validation_failures_total',
      help: 'Total AI reminder output validation failures',
      labelNames: ['stage', 'attempt'],
      registers: [this.registry],
    });

    this.externalErrorsTotal = new Counter({
      name: 'invoice_chaser_external_errors_total',
      help: 'Total errors from external providers (stripe, resend, claude)',
      labelNames: ['provider'],
      registers: [this.registry],
    });

    this.queueDepthGauge = new Gauge({
      name: 'invoice_chaser_queue_depth',
      help: 'Current number of jobs in BullMQ queues by state',
      labelNames: ['queue', 'state'],
      registers: [this.registry],
    });

    this.dlqDepthGauge = new Gauge({
      name: 'invoice_chaser_dlq_depth',
      help: 'Current number of jobs sitting in the Dead-Letter Queue',
      registers: [this.registry],
    });
  }

  async getMetricsSnapshot(): Promise<string> {
    await this.refreshQueueGauges();
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }

  private async refreshQueueGauges(): Promise<void> {
    const queues: Array<{ name: string; q: Queue }> = [
      { name: STRIPE_EVENTS_QUEUE, q: this.stripeEventsQueue },
      { name: REMINDERS_QUEUE, q: this.remindersQueue },
    ];

    for (const { name, q } of queues) {
      const counts = await q.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
      );
      this.queueDepthGauge.set({ queue: name, state: 'waiting' }, counts.waiting ?? 0);
      this.queueDepthGauge.set({ queue: name, state: 'active' }, counts.active ?? 0);
      this.queueDepthGauge.set({ queue: name, state: 'delayed' }, counts.delayed ?? 0);
      this.queueDepthGauge.set({ queue: name, state: 'failed' }, counts.failed ?? 0);
    }

    const dlqCounts = await this.dlqQueue.getJobCounts('waiting', 'delayed', 'failed');
    const totalDlq =
      (dlqCounts.waiting ?? 0) +
      (dlqCounts.delayed ?? 0) +
      (dlqCounts.failed ?? 0);
    this.dlqDepthGauge.set(totalDlq);
  }
}