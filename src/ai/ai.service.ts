import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  PlaceholderFacts,
  RawAiReminderDraft,
  ToneProfile,
} from './interfaces/tone-profile.interface';
import {
  buildReminderGenerationPrompt,
  buildToneExtractionPrompt,
} from './prompts/tone.prompts';
import {
  formatFinalAiEmail,
  interpolatePlaceholders,
  validateAiReminderDraft,
} from './validators/reminder-output.validator';
import { renderFallbackTemplate } from '../mail/mail.templates';

export interface GeneratedReminderResult {
  subject: string;
  text: string;
  html: string;
  rawDraft?: RawAiReminderDraft;
  usedFallback: boolean;
  attempts: number;
  validationErrors?: string[];
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly anthropic: Anthropic | null;
  private readonly isMockMode: boolean;
  private readonly model: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>(
      'ANTHROPIC_API_KEY',
      'sk-ant-mock',
    );
    this.isMockMode = !apiKey || apiKey === 'sk-ant-mock';
    this.anthropic = this.isMockMode ? null : new Anthropic({ apiKey });
    this.model = this.configService.get<string>(
      'ANTHROPIC_MODEL',
      'claude-sonnet-4-20250514',
    );
  }

  /**
   * Extracts a structured ToneProfile JSON from 3-5 founder sample emails.
   */
  async extractToneProfile(samples: string[]): Promise<ToneProfile> {
    if (this.isMockMode || !this.anthropic) {
      return this.extractHeuristicToneProfile(samples);
    }

    const { system, user } = buildToneExtractionPrompt(samples);

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const rawText = textBlock?.type === 'text' ? textBlock.text.trim() : '';

    try {
      const cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/```$/i, '')
        .trim();
      const parsed = JSON.parse(cleaned) as ToneProfile;
      return parsed;
    } catch (err) {
      this.logger.warn(
        `Failed to parse Claude tone profile JSON, falling back to heuristic extractor: ${
          err instanceof Error ? err.message : 'Unknown error'
        }`,
      );
      return this.extractHeuristicToneProfile(samples);
    }
  }

  /**
   * Generates a stage-specific reminder email using the founder's ToneProfile,
   * validates output against hallucinations/threats, retries once on failure,
   * and falls back to the plain template if needed.
   */
  async generateReminderEmail(params: {
    stage: number;
    toneProfile: ToneProfile | null;
    facts: PlaceholderFacts;
    unsubscribeUrl: string;
  }): Promise<GeneratedReminderResult> {
    const { stage, toneProfile, facts, unsubscribeUrl } = params;

    // If the founder has not configured a ToneProfile yet, use the plain template
    if (!toneProfile) {
      const fallback = renderFallbackTemplate(stage, {
        customerFirstName: facts.customer_first_name,
        invoiceNumber: facts.invoice_number,
        formattedAmount: facts.amount,
        formattedDueDate: facts.due_date,
        payLink: facts.pay_link,
        senderName: facts.sender_name,
        unsubscribeUrl,
      });
      return {
        ...fallback,
        usedFallback: true,
        attempts: 0,
      };
    }

    const hasCustomerName = Boolean(facts.customer_first_name.trim());
    let lastValidationErrors: string[] = [];

    // Try up to 2 attempts (initial + 1 retry)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const rawDraft = await this.callModelForReminder({
          stage,
          toneProfile,
          hasCustomerName,
          validationErrors: attempt > 1 ? lastValidationErrors : undefined,
        });

        const validation = validateAiReminderDraft(rawDraft, {
          allowCustomerFirstName: hasCustomerName,
        });

        if (validation.valid) {
          const interpolated = interpolatePlaceholders(rawDraft, facts);
          const finalEmail = formatFinalAiEmail(
            interpolated,
            facts.pay_link,
            unsubscribeUrl,
          );
          return {
            ...finalEmail,
            rawDraft,
            usedFallback: false,
            attempts: attempt,
          };
        }

        lastValidationErrors = validation.errors;
        this.logger.warn(
          `AI reminder validation failed on attempt ${attempt} (stage=${stage}): ${validation.errors.join('; ')}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown AI error';
        lastValidationErrors = [msg];
        this.logger.warn(
          `AI reminder generation threw error on attempt ${attempt} (stage=${stage}): ${msg}`,
        );
      }
    }

    // Fallback to plain deterministic template after 2 failed attempts
    this.logger.warn(
      `Falling back to plain template for stage ${stage} after 2 failed AI attempts`,
    );
    const fallback = renderFallbackTemplate(stage, {
      customerFirstName: facts.customer_first_name,
      invoiceNumber: facts.invoice_number,
      formattedAmount: facts.amount,
      formattedDueDate: facts.due_date,
      payLink: facts.pay_link,
      senderName: facts.sender_name,
      unsubscribeUrl,
    });

    return {
      ...fallback,
      usedFallback: true,
      attempts: 2,
      validationErrors: lastValidationErrors,
    };
  }

  private async callModelForReminder(params: {
    stage: number;
    toneProfile: ToneProfile;
    hasCustomerName: boolean;
    validationErrors?: string[];
  }): Promise<RawAiReminderDraft> {
    if (this.isMockMode || !this.anthropic) {
      return this.generateMockDraft(
        params.stage,
        params.toneProfile,
        params.hasCustomerName,
      );
    }

    const { system, user } = buildReminderGenerationPrompt(params);
    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const rawText = textBlock?.type === 'text' ? textBlock.text.trim() : '';
    const cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    return JSON.parse(cleaned) as RawAiReminderDraft;
  }

  /**
   * Heuristic tone profile extractor used when ANTHROPIC_API_KEY=sk-ant-mock.
   * Accurately distinguishes casual vs. formal founder samples for local E2E testing.
   */
  private extractHeuristicToneProfile(samples: string[]): ToneProfile {
    const joined = samples.join('\n');
    const lower = joined.toLowerCase();

    const isCasual =
      /\b(hey|cheers|yo|folks|super|quick ping|no worries|awesome)\b/i.test(
        joined,
      );
    const isFormal =
      /\b(dear|sincerely|regards|kindly|herewith|cordially|pleased)\b/i.test(
        joined,
      ) && !isCasual;

    const formality: ToneProfile['formality'] = isFormal
      ? 'formal'
      : isCasual
        ? 'casual'
        : 'balanced';

    const greetingStyle = isFormal
      ? 'Dear {{customer_first_name}},'
      : isCasual
        ? 'Hey {{customer_first_name}}!'
        : 'Hi {{customer_first_name}},';

    let signOff = 'Best,';
    if (/\bcheers\b/i.test(lower)) signOff = 'Cheers,';
    else if (/\bsincerely\b/i.test(lower)) signOff = 'Sincerely,';
    else if (/\bwarm regards\b/i.test(lower)) signOff = 'Warm regards,';
    else if (/\bthanks\b/i.test(lower)) signOff = 'Thanks,';

    const phrasesToUse: string[] = [];
    if (lower.includes('quick ping')) phrasesToUse.push('just a quick ping');
    if (lower.includes('no worries')) phrasesToUse.push('no worries at all');
    if (lower.includes('appreciate'))
      phrasesToUse.push('really appreciate your partnership');
    if (lower.includes('kindly'))
      phrasesToUse.push('kindly let us know at your earliest convenience');
    if (phrasesToUse.length === 0) {
      phrasesToUse.push(
        isFormal
          ? 'thank you for your prompt attention'
          : 'let me know if anything looks off',
      );
    }

    return {
      formality,
      greetingStyle,
      signOff,
      sentenceLength: isCasual ? 'short' : isFormal ? 'long' : 'medium',
      humorLevel: isCasual ? 'light' : 'none',
      warmth: isFormal ? 'direct' : 'warm',
      phrasesToUse,
      phrasesToAvoid: ['per my last email', 'immediate remittance required'],
      summary: isFormal
        ? 'Polished, executive, and structured communication style.'
        : isCasual
          ? 'Upbeat, conversational, and concise founder style.'
          : 'Friendly, clear, and approachable communication style.',
    };
  }

  /**
   * Generates distinct, tone-faithful drafts using placeholders in mock mode.
   */
  private generateMockDraft(
    stage: number,
    tone: ToneProfile,
    hasCustomerName: boolean,
  ): RawAiReminderDraft {
    const greeting = hasCustomerName
      ? tone.greetingStyle
      : tone.formality === 'formal'
        ? 'Hello,'
        : tone.formality === 'casual'
          ? 'Hey there!'
          : 'Hi there,';

    const customPhrase = tone.phrasesToUse[0] ?? '';

    if (tone.formality === 'casual') {
      if (stage <= 3) {
        return {
          subject: 'Quick ping on invoice {{invoice_number}}',
          body: `${greeting}\n\nHope your week is going great! Sending a quick nudge on invoice {{invoice_number}} for {{amount}}, which was due on {{due_date}}—${customPhrase}.\n\nYou can grab the invoice and take care of it right here: {{pay_link}}\n\n${tone.signOff}\n{{sender_name}}`,
        };
      }
      if (stage <= 7) {
        return {
          subject: 'Following up on invoice {{invoice_number}}',
          body: `${greeting}\n\nJust circling back on invoice {{invoice_number}} for {{amount}} (due {{due_date}}). Let me know if you need me to tweak anything on the invoice!\n\nHere is the direct payment link whenever you are ready: {{pay_link}}\n\n${tone.signOff}\n{{sender_name}}`,
        };
      }
      return {
        subject: 'Checking in on overdue invoice {{invoice_number}}',
        body: `${greeting}\n\nWanted to check in on invoice {{invoice_number}} for {{amount}}, which was due two weeks ago on {{due_date}}.\n\nCould you hit reply and let me know when we should expect payment, or settle it via {{pay_link}}?\n\n${tone.signOff}\n{{sender_name}}`,
      };
    }

    if (tone.formality === 'formal') {
      if (stage <= 3) {
        return {
          subject: 'Courtesy reminder regarding invoice {{invoice_number}}',
          body: `${greeting}\n\nI hope this message finds you well. I am writing to share a courtesy reminder regarding invoice {{invoice_number}} in the amount of {{amount}}, which was due on {{due_date}}.\n\nFor your convenience, the invoice may be reviewed and settled at the following link: {{pay_link}}\n\n${tone.signOff}\n{{sender_name}}`,
        };
      }
      if (stage <= 7) {
        return {
          subject: 'Follow-up regarding outstanding invoice {{invoice_number}}',
          body: `${greeting}\n\nI am following up regarding invoice {{invoice_number}} for {{amount}}, with a due date of {{due_date}}. Please let me know if any additional documentation is required on your end.\n\nYou may access the invoice and remit payment here: {{pay_link}}\n\n${tone.signOff}\n{{sender_name}}`,
        };
      }
      return {
        subject: 'Action requested: Overdue invoice {{invoice_number}}',
        body: `${greeting}\n\nI am writing regarding invoice {{invoice_number}} for {{amount}}, which became due on {{due_date}} and remains unsettled after two weeks.\n\nKindly confirm the scheduled payment date by reply, or complete payment directly via {{pay_link}}.\n\n${tone.signOff}\n{{sender_name}}`,
      };
    }

    // Balanced default
    return {
      subject: 'Follow-up on invoice {{invoice_number}}',
      body: `${greeting}\n\nI wanted to follow up on invoice {{invoice_number}} for {{amount}}, which was due on {{due_date}}.\n\nYou can view and pay the invoice at your convenience here: {{pay_link}}\n\n${tone.signOff}\n{{sender_name}}`,
    };
  }
}