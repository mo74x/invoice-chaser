import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { ToneProfile } from '../ai/interfaces/tone-profile.interface';
import { formatMinorUnits } from '../mail/mail.templates';
import { PreviewToneEmailDto } from './dto/tone.dto';

@Injectable()
export class ToneService {
  private readonly logger = new Logger(ToneService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
  ) {}

  /**
   * Saves 3-5 sample emails for an account and immediately extracts the ToneProfile.
   */
  async saveSamples(accountId: string, samples: string[]) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
    });
    if (!account) {
      throw new NotFoundException(`Account ${accountId} not found`);
    }

    await this.prisma.$transaction([
      this.prisma.toneSample.deleteMany({ where: { accountId } }),
      this.prisma.toneSample.createMany({
        data: samples.map((content) => ({
          accountId,
          content: content.trim(),
        })),
      }),
    ]);

    const toneProfile = await this.rebuildProfile(accountId);
    return {
      accountId,
      samplesCount: samples.length,
      toneProfile,
    };
  }

  /**
   * Re-runs Claude tone extraction over stored ToneSamples and persists Account.toneProfile.
   */
  async rebuildProfile(accountId: string): Promise<ToneProfile> {
    const samples = await this.prisma.toneSample.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
    });

    if (samples.length < 3) {
      throw new BadRequestException(
        `Account ${accountId} has ${samples.length} sample(s); at least 3 are required to build a tone profile`,
      );
    }

    const profile = await this.aiService.extractToneProfile(
      samples.map((s) => s.content),
    );

    await this.prisma.account.update({
      where: { id: accountId },
      data: {
        toneProfile: profile as unknown as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `Rebuilt tone profile for account ${accountId} (formality=${profile.formality})`,
    );
    return profile;
  }

  /**
   * Previews a generated reminder email for a specific stage (3, 7, or 14)
   * using the founder's saved ToneProfile and sample/override invoice facts.
   */
  async previewStageEmail(dto: PreviewToneEmailDto) {
    const account = await this.prisma.account.findUnique({
      where: { id: dto.accountId },
    });
    if (!account) {
      throw new NotFoundException(`Account ${dto.accountId} not found`);
    }

    const toneProfile = account.toneProfile as ToneProfile | null;
    const customerFirstName =
      (dto.customerName ?? 'Sarah Connor').trim().split(/\s+/)[0] ?? 'Sarah';
    const amountMinor = dto.amountDue ?? 240000;
    const currency = dto.currency ?? 'usd';
    const invoiceNumber = dto.invoiceNumber ?? 'INV-2048';
    const dueDate = new Date(Date.now() - dto.stage * 86_400_000);

    const facts = {
      customer_first_name: customerFirstName,
      invoice_number: invoiceNumber,
      amount: formatMinorUnits(amountMinor, currency),
      due_date: dueDate.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      pay_link: `https://invoice.stripe.com/i/acct_preview/${invoiceNumber}`,
      sender_name: account.senderName,
    };

    const result = await this.aiService.generateReminderEmail({
      stage: dto.stage,
      toneProfile,
      facts,
      unsubscribeUrl: 'http://localhost:3000/unsubscribe/preview-token',
    });

    return {
      stage: dto.stage,
      toneProfileUsed: toneProfile,
      factsInjected: facts,
      rawDraftWithPlaceholders: result.rawDraft ?? null,
      usedFallback: result.usedFallback,
      attempts: result.attempts,
      email: {
        subject: result.subject,
        text: result.text,
        html: result.html,
      },
    };
  }
}