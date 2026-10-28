export const STRIPE_EVENTS_QUEUE = 'stripe-events';

export const SUPPORTED_STRIPE_EVENTS = new Set([
  'invoice.finalized',
  'invoice.paid',
  'invoice.voided',
  'invoice.marked_uncollectible',
  'invoice.payment_failed',
  'account.application.deauthorized',
]);