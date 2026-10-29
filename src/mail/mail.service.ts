import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryStatus, Prisma, ReminderStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../observability/metrics.service';
import { AuditService } from '../observability/audit.service';
import { createHmac, timingSafeEqual } from 'crypto';
import { Resend } from 'resend';

export interface SendReminderEmailParams {
  reminderId: string;
  accountId: string;
  senderName: string;
  senderEmail: string;
  toEmail: string;
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
}

export interface ResendWebhookPayload {
  type: 'email.sent' | 'email.delivered' | 'email.bounced' | 'email.complained';
  created_at: string;
  data: {
    email_id: string;
    to: string[];
    from: string;
    subject?: string;
  };
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly isMockMode: boolean;
  private readonly fromDomain: string;
  private readonly appUrl: string;
  private readonly secretKey: string;
  private readonly resendWebhookSecret: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
    private readonly auditService: AuditService,
  ) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY', 're_mock');
    this.isMockMode = !apiKey || apiKey === 're_mock';
    this.resend = this.isMockMode ? null : new Resend(apiKey);
    this.fromDomain = this.configService.get<string>(
      'RESEND_FROM_DOMAIN',
      'onboarding@resend.dev',
    );
    this.appUrl = this.configService.getOrThrow<string>('APP_URL');
    this.secretKey = this.configService.getOrThrow<string>('ENCRYPTION_KEY');
    this.resendWebhookSecret = this.configService.get<string>(
      'RESEND_WEBHOOK_SECRET',
      'whsec_test_resend_secret',
    );
  }

  async isSuppressed(accountId: string, email: string): Promise<boolean> {
    const normalizedEmail = email.toLowerCase().trim();
    const record = await this.prisma.suppression.findUnique({
      where: {
        accountId_email: {
          accountId,
          email: normalizedEmail,
        },
      },
    });
    return Boolean(record);
  }

  generateUnsubscribeUrl(accountId: string, email: string): string {
    const normalizedEmail = email.toLowerCase().trim();
    const data = JSON.stringify({ a: accountId, e: normalizedEmail });
    const payloadB64 = Buffer.from(data, 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secretKey)
      .update(payloadB64)
      .digest('base64url');

    const token = `${payloadB64}.${signature}`;
    return `${this.appUrl}/unsubscribe/${token}`;
  }

  verifyUnsubscribeToken(token: string): { accountId: string; email: string } {
    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new BadRequestException('Invalid unsubscribe token format');
    }

    const [payloadB64, signature] = parts;
    const expectedSig = createHmac('sha256', this.secretKey)
      .update(payloadB64)
      .digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);

    if (
      sigBuf.length !== expectedBuf.length ||
      !timingSafeEqual(sigBuf, expectedBuf)
    ) {
      throw new BadRequestException('Invalid unsubscribe token signature');
    }

    try {
      const parsed = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf8'),
      ) as { a?: string; e?: string };
      if (!parsed.a || !parsed.e) {
        throw new Error('Missing fields');
      }
      return { accountId: parsed.a, email: parsed.e.toLowerCase().trim() };
    } catch {
      throw new BadRequestException('Malformed unsubscribe token payload');
    }
  }

  async handleUnsubscribe(
    token: string,
  ): Promise<{ accountId: string; email: string }> {
    const { accountId, email } = this.verifyUnsubscribeToken(token);
    await this.suppressAddressAndCancelReminders(
      accountId,
      email,
      'unsubscribed',
    );
    return { accountId, email };
  }

  /**
   * Adds an address to the account's Suppression table and skips all pending reminders
   * for that customer across the account.
   */
  async suppressAddressAndCancelReminders(
    accountId: string,
    email: string,
    reason: 'unsubscribed' | 'bounced' | 'complained',
  ): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim();

    await this.prisma.$transaction([
      this.prisma.suppression.upsert({
        where: {
          accountId_email: { accountId, email: normalizedEmail },
        },
        create: {
          accountId,
          email: normalizedEmail,
          reason,
        },
        update: { reason },
      }),
      this.prisma.reminder.updateMany({
        where: {
          status: {
            in: [ReminderStatus.SCHEDULED, ReminderStatus.PENDING_APPROVAL],
          },
          invoice: {
            accountId,
            customerEmail: normalizedEmail,
          },
        },
        data: {
          status: ReminderStatus.SKIPPED,
          failureReason: `Customer ${reason}`,
        },
      }),
    ]);

    this.logger.log(
      { accountId, customerEmail: normalizedEmail, reason },
      `Suppressed customer ${normalizedEmail} and skipped pending reminders (reason=${reason})`,
    );
  }

  /**
   * Sends a reminder email via Resend using a deterministic Idempotency-Key (`reminder-send-${reminderId}`).
   * If a worker crashes after Resend accepts the request, retrying with the same reminderId
   * returns the same email ID without sending a duplicate email.
   */
  async sendReminderEmail(
    params: SendReminderEmailParams,
  ): Promise<{ resendEmailId: string }> {
    const idempotencyKey = `reminder-send-${params.reminderId}`;
    const fromAddress = this.fromDomain.includes('@')
      ? `${params.senderName} <${this.fromDomain}>`
      : `${params.senderName} <reminders@${this.fromDomain}>`;

    if (this.isMockMode || !this.resend) {
      // Deterministic mock ID tied to reminderId so crash-retries are idempotent in mock mode too
      const deterministicMockId = `re_mock_${params.reminderId}`;
      this.logger.log(
        {
          accountId: params.accountId,
          reminderId: params.reminderId,
          resendEmailId: deterministicMockId,
          idempotencyKey,
        },
        `[MOCK RESEND] Sent email (${deterministicMockId}) to=${params.toEmail} subject="${params.subject}"`,
      );
      return { resendEmailId: deterministicMockId };
    }

    const { data, error } = await this.resend.emails.send(
      {
        from: fromAddress,
        to: [params.toEmail],
        replyTo: params.senderEmail,
        subject: params.subject,
        text: params.text,
        html: params.html,
        headers: {
          'List-Unsubscribe': `<${params.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
      {
        idempotencyKey,
      },
    );

    if (error || !data?.id) {
      this.metricsService.externalErrorsTotal.inc({ provider: 'resend' });
      this.logger.error(
        `Resend API error sending to ${params.toEmail}: ${error?.message ?? 'Unknown error'}`,
      );
      throw new InternalServerErrorException(
        `Resend send failed: ${error?.message ?? 'Unknown error'}`,
      );
    }

    return { resendEmailId: data.id };
  }

  /**
   * Verifies Svix HMAC signature for POST /webhooks/resend.
   */
  verifyResendWebhookSignature(
    rawBody: Buffer,
    svixId: string,
    svixTimestamp: string,
    svixSignature: string,
  ): ResendWebhookPayload {
    if (!svixId || !svixTimestamp || !svixSignature) {
      throw new BadRequestException('Missing Svix webhook signature headers');
    }

    const rawSecret = this.resendWebhookSecret.startsWith('whsec_')
      ? this.resendWebhookSecret.slice(6)
      : this.resendWebhookSecret;

    const secretBytes = Buffer.from(rawSecret, 'base64');
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody.toString('utf8')}`;
    const expectedSignature = createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64');

    const passedSignatures = svixSignature
      .split(' ')
      .map((part) => part.split(',')[1])
      .filter((sig): sig is string => Boolean(sig));

    const verified = passedSignatures.some((sig) => {
      const a = Buffer.from(sig);
      const b = Buffer.from(expectedSignature);
      return a.length === b.length && timingSafeEqual(a, b);
    });

    if (!verified) {
      throw new BadRequestException('Invalid Resend webhook signature');
    }

    return JSON.parse(rawBody.toString('utf8')) as ResendWebhookPayload;
  }

  /**
   * Handles Resend delivery events (email.delivered, email.bounced, email.complained) idempotently.
   */
  async processResendWebhook(
    svixId: string,
    payload: ResendWebhookPayload,
  ): Promise<{ processed: boolean; duplicate?: boolean }> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          source: 'resend',
          externalId: svixId,
          type: payload.type,
          payload: payload as unknown as Prisma.InputJsonValue,
          processedAt: new Date(),
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return { processed: true, duplicate: true };
      }
      throw err;
    }

    const emailId = payload.data?.email_id;
    if (!emailId) {
      return { processed: true };
    }

    const reminder = await this.prisma.reminder.findUnique({
      where: { resendEmailId: emailId },
      include: { invoice: true },
    });

    if (!reminder) {
      this.logger.debug(
        `No reminder found matching resendEmailId=${emailId} for event ${payload.type}`,
      );
      return { processed: true };
    }

    const { invoice } = reminder;

    if (payload.type === 'email.delivered') {
      await this.prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          deliveryStatus: DeliveryStatus.DELIVERED,
          deliveredAt: new Date(),
        },
      });
      await this.auditService.log({
        reminderId: reminder.id,
        accountId: invoice.accountId,
        invoiceId: invoice.id,
        stage: reminder.stage,
        event: 'DELIVERED',
        metadata: { resendEmailId: emailId },
      });
    } else if (
      payload.type === 'email.bounced' ||
      payload.type === 'email.complained'
    ) {
      const reason =
        payload.type === 'email.bounced' ? 'bounced' : 'complained';
      const deliveryStatus =
        payload.type === 'email.bounced'
          ? DeliveryStatus.BOUNCED
          : DeliveryStatus.COMPLAINED;

      await this.prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          deliveryStatus,
          failureReason: `Email ${reason} via Resend webhook`,
        },
      });

      await this.suppressAddressAndCancelReminders(
        invoice.accountId,
        invoice.customerEmail,
        reason,
      );

      await this.auditService.log({
        reminderId: reminder.id,
        accountId: invoice.accountId,
        invoiceId: invoice.id,
        stage: reminder.stage,
        event: reason.toUpperCase(),
        metadata: { resendEmailId: emailId },
      });
    }

    return { processed: true };
  }

  async handleInboundReply(fromEmail: string, _toEmail?: string) {
    const normalizedFrom = fromEmail.toLowerCase().trim();

    // Find accounts that have invoices with this customerEmail
    const invoices = await this.prisma.invoice.findMany({
      where: {
        customerEmail: normalizedFrom,
        status: 'OPEN',
      },
      select: {
        id: true,
        accountId: true,
      },
    });

    if (invoices.length === 0) {
      this.logger.debug(`Inbound reply from ${normalizedFrom} matched zero open invoices`);
      return { paused: 0 };
    }

    let pausedCount = 0;
    for (const inv of invoices) {
      await this.prisma.reminder.updateMany({
        where: {
          invoiceId: inv.id,
          status: { in: [ReminderStatus.SCHEDULED, ReminderStatus.PENDING_APPROVAL] },
        },
        data: {
          status: ReminderStatus.SKIPPED,
          failureReason: 'Customer replied to email (sequence auto-paused)',
        },
      });
      pausedCount++;
    }

    this.logger.log(`Auto-paused reminders across ${pausedCount} invoice(s) due to reply from ${normalizedFrom}`);
    return { paused: pausedCount, from: normalizedFrom };
  }

}