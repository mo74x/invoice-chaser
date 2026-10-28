import { Module , forwardRef} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { StripeController } from './stripe.controller';
import { StripeService } from './stripe.service';
import { StripeWebhookProcessor } from './stripe-webhook.processor';
import { InvoicesModule } from '../invoices/invoices.module';
import { STRIPE_EVENTS_QUEUE } from './stripe.constants';
import { RemindersModule } from '../reminders/reminders.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: STRIPE_EVENTS_QUEUE,
    }),
    InvoicesModule,
    forwardRef(() => RemindersModule),
  ],
  controllers: [StripeController],
  providers: [StripeService, StripeWebhookProcessor],
  exports: [StripeService],
})
export class StripeModule {}