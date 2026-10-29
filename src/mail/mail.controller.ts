import * as common from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { MailService } from './mail.service';
import { MetricsService } from '../observability/metrics.service';
import { Public } from '../auth/public.decorator';

@common.Controller()
export class MailController {
  constructor(
    private readonly mailService: MailService,
    private readonly metricsService: MetricsService,
  ) {}

  @Public()
  @common.Post('webhooks/resend')
  @common.HttpCode(common.HttpStatus.OK)
  async handleResendWebhook(
    @common.Req() req: common.RawBodyRequest<Request>,
    @common.Headers('svix-id') svixId: string,
    @common.Headers('svix-timestamp') svixTimestamp: string,
    @common.Headers('svix-signature') svixSignature: string,
  ) {
    const stopTimer = this.metricsService.webhookLatency.startTimer({
      source: 'resend',
    });

    if (!req.rawBody) {
      stopTimer({ event_type: 'unknown', status: '400' });
      throw new common.BadRequestException('Missing raw request body');
    }

    const payload = this.mailService.verifyResendWebhookSignature(
      req.rawBody,
      svixId,
      svixTimestamp,
      svixSignature,
    );

    const result = await this.mailService.processResendWebhook(svixId, payload);
    stopTimer({ event_type: payload.type, status: '200' });

    return result;
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @common.Get('unsubscribe/:token')
  @common.Header('Content-Type', 'text/html; charset=utf-8')
  async unsubscribePage(@common.Param('token') token: string): Promise<string> {
    const { email } = await this.mailService.handleUnsubscribe(token);
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Unsubscribed</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 80vh; margin: 0; color: #111827; }
    .card { max-width: 420px; padding: 32px; border: 1px solid #e5e7eb; border-radius: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin-top: 0;">You've been unsubscribed</h2>
    <p style="color: #4b5563; line-height: 1.5;">
      <strong>${email}</strong> will no longer receive automated invoice reminders from this sender.
    </p>
  </div>
</body>
</html>`.trim();
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @common.Post('unsubscribe/:token')
  @common.HttpCode(common.HttpStatus.OK)
  async unsubscribeOneClick(@common.Param('token') token: string) {
    const { email } = await this.mailService.handleUnsubscribe(token);
    return { unsubscribed: true, email };
  }
}
