import { ToneProfile } from '../interfaces/tone-profile.interface';

export function buildToneExtractionPrompt(samples: string[]): {
  system: string;
  user: string;
} {
  const system = `You are an expert linguistic analyst. Your job is to analyze 3 to 5 sample emails written by a company founder and extract a reusable JSON tone profile.
Return ONLY a valid JSON object with no markdown fences and no extra commentary.

Required JSON schema:
{
  "formality": "casual" | "balanced" | "formal",
  "greetingStyle": "string (use {{customer_first_name}} for the recipient's name, e.g., 'Hey {{customer_first_name}},' or 'Hi {{customer_first_name}},')",
  "signOff": "string (just the sign-off word/phrase without the sender name, e.g., 'Cheers,' or 'Best regards,')",
  "sentenceLength": "short" | "medium" | "long",
  "humorLevel": "none" | "light" | "playful",
  "warmth": "direct" | "warm" | "empathetic",
  "phrasesToUse": ["up to 5 signature expressions or transition phrases from the samples"],
  "phrasesToAvoid": ["up to 5 phrases that would clash with this founder's voice"],
  "summary": "1-2 sentence description of how this founder writes"
}`;

  const formattedSamples = samples
    .map((s, idx) => `--- SAMPLE ${idx + 1} ---\n${s.trim()}`)
    .join('\n\n');

  const user = `Analyze these founder email samples and return the JSON tone profile:\n\n${formattedSamples}`;

  return { system, user };
}

export function buildReminderGenerationPrompt(params: {
  stage: number;
  toneProfile: ToneProfile;
  hasCustomerName: boolean;
  validationErrors?: string[];
}): { system: string; user: string } {
  const { stage, toneProfile, hasCustomerName, validationErrors } = params;

  const stageInstructions =
    stage <= 3
      ? 'Stage: Day 3 (3 days past due). Intent: Friendly nudge. Assume the invoice simply slipped through the cracks during a busy week.'
      : stage <= 7
        ? 'Stage: Day 7 (1 week past due). Intent: Clear and polite follow-up. Restate the amount and payment link clearly, and offer to help if anything on the invoice needs clarification.'
        : 'Stage: Day 14 (2 weeks past due). Intent: Firm but respectful. Ask for a quick reply confirming when payment will be scheduled or if there is a blocker.';

  const system = `You write overdue invoice follow-up emails on behalf of a startup founder, matching their exact writing style.
Return ONLY a raw JSON object with keys "subject" and "body". Do not wrap in markdown code blocks.

CRITICAL SAFETY & PLACEHOLDER RULES (ZERO HALLUCINATION):
1. You MUST NOT invent or write any numbers, digits (0-9), dollar/currency signs ($, €, £, ¥), dates, or URLs.
2. Every factual value MUST use these exact placeholders:
   - {{amount}} (REQUIRED in body)
   - {{due_date}} (REQUIRED in body)
   - {{pay_link}} (REQUIRED in body)
   - {{invoice_number}} (Optional in subject and body)
   - {{customer_first_name}} (${hasCustomerName ? 'Use in greeting' : 'DO NOT use because customer name is unknown; use a generic greeting in the founder style'})
   - {{sender_name}} (REQUIRED at the very end after the sign-off)
3. NEVER write any digits (0, 1, 2, 3, 4, 5, 6, 7, 8, 9) anywhere outside placeholders. If you mention a time period, spell it out in words (e.g., "a few days", "a week", "two weeks").
4. NEVER use legal threats, collections language, late fee threats, or service suspension threats.
5. Keep subject between 15 and 110 characters, and body between 80 and 900 characters.`;

  const retryWarning =
    validationErrors && validationErrors.length > 0
      ? `\n\nYOUR PREVIOUS DRAFT WAS REJECTED FOR THESE REASONS:\n- ${validationErrors.join('\n- ')}\nFix every issue above while strictly obeying all placeholder rules.`
      : '';

  const user = `FOUNDER TONE PROFILE:
${JSON.stringify(toneProfile, null, 2)}

REMINDER STAGE & INTENT:
${stageInstructions}

Return JSON: { "subject": "...", "body": "..." }${retryWarning}`;

  return { system, user };
}