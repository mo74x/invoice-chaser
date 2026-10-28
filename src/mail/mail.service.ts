import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ReminderStatus } from '../../generated/prisma/client'
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Resend } from 'resend';

export interface SendReminderEmailParams {
  accountId: string;
  senderName: string;
  senderEmail: string;
  toEmail: string;
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly isMockMode: boolean;
  private readonly fromDomain: string;
  private readonly appUrl: string;
  private readonly secretKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
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
  }

  /**
   * Checks whether an email address is on the account's suppression list
   * (unsubscribed, bounced, or complained).
   */
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

  /**
   * Generates a tamper-proof, stateless URL-safe unsubscribe token for (accountId, email).
   */
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

  /**
   * Adds the customer to the suppression list and immediately skips any pending reminders.
   */
  async handleUnsubscribe(
    token: string,
  ): Promise<{ accountId: string; email: string }> {
    const { accountId, email } = this.verifyUnsubscribeToken(token);

    await this.prisma.$transaction([
      this.prisma.suppression.upsert({
        where: {
          accountId_email: { accountId, email },
        },
        create: {
          accountId,
          email,
          reason: 'unsubscribed',
        },
        update: {},
      }),
      this.prisma.reminder.updateMany({
        where: {
          status: {
            in: [ReminderStatus.SCHEDULED, ReminderStatus.PENDING_APPROVAL],
          },
          invoice: {
            accountId,
            customerEmail: email,
          },
        },
        data: {
          status: ReminderStatus.SKIPPED,
          failureReason: 'Customer unsubscribed',
        },
      }),
    ]);

    this.logger.log(
      `Suppressed customer ${email} for account ${accountId} (reason=unsubscribed)`,
    );
    return { accountId, email };
  }

  /**
   * Sends a reminder email via Resend (or logs in mock mode) with Reply-To and RFC-8058 List-Unsubscribe headers.
   */
  async sendReminderEmail(
    params: SendReminderEmailParams,
  ): Promise<{ resendEmailId: string }> {
    const fromAddress = this.fromDomain.includes('@')
      ? `${params.senderName} <${this.fromDomain}>`
      : `${params.senderName} <reminders@${this.fromDomain}>`;

    if (this.isMockMode || !this.resend) {
      const mockId = `re_mock_${randomUUID()}`;
      this.logger.log(
        `[MOCK RESEND] Sent email (${mockId}) to=${params.toEmail} subject="${params.subject}"`,
      );
      return { resendEmailId: mockId };
    }

    const { data, error } = await this.resend.emails.send({
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
    });

    if (error || !data?.id) {
      this.logger.error(
        `Resend API error sending to ${params.toEmail}: ${error?.message ?? 'Unknown error'}`,
      );
      throw new InternalServerErrorException(
        `Resend send failed: ${error?.message ?? 'Unknown error'}`,
      );
    }

    return { resendEmailId: data.id };
  }
}