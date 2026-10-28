import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { StripeController } from './stripe.controller';
import { StripeService } from './stripe.service';
import { StripeWebhookProcessor } from './stripe-webhook.processor';
import { InvoicesModule } from '../invoices/invoices.module';
import { STRIPE_EVENTS_QUEUE } from './stripe.constants';

@Module({
  imports: [
    BullModule.registerQueue({
      name: STRIPE_EVENTS_QUEUE,
    }),
    InvoicesModule,
  ],
  controllers: [StripeController],
  providers: [StripeService, StripeWebhookProcessor],
  exports: [StripeService],
})
export class StripeModule {}