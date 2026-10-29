import { ConfigService } from '@nestjs/config';
import { StripeService } from './stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { BadRequestException } from '@nestjs/common';

describe('StripeService', () => {
  let service: StripeService;
  let configService: ConfigService;
  let prismaService: PrismaService;
  let cryptoService: CryptoService;

  const mockEncryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'STRIPE_SECRET_KEY') return 'sk_test_mock';
        if (key === 'STRIPE_WEBHOOK_SECRET') return 'whsec_test_secret';
        if (key === 'STRIPE_CLIENT_ID') return 'ca_test_client_id';
        if (key === 'ENCRYPTION_KEY') return mockEncryptionKey;
        if (key === 'APP_URL') return 'http://localhost:3000';
        return '';
      }),
      get: jest.fn((key: string, defaultVal?: string) => {
        if (key === 'STRIPE_SECRET_KEY') return 'sk_test_mock';
        return defaultVal ?? '';
      }),
    } as unknown as ConfigService;

    prismaService = {
      invoice: {
        findUnique: jest.fn(),
      },
      account: {
        update: jest.fn(),
      },
    } as unknown as PrismaService;

    cryptoService = new CryptoService(configService);
    service = new StripeService(configService, prismaService, cryptoService);
  });

  describe('OAuth state generation and verification', () => {
    it('generates a valid signed OAuth state and verifies the accountId', () => {
      const accountId = 'acct_12345';
      const url = service.generateOAuthUrl(accountId);
      expect(url).toContain('https://connect.stripe.com/oauth/authorize?');

      const parsedUrl = new URL(url);
      const state = parsedUrl.searchParams.get('state');
      expect(state).toBeTruthy();

      const verifiedAccountId = service.verifyOAuthState(state!);
      expect(verifiedAccountId).toBe(accountId);
    });

    it('rejects tampered OAuth state parameter', () => {
      const accountId = 'acct_12345';
      const url = service.generateOAuthUrl(accountId);
      const parsedUrl = new URL(url);
      const state = parsedUrl.searchParams.get('state')!;

      const [acct, timestamp] = state.split('.');
      const tampered = `${acct}.${timestamp}.tampered_signature`;

      expect(() => service.verifyOAuthState(tampered)).toThrow(BadRequestException);
    });

    it('rejects expired OAuth state (older than 15 minutes)', () => {
      const accountId = 'acct_12345';
      const oldTimestamp = (Date.now() - 20 * 60 * 1000).toString();
      const payload = `${accountId}.${oldTimestamp}`;
      const { createHmac } = require('crypto');
      const sig = createHmac('sha256', mockEncryptionKey).update(payload).digest('hex');
      const expiredState = `${payload}.${sig}`;

      expect(() => service.verifyOAuthState(expiredState)).toThrow('OAuth state expired');
    });
  });

  describe('Synthetic Live Invoice for Load Tests', () => {
    it('returns synthetic live invoice when stripeInvoiceId starts with in_loadtest_', async () => {
      const mockDueDate = new Date('2026-11-01T00:00:00Z');
      (prismaService.invoice.findUnique as jest.Mock).mockResolvedValue({
        stripeInvoiceId: 'in_loadtest_99',
        status: 'OPEN',
        customerEmail: 'test@example.com',
        customerName: 'Test Founder',
        amountDue: 25000,
        currency: 'usd',
        dueDate: mockDueDate,
        invoiceNumber: 'INV-99',
        hostedInvoiceUrl: 'https://invoice.stripe.com/test/in_loadtest_99',
      });

      const invoice = await service.fetchLiveInvoice('in_loadtest_99');
      expect(invoice.id).toBe('in_loadtest_99');
      expect(invoice.status).toBe('open');
      expect(invoice.customer_email).toBe('test@example.com');
      expect(invoice.amount_due).toBe(25000);
      expect(invoice.due_date).toBe(Math.floor(mockDueDate.getTime() / 1000));
    });

    it('falls back to default synthetic fields when invoice not found in local db', async () => {
      (prismaService.invoice.findUnique as jest.Mock).mockResolvedValue(null);

      const invoice = await service.fetchLiveInvoice('in_loadtest_unknown');
      expect(invoice.id).toBe('in_loadtest_unknown');
      expect(invoice.status).toBe('open');
      expect(invoice.customer_email).toBe('loadtest@example.com');
      expect(invoice.amount_due).toBe(15000);
    });
  });
});

