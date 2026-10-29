import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';
import { ToneProfile } from './interfaces/tone-profile.interface';

describe('AiService', () => {
  let service: AiService;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      get: jest.fn((key: string, defaultVal?: string) => {
        if (key === 'ANTHROPIC_API_KEY') return 'sk-ant-mock';
        if (key === 'ANTHROPIC_MODEL') return 'claude-3-5-sonnet-latest';
        return defaultVal ?? '';
      }),
    } as unknown as ConfigService;

    service = new AiService(configService);
  });

  describe('Mock Mode Tone Extraction', () => {
    it('correctly extracts casual ToneProfile from casual founder samples', async () => {
      const casualSamples = [
        'Hey Sarah! Quick ping on the invoice, cheers!',
        'No worries at all, let me know if anything looks off.',
        'Super excited to work together, thanks folks!',
      ];

      const profile = await service.extractToneProfile(casualSamples);

      expect(profile.formality).toBe('casual');
      expect(profile.greetingStyle).toContain('Hey');
      expect(profile.signOff).toBe('Cheers,');
    });

    it('correctly extracts formal ToneProfile from formal founder samples', async () => {
      const formalSamples = [
        'Dear Sir, herewith please find attached our invoice for review. Sincerely, Alex',
        'We would kindly appreciate your prompt attention to this matter. Cordially, Alex',
        'Pleased to provide any required assistance regarding your account.',
      ];

      const profile = await service.extractToneProfile(formalSamples);

      expect(profile.formality).toBe('formal');
      expect(profile.greetingStyle).toContain('Dear');
      expect(profile.signOff).toBe('Sincerely,');
    });
  });

  describe('Reminder Email Generation', () => {
    const mockFacts = {
      customer_first_name: 'David',
      invoice_number: 'INV-4096',
      amount: '$1,500.00',
      due_date: 'Nov 1, 2026',
      pay_link: 'https://invoice.stripe.com/test_link',
      sender_name: 'Elena from Acme',
    };

    it('uses fallback template when no toneProfile is supplied', async () => {
      const result = await service.generateReminderEmail({
        stage: 3,
        toneProfile: null,
        facts: mockFacts,
        unsubscribeUrl: 'https://example.com/unsub',
      });

      expect(result.usedFallback).toBe(true);
      expect(result.attempts).toBe(0);
      expect(result.subject).toContain('INV-4096');
      expect(result.text).toContain('$1,500.00');
    });

    it('generates tone-matched draft in mock mode without errors', async () => {
      const mockProfile: ToneProfile = {
        formality: 'casual',
        greetingStyle: 'Hey {{customer_first_name}}!',
        signOff: 'Best,',
        sentenceLength: 'short',
        humorLevel: 'light',
        warmth: 'warm',
        phrasesToUse: ['quick ping'],
        phrasesToAvoid: ['immediate payment required'],
        summary: 'Casual founder tone',
      };

      const result = await service.generateReminderEmail({
        stage: 3,
        toneProfile: mockProfile,
        facts: mockFacts,
        unsubscribeUrl: 'https://example.com/unsub',
      });

      expect(result.usedFallback).toBe(false);
      expect(result.attempts).toBe(1);
      expect(result.text).toContain('David');
      expect(result.text).toContain('$1,500.00');
      expect(result.text).toContain('https://invoice.stripe.com/test_link');
    });
  });
});

