export const REMINDERS_QUEUE = 'reminders';
export const REMINDERS_DLQ_QUEUE = 'reminders-dlq';

export const REMINDER_STAGES = [3, 7, 14] as const;
export type ReminderStage = (typeof REMINDER_STAGES)[number];

export function getReminderJobId(invoiceId: string, stage: number): string {
  return `reminder-${invoiceId}-${stage}`;
}