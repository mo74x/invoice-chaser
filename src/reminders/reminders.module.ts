import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';
import { SchedulerService } from './scheduler.service';
import { RemindersProcessor } from './reminders.processor';
import { REMINDERS_QUEUE , REMINDERS_DLQ_QUEUE} from './reminders.constants';
import { StripeModule } from '../stripe/stripe.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { MailModule } from '../mail/mail.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [
    BullModule.registerQueue(
      {name: REMINDERS_QUEUE},
      { name: REMINDERS_DLQ_QUEUE},
    ),
    forwardRef(() => StripeModule),
    InvoicesModule,
    MailModule,
    AiModule
  ],
  controllers: [RemindersController],
  providers: [RemindersService, SchedulerService, RemindersProcessor],
  exports: [SchedulerService, RemindersService],
})
export class RemindersModule {}