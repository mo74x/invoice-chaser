import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AlertPayload {
  severity: 'WARN' | 'CRITICAL';
  title: string;
  accountId?: string;
  invoiceId?: string;
  stage?: number;
  eventId?: string;
  reason: string;
}

@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  private readonly webhookUrl: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.webhookUrl = this.configService.get<string>('ALERT_WEBHOOK_URL');
  }

  async triggerAlert(payload: AlertPayload): Promise<void> {
    this.logger.error(
      {
        alert: true,
        severity: payload.severity,
        accountId: payload.accountId ?? null,
        invoiceId: payload.invoiceId ?? null,
        stage: payload.stage ?? null,
        eventId: payload.eventId ?? null,
        reason: payload.reason,
      },
      `[ALERT:${payload.severity}] ${payload.title}: ${payload.reason}`,
    );

    if (this.webhookUrl) {
      try {
        await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `*[${payload.severity}] ${payload.title}*\nReason: ${payload.reason}\nContext: accountId=${payload.accountId ?? 'n/a'} invoiceId=${payload.invoiceId ?? 'n/a'} stage=${payload.stage ?? 'n/a'}`,
          }),
        });
      } catch (err) {
        this.logger.warn(
          `Failed to dispatch external alert webhook: ${
            err instanceof Error ? err.message : 'Unknown error'
          }`,
        );
      }
    }
  }
}