import * as common from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Request } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../observability/metrics.service';
import { StripeService } from './stripe.service';
import {
  STRIPE_EVENTS_QUEUE,
  SUPPORTED_STRIPE_EVENTS,
} from './stripe.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';

@common.Controller()
export class StripeController {
  private readonly logger = new common.Logger(StripeController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
    @InjectQueue(STRIPE_EVENTS_QUEUE)
    private readonly stripeEventsQueue: Queue,
  ) {}

  @common.Get('connect/stripe')
  startOAuth(@CurrentUser() user: AuthenticatedUser) {
    const url = this.stripeService.generateOAuthUrl(user.accountId);
    return { url };
  }

  @Public()
  @common.Get('connect/stripe/callback')
  async finishOAuth(
    @common.Query('code') code: string,
    @common.Query('state') state: string,
  ) {
    if (!code || !state) {
      throw new common.BadRequestException('Missing code or state');
    }
    return this.stripeService.handleOAuthCallback(code, state);
  }

  @Public()
  @common.Post('webhooks/stripe')
  @common.HttpCode(common.HttpStatus.OK)
  async handleStripeWebhook(
    @common.Req() req: common.RawBodyRequest<Request>,
    @common.Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    const stopTimer = this.metricsService.webhookLatency.startTimer({
      source: 'stripe',
    });

    if (!signature || !req.rawBody) {
      stopTimer({ event_type: 'unknown', status: '400' });
      throw new common.BadRequestException('Missing stripe-signature or raw body');
    }

    const event = this.stripeService.constructWebhookEvent(
      req.rawBody,
      signature,
    );

    if (!SUPPORTED_STRIPE_EVENTS.has(event.type)) {
      stopTimer({ event_type: event.type, status: '200' });
      return { received: true };
    }

    try {
      await this.prisma.webhookEvent.create({
        data: {
          source: 'stripe',
          externalId: event.id,
          type: event.type,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        stopTimer({ event_type: event.type, status: '200_duplicate' });
        this.logger.debug(`Duplicate Stripe webhook ${event.id} ignored`);
        return { received: true, duplicate: true };
      }
      stopTimer({ event_type: event.type, status: '500' });
      throw err;
    }

    await this.stripeEventsQueue.add(
      event.type,
      { eventId: event.id },
      {
        jobId: `stripe-event-${event.id}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
      },
    );

    stopTimer({ event_type: event.type, status: '200' });
    return { received: true };
  }
}
