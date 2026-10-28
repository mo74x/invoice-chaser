import {
  validateAiReminderDraft,
  interpolatePlaceholders,
} from './reminder-output.validator';

describe('ReminderOutputValidator (Adversarial Safety Suite)', () => {
  const validDraft = {
    subject: 'Quick ping on invoice {{invoice_number}}',
    body: 'Hey {{customer_first_name}}!\n\nHope your week is going well. Just following up on invoice {{invoice_number}} for {{amount}}, which was due on {{due_date}}.\n\nYou can take care of it right here: {{pay_link}}\n\nCheers,\n{{sender_name}}',
  };

  it('accepts a clean draft with allowlisted placeholders and zero raw digits', () => {
    const res = validateAiReminderDraft(validDraft);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('rejects a draft that invents a currency amount or raw digits ($500 or 14 days)', () => {
    const res = validateAiReminderDraft({
      subject: validDraft.subject,
      body: `${validDraft.body}\n\nNote: A $50 surcharge applies after 14 days.`,
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Raw digits (0-9) detected'),
        expect.stringContaining('Currency symbols'),
      ]),
    );
  });

  it('rejects a draft missing any required placeholder ({{amount}}, {{due_date}}, {{pay_link}})', () => {
    const res = validateAiReminderDraft({
      subject: 'Checking in on your invoice',
      body: 'Hi {{customer_first_name}}, please pay {{amount}} which was due on {{due_date}}. Thanks, {{sender_name}}',
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain(
      'Missing required placeholder {{pay_link}} in body',
    );
  });

  it('rejects a draft containing legal, collections, or suspension threats', () => {
    const res = validateAiReminderDraft({
      subject: 'Final notice before collections',
      body: 'Hello {{customer_first_name}}, invoice {{invoice_number}} for {{amount}} due {{due_date}} will be referred to our legal action and collections agency unless paid at {{pay_link}}. Regards, {{sender_name}}',
    });
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) => e.includes('Prohibited threatening')),
    ).toBe(true);
  });

  it('rejects unknown/hallucinated placeholders like {{bank_account}}', () => {
    const res = validateAiReminderDraft({
      subject: validDraft.subject,
      body: `${validDraft.body}\nWire to {{bank_account}}`,
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain(
      'Unknown or disallowed placeholder detected: {{bank_account}}',
    );
  });

  it('interpolates database facts cleanly without leaving placeholders behind', () => {
    const interpolated = interpolatePlaceholders(validDraft, {
      customer_first_name: 'Sarah',
      invoice_number: 'INV-2048',
      amount: '$2,400.00',
      due_date: 'Oct 15, 2026',
      pay_link: 'https://invoice.stripe.com/i/acct_123/inv_456',
      sender_name: 'Alex from Acme',
    });

    expect(interpolated.subject).toBe('Quick ping on invoice INV-2048');
    expect(interpolated.text).toContain('$2,400.00');
    expect(interpolated.text).toContain('Oct 15, 2026');
    expect(interpolated.text).toContain(
      'https://invoice.stripe.com/i/acct_123/inv_456',
    );
    expect(interpolated.text).not.toContain('{{');
  });
});