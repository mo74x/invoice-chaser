export interface ToneProfile {
  formality: 'casual' | 'balanced' | 'formal';
  greetingStyle: string;
  signOff: string;
  sentenceLength: 'short' | 'medium' | 'long';
  humorLevel: 'none' | 'light' | 'playful';
  warmth: 'direct' | 'warm' | 'empathetic';
  phrasesToUse: string[];
  phrasesToAvoid: string[];
  summary: string;
}

export interface RawAiReminderDraft {
  subject: string;
  body: string;
}

export interface PlaceholderFacts {
  customer_first_name: string;
  invoice_number: string;
  amount: string;
  due_date: string;
  pay_link: string;
  sender_name: string;
}