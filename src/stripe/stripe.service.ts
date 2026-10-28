import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { createHmac, timingSafeEqual } from 'crypto';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;
  private readonly clientId: string;
  private readonly encryptionKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly cryptoService: CryptoService,
  ) {
    this.stripe = new Stripe(
      this.configService.getOrThrow<string>('STRIPE_SECRET_KEY'),
    );
    this.webhookSecret = this.configService.getOrThrow<string>(
      'STRIPE_WEBHOOK_SECRET',
    );
    this.clientId = this.configService.getOrThrow<string>('STRIPE_CLIENT_ID');
    this.encryptionKey =
      this.configService.getOrThrow<string>('ENCRYPTION_KEY');
  }

  /**
   * Generates a signed OAuth state parameter bound to accountId to prevent CSRF.
   */
  generateOAuthUrl(accountId: string): string {
    const timestamp = Date.now().toString();
    const payload = `${accountId}.${timestamp}`;
    const signature = createHmac('sha256', this.encryptionKey)
      .update(payload)
      .digest('hex');
    const state = `${payload}.${signature}`;

    const redirectUri = `${this.configService.getOrThrow<string>('APP_URL')}/connect/stripe/callback`;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: 'read_write',
      redirect_uri: redirectUri,
      state,
    });

    return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
  }

  verifyOAuthState(state: string): string {
    const parts = state.split('.');
    if (parts.length !== 3) {
      throw new BadRequestException('Invalid OAuth state parameter');
    }
    const [accountId, timestamp, signature] = parts;
    const payload = `${accountId}.${timestamp}`;
    const expectedSig = createHmac('sha256', this.encryptionKey)
      .update(payload)
      .digest('hex');

    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSig, 'hex');

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      throw new BadRequestException('Invalid OAuth state signature');
    }

    // Expire state after 15 minutes
    if (Date.now() - Number(timestamp) > 15 * 60 * 1000) {
      throw new BadRequestException('OAuth state expired');
    }

    return accountId;
  }

  async handleOAuthCallback(
    code: string,
    state: string,
  ): Promise<{ stripeAccountId: string }> {
    const accountId = this.verifyOAuthState(state);
    const response = await this.stripe.oauth.token({
      grant_type: 'authorization_code',
      code,
    });

    if (!response.stripe_user_id || !response.access_token) {
      throw new BadRequestException(
        'Stripe OAuth did not return account credentials',
      );
    }

    const encryptedToken = this.cryptoService.encrypt(response.access_token);

    await this.prisma.account.update({
      where: { id: accountId },
      data: {
        stripeAccountId: response.stripe_user_id,
        stripeTokenEnc: encryptedToken,
      },
    });

    this.logger.log(
      `Connected Stripe account ${response.stripe_user_id} for Account ${accountId}`,
    );
    return { stripeAccountId: response.stripe_user_id };
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    try {
      return this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new BadRequestException(
        `Webhook signature verification failed: ${message}`,
      );
    }
  }

  /**
   * Used by the Reminder Worker to re-check live status from Stripe before sending.
   * Supports synthetic load-test invoices (in_loadtest_*) or sk_test_mock for 10k k6 runs.
   */
  async fetchLiveInvoice(
    stripeInvoiceId: string,
    stripeAccountId?: string | null,
  ): Promise<Stripe.Invoice> {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY', '');
    if (
      secretKey === 'sk_test_mock' ||
      stripeInvoiceId.startsWith('in_loadtest_')
    ) {
      const local = await this.prisma.invoice.findUnique({
        where: { stripeInvoiceId },
      });
      const statusMap: Record<string, Stripe.Invoice.Status> = {
        OPEN: 'open',
        PAID: 'paid',
        VOID: 'void',
        UNCOLLECTIBLE: 'uncollectible',
      };
      return {
        id: stripeInvoiceId,
        object: 'invoice',
        status: local ? statusMap[local.status] : 'open',
        customer_email: local?.customerEmail ?? 'loadtest@example.com',
        customer_name: local?.customerName ?? 'Load Test User',
        amount_due: local?.amountDue ?? 15000,
        currency: local?.currency ?? 'usd',
        due_date: local
          ? Math.floor(local.dueDate.getTime() / 1000)
          : Math.floor(Date.now() / 1000),
        created: Math.floor(Date.now() / 1000),
        number: local?.invoiceNumber ?? stripeInvoiceId,
        hosted_invoice_url:
          local?.hostedInvoiceUrl ??
          `https://invoice.stripe.com/i/loadtest/${stripeInvoiceId}`,
      } as unknown as Stripe.Invoice;
    }

    if (stripeAccountId) {
      return this.stripe.invoices.retrieve(
        stripeInvoiceId,
        {},
        { stripeAccount: stripeAccountId },
      );
    }
    return this.stripe.invoices.retrieve(stripeInvoiceId);
  }
}