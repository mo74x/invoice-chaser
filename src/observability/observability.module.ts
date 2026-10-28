import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MetricsService } from './metrics.service';
import { AlertService } from './alert.service';
import { AuditService } from './audit.service';
import { ObservabilityController } from './observability.controller';
import { STRIPE_EVENTS_QUEUE } from '../stripe/stripe.constants';
import {
  REMINDERS_QUEUE,
  REMINDERS_DLQ_QUEUE,
} from '../reminders/reminders.constants';

@Global()
@Module({
  imports: [
    BullModule.registerQueue(
      { name: STRIPE_EVENTS_QUEUE },
      { name: REMINDERS_QUEUE },
      { name: REMINDERS_DLQ_QUEUE },
    ),
  ],
  controllers: [ObservabilityController],
  providers: [MetricsService, AlertService, AuditService],
  exports: [MetricsService, AlertService, AuditService],
})
export class ObservabilityModule {}