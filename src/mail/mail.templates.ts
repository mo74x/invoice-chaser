export interface TemplateVariables {
  customerFirstName: string;
  invoiceNumber: string;
  formattedAmount: string;
  formattedDueDate: string;
  payLink: string;
  senderName: string;
  unsubscribeUrl: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function formatMinorUnits(amountMinor: number, currency: string): string {
  const upperCurrency = currency.toUpperCase();
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: upperCurrency,
  });

  // Zero-decimal currencies (e.g., JPY, KRW) have maximumFractionDigits === 0
  const { maximumFractionDigits } = formatter.resolvedOptions();
  const divisor = Math.pow(10, maximumFractionDigits ?? 2);

  return formatter.format(amountMinor / divisor);
}

export function renderFallbackTemplate(
  stage: number,
  vars: TemplateVariables,
): RenderedEmail {
  const {
    customerFirstName,
    invoiceNumber,
    formattedAmount,
    formattedDueDate,
    payLink,
    senderName,
    unsubscribeUrl,
  } = vars;

  const greeting = customerFirstName ? `Hi ${customerFirstName},` : 'Hi there,';

  let subject: string;
  let paragraphs: string[];

  if (stage <= 3) {
    // Stage 3: Friendly nudge, assume it slipped through
    subject = `Quick follow-up on invoice ${invoiceNumber} (${formattedAmount})`;
    paragraphs = [
      greeting,
      `Hope your week is going well! I'm sending a quick note in case invoice ${invoiceNumber} for ${formattedAmount} (due on ${formattedDueDate}) slipped through the cracks.`,
      `Whenever you have a moment, you can view and take care of it right here: ${payLink}`,
      `If you've already sent payment, please disregard this note—and thank you!`,
    ];
  } else if (stage <= 7) {
    // Stage 7: Clear and polite, restate amount and link, offer help
    subject = `Checking in: Invoice ${invoiceNumber} for ${formattedAmount}`;
    paragraphs = [
      greeting,
      `I wanted to follow up on invoice ${invoiceNumber} for ${formattedAmount}, which was due on ${formattedDueDate}.`,
      `You can access the invoice and complete payment directly at this link: ${payLink}`,
      `Please let me know if you need any adjustments to the invoice details or if there's anything I can help clarify.`,
    ];
  } else {
    // Stage 14: Firm but respectful, ask for a reply or a payment date
    subject = `Overdue invoice ${invoiceNumber} (${formattedAmount}) – action needed`;
    paragraphs = [
      greeting,
      `I'm reaching out regarding invoice ${invoiceNumber} for ${formattedAmount}, which was due on ${formattedDueDate} and is now two weeks past due.`,
      `Could you please let me know when we can expect payment, or take care of it today using this link: ${payLink}`,
      `If payment is already on its way, just reply and let me know so I can update our records.`,
    ];
  }

  const signOff = `Best,\n${senderName}`;
  const footerText = `---\nAlready paid or prefer not to receive automated invoice reminders? Opt out here: ${unsubscribeUrl}`;

  const text = `${paragraphs.join('\n\n')}\n\n${signOff}\n\n${footerText}`;

  const htmlParagraphs = paragraphs
    .map(
      (p) =>
        `<p style="margin: 0 0 16px 0; line-height: 1.6; color: #1f2937;">${escapeHtml(p).replace(
          escapeHtml(payLink),
          `<a href="${payLink}" style="color: #2563eb; text-decoration: underline;">View &amp; Pay Invoice</a>`,
        )}</p>`,
    )
    .join('');

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 580px; margin: 0 auto; font-size: 15px;">
  ${htmlParagraphs}
  <p style="margin: 24px 0; line-height: 1.5; color: #1f2937;">
    Best,<br />
    <strong>${escapeHtml(senderName)}</strong>
  </p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0 16px 0;" />
  <p style="font-size: 12px; color: #6b7280; line-height: 1.5;">
    Already paid or don't want automated reminders for this account?
    <a href="${unsubscribeUrl}" style="color: #6b7280; text-decoration: underline;">Unsubscribe from reminders</a>.
  </p>
</div>`.trim();

  return { subject, text, html };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}