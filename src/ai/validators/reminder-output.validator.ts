import {
  PlaceholderFacts,
  RawAiReminderDraft,
} from '../interfaces/tone-profile.interface';

export const REQUIRED_BODY_PLACEHOLDERS = [
  '{{amount}}',
  '{{due_date}}',
  '{{pay_link}}',
] as const;

export const ALLOWED_PLACEHOLDERS = new Set<string>([
  '{{amount}}',
  '{{due_date}}',
  '{{pay_link}}',
  '{{invoice_number}}',
  '{{customer_first_name}}',
  '{{sender_name}}',
]);

const PROHIBITED_THREAT_PATTERNS: RegExp[] = [
  /\bcollections?\b/i,
  /\blawsuit\b/i,
  /\blegal\s+action\b/i,
  /\battorneys?\b/i,
  /\blawyers?\b/i,
  /\bcourt\b/i,
  /\bcredit\s+(bureau|report|score)\b/i,
  /\bpenalt(y|ies)\b/i,
  /\blate\s+fees?\b/i,
  /\binterest\s+charges?\b/i,
  /\bsuspend(ed|ing)?\b/i,
  /\bterminat(e|ed|ing)\b/i,
  /\bbreach\s+of\s+contract\b/i,
  /\bfinal\s+(notice|demand|warning)\b/i,
  /\bdemand\s+letter\b/i,
];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateAiReminderDraft(
  draft: RawAiReminderDraft,
  options: { allowCustomerFirstName: boolean } = { allowCustomerFirstName: true },
): ValidationResult {
  const errors: string[] = [];

  if (!draft || typeof draft.subject !== 'string' || typeof draft.body !== 'string') {
    return {
      valid: false,
      errors: ['Output must contain string fields "subject" and "body"'],
    };
  }

  const subject = draft.subject.trim();
  const body = draft.body.trim();

  // 1. Length boundaries
  if (subject.length < 10 || subject.length > 140) {
    errors.push(`Subject length (${subject.length}) must be between 10 and 140 characters`);
  }
  if (body.length < 60 || body.length > 1500) {
    errors.push(`Body length (${body.length}) must be between 60 and 1500 characters`);
  }

  // 2. Required placeholders in body
  for (const reqPlaceholder of REQUIRED_BODY_PLACEHOLDERS) {
    if (!body.includes(reqPlaceholder)) {
      errors.push(`Missing required placeholder ${reqPlaceholder} in body`);
    }
  }

  // 3. Check all {{...}} tokens against allowlist
  const combined = `${subject}\n${body}`;
  const foundPlaceholders = combined.match(/\{\{[^{}]+\}\}/g) ?? [];
  for (const token of foundPlaceholders) {
    if (!ALLOWED_PLACEHOLDERS.has(token)) {
      errors.push(`Unknown or disallowed placeholder detected: ${token}`);
    }
    if (
      token === '{{customer_first_name}}' &&
      !options.allowCustomerFirstName
    ) {
      errors.push(
        'Placeholder {{customer_first_name}} used when customer has no name on file',
      );
    }
  }

  // Check for broken/unbalanced curly braces after removing valid {{...}}
  const stripped = combined.replace(/\{\{[a-z_]+\}\}/g, '');
  if (stripped.includes('{') || stripped.includes('}')) {
    errors.push('Malformed curly braces detected in draft');
  }

  // 4. Zero-hallucination check: NO digits or currency symbols allowed outside placeholders
  if (/\d/.test(stripped)) {
    errors.push(
      'Raw digits (0-9) detected outside placeholders; all amounts, dates, and invoice numbers must use placeholders',
    );
  }
  if (/[$€£¥₹]/.test(stripped)) {
    errors.push(
      'Currency symbols ($, €, £, ¥, ₹) detected outside {{amount}} placeholder',
    );
  }

  // 5. No raw links outside {{pay_link}}
  if (/https?:\/\/|www\./i.test(stripped)) {
    errors.push('Raw URL detected outside {{pay_link}} placeholder');
  }

  // 6. Prohibited threats, legal, or collections language
  for (const pattern of PROHIBITED_THREAT_PATTERNS) {
    if (pattern.test(stripped)) {
      errors.push(
        `Prohibited threatening or collections language matched: ${pattern.source}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Safely substitutes verified database facts into the validated template.
 */
export function interpolatePlaceholders(
  draft: RawAiReminderDraft,
  facts: PlaceholderFacts,
): { subject: string; text: string } {
  const replaceAllTokens = (input: string): string =>
    input
      .replace(/\{\{amount\}\}/g, facts.amount)
      .replace(/\{\{due_date\}\}/g, facts.due_date)
      .replace(/\{\{pay_link\}\}/g, facts.pay_link)
      .replace(/\{\{invoice_number\}\}/g, facts.invoice_number)
      .replace(/\{\{customer_first_name\}\}/g, facts.customer_first_name)
      .replace(/\{\{sender_name\}\}/g, facts.sender_name);

  return {
    subject: replaceAllTokens(draft.subject.trim()),
    text: replaceAllTokens(draft.body.trim()),
  };
}

/**
 * Wraps the interpolated plain-text email with an unsubscribe footer and HTML layout.
 */
export function formatFinalAiEmail(
  interpolated: { subject: string; text: string },
  payLink: string,
  unsubscribeUrl: string,
): { subject: string; text: string; html: string } {
  const footerText = `\n\n---\nAlready paid or prefer not to receive automated invoice reminders? Opt out here: ${unsubscribeUrl}`;
  const fullText = `${interpolated.text}${footerText}`;

  const escapedPayLink = escapeHtml(payLink);
  const htmlParagraphs = interpolated.text
    .split(/\n{2,}/)
    .map((para) => {
      const escaped = escapeHtml(para.trim()).replace(/\n/g, '<br />');
      const withClickableLink = escaped.replace(
        escapedPayLink,
        `<a href="${payLink}" style="color: #2563eb; text-decoration: underline;">${escapedPayLink}</a>`,
      );
      return `<p style="margin: 0 0 16px 0; line-height: 1.6; color: #1f2937;">${withClickableLink}</p>`;
    })
    .join('');

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 580px; margin: 0 auto; font-size: 15px;">
  ${htmlParagraphs}
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0 16px 0;" />
  <p style="font-size: 12px; color: #6b7280; line-height: 1.5;">
    Already paid or don't want automated reminders for this account?
    <a href="${unsubscribeUrl}" style="color: #6b7280; text-decoration: underline;">Unsubscribe from reminders</a>.
  </p>
</div>`.trim();

  return {
    subject: interpolated.subject,
    text: fullText,
    html,
  };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}