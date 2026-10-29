import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../observability/metrics.service';
import { AuditService } from '../observability/audit.service';
import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'crypto';

describe('MailService', () => {
  let service: MailService;
  let configService: ConfigService;
  let prismaService: PrismaService;
  let metricsService: MetricsService;
  let auditService: AuditService;

  const mockEncryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const rawSvixSecret = 'whsec_dGVzdF9zdml4X3NlY3JldF9mb3JfdGVzdGluZ18xMjM=';

  beforeEach(() => {
    configService = {
      get: jest.fn((key: string, defaultVal?: string) => {
        if (key === 'RESEND_API_KEY') return 're_mock';
        if (key === 'RESEND_FROM_DOMAIN') return 'onboarding@resend.dev';
        if (key === 'RESEND_WEBHOOK_SECRET') return rawSvixSecret;
        return defaultVal ?? '';
      }),
      getOrThrow: jest.fn((key: string) => {
        if (key === 'APP_URL') return 'http://localhost:3000';
        if (key === 'ENCRYPTION_KEY') return mockEncryptionKey;
        return '';
      }),
    } as unknown as ConfigService;

    prismaService = {
      suppression: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      reminder: {
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      webhookEvent: {
        create: jest.fn(),
      },
      $transaction: jest.fn((promises: Promise<unknown>[]) => Promise.all(promises)),
    } as unknown as PrismaService;

    metricsService = {
      webhookLatency: {
        startTimer: jest.fn().mockReturnValue(jest.fn()),
      },
      externalErrorsTotal: {
        inc: jest.fn(),
      },
    } as unknown as MetricsService;

    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;

    service = new MailService(configService, prismaService, metricsService, auditService);
  });

  describe('Unsubscribe Token Generation & Verification', () => {
    it('generates a valid signed unsubscribe token and verifies accountId and email', () => {
      const accountId = 'acct_founder_1';
      const email = 'client@customer.com';

      const url = service.generateUnsubscribeUrl(accountId, email);
      expect(url).toContain('http://localhost:3000/unsubscribe/');

      const token = url.split('/unsubscribe/')[1];
      const verified = service.verifyUnsubscribeToken(token);
      expect(verified.accountId).toBe(accountId);
      expect(verified.email).toBe(email);
    });

    it('rejects tampered unsubscribe token signature', () => {
      const url = service.generateUnsubscribeUrl('acct_1', 'client@customer.com');
      const token = url.split('/unsubscribe/')[1];
      const [payload] = token.split('.');
      const tampered = `${payload}.tamperedSignature`;

      expect(() => service.verifyUnsubscribeToken(tampered)).toThrow(BadRequestException);
    });
  });

  describe('Suppression Cascade', () => {
    it('upserts suppression record and cancels all pending/scheduled reminders', async () => {
      const accountId = 'acct_test';
      const email = 'bounce@client.com';

      await service.suppressAddressAndCancelReminders(accountId, email, 'bounced');

      expect(prismaService.suppression.upsert).toHaveBeenCalledWith({
        where: { accountId_email: { accountId, email } },
        create: { accountId, email, reason: 'bounced' },
        update: { reason: 'bounced' },
      });

      expect(prismaService.reminder.updateMany).toHaveBeenCalledWith({
        where: {
          status: { in: ['SCHEDULED', 'PENDING_APPROVAL'] },
          invoice: { accountId, customerEmail: email },
        },
        data: {
          status: 'SKIPPED',
          failureReason: 'Customer bounced',
        },
      });
    });
  });

  describe('Svix Webhook Signature Verification', () => {
    it('verifies valid Svix HMAC-SHA256 signature from Resend webhook', () => {
      const payloadObj = {
        type: 'email.delivered',
        created_at: new Date().toISOString(),
        data: { email_id: 're_123', to: ['user@example.com'], from: 'onboarding@resend.dev' },
      };
      const rawBody = Buffer.from(JSON.stringify(payloadObj));
      const svixId = 'msg_test_123';
      const svixTimestamp = Math.floor(Date.now() / 1000).toString();

      const secret = Buffer.from('dGVzdF9zdml4X3NlY3JldF9mb3JfdGVzdGluZ18xMjM=', 'base64');
      const toSign = `${svixId}.${svixTimestamp}.${rawBody.toString('utf8')}`;
      const signature = createHmac('sha256', secret).update(toSign).digest('base64');
      const svixSignature = `v1,${signature}`;

      const verified = service.verifyResendWebhookSignature(
        rawBody,
        svixId,
        svixTimestamp,
        svixSignature,
      );

      expect(verified.type).toBe('email.delivered');
      expect(verified.data.email_id).toBe('re_123');
    });

    it('rejects invalid Svix signature', () => {
      const rawBody = Buffer.from('{"type":"email.delivered"}');
      expect(() =>
        service.verifyResendWebhookSignature(
          rawBody,
          'msg_1',
          '1234567890',
          'v1,invalidBase64Sig==',
        ),
      ).toThrow(BadRequestException);
    });
  });
});

