import * as common from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Request } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from './stripe.service';
import {
  STRIPE_EVENTS_QUEUE,
  SUPPORTED_STRIPE_EVENTS,
} from './stripe.constants';

@common.Controller()
export class StripeController {
  private readonly logger = new common.Logger(StripeController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly prisma: PrismaService,
    @InjectQueue(STRIPE_EVENTS_QUEUE)
    private readonly stripeEventsQueue: Queue,
  ) {}

  @common.Get('connect/stripe')
  startOAuth(@common.Query('accountId') accountId: string) {
    if (!accountId) {
      throw new common.BadRequestException('accountId query parameter is required');
    }
    const url = this.stripeService.generateOAuthUrl(accountId);
    return { url };
  }

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

  @common.Post('webhooks/stripe')
  @common.HttpCode(common.HttpStatus.OK)
  async handleStripeWebhook(
    @common.Req() req: common.RawBodyRequest<Request>,
    @common.Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    if (!signature) {
      throw new common.BadRequestException('Missing stripe-signature header');
    }
    if (!req.rawBody) {
      throw new common.BadRequestException('Missing raw request body');
    }

    // 1. Cryptographically verify signature using raw Buffer
    const event = this.stripeService.constructWebhookEvent(
      req.rawBody,
      signature,
    );

    if (!SUPPORTED_STRIPE_EVENTS.has(event.type)) {
      return { received: true };
    }

    // 2. Idempotent insert into webhook_events
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
      // P2002 = Unique constraint violation on externalId (already received)
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.debug(`Duplicate Stripe webhook ${event.id} ignored`);
        return { received: true, duplicate: true };
      }
      throw err;
    }

    // 3. Enqueue background processing with deterministic jobId
    await this.stripeEventsQueue.add(
      event.type,
      { eventId: event.id },
      {
        jobId: `stripe-event:${event.id}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
      },
    );

    return { received: true };
  }
}