import { Job, Queue } from 'bullmq';
import { RemindersProcessor, ReminderJobData } from './reminders.processor';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { InvoicesService } from '../invoices/invoices.service';
import { MailService } from '../mail/mail.service';
import { AiService } from '../ai/ai.service';
import { SchedulerService } from './scheduler.service';
import { MetricsService } from '../observability/metrics.service';
import { AlertService } from '../observability/alert.service';
import { AuditService } from '../observability/audit.service';
import { ReminderStatus, InvoiceStatus } from '../../generated/prisma/client';

describe('RemindersProcessor', () => {
  let processor: RemindersProcessor;
  let prisma: PrismaService;
  let stripeService: StripeService;
  let invoicesService: InvoicesService;
  let mailService: MailService;
  let aiService: AiService;
  let schedulerService: SchedulerService;
  let metricsService: MetricsService;
  let alertService: AlertService;
  let auditService: AuditService;
  let dlqQueue: Queue;

  beforeEach(() => {
    prisma = {
      reminder: {
        findUnique: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
    } as unknown as PrismaService;

    stripeService = {
      fetchLiveInvoice: jest.fn(),
    } as unknown as StripeService;

    invoicesService = {
      upsertFromStripe: jest.fn(),
    } as unknown as InvoicesService;

    mailService = {
      isSuppressed: jest.fn().mockResolvedValue(false),
      generateUnsubscribeUrl: jest.fn().mockReturnValue('https://example.com/unsub'),
      sendReminderEmail: jest.fn().mockResolvedValue({ resendEmailId: 're_mock_test' }),
    } as unknown as MailService;

    aiService = {
      generateReminderEmail: jest.fn().mockResolvedValue({
        subject: 'Reminder',
        text: 'Please pay',
        html: '<p>Please pay</p>',
        usedFallback: false,
      }),
    } as unknown as AiService;

    schedulerService = {
      cancelForInvoice: jest.fn().mockResolvedValue(undefined),
    } as unknown as SchedulerService;

    metricsService = {
      remindersTotal: { inc: jest.fn() },
      aiValidationFailuresTotal: { inc: jest.fn() },
    } as unknown as MetricsService;

    alertService = {
      triggerAlert: jest.fn().mockResolvedValue(undefined),
    } as unknown as AlertService;

    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;

    dlqQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue;

    processor = new RemindersProcessor(
      prisma,
      stripeService,
      invoicesService,
      mailService,
      aiService,
      schedulerService,
      metricsService,
      alertService,
      auditService,
      dlqQueue,
    );
  });

  const mockReminder = {
    id: 'rem_1',
    stage: 3,
    status: ReminderStatus.SCHEDULED,
    invoice: {
      id: 'inv_1',
      stripeInvoiceId: 'in_123',
      customerEmail: 'buyer@test.com',
      customerName: 'Buyer',
      amountDue: 5000,
      currency: 'usd',
      dueDate: new Date(),
      status: InvoiceStatus.OPEN,
      hostedInvoiceUrl: 'https://stripe.com/pay',
      account: {
        id: 'acct_1',
        senderName: 'Seller',
        senderEmail: 'seller@test.com',
        approvalMode: false,
        toneProfile: null,
      },
    },
  };

  const mockJob = {
    data: { reminderId: 'rem_1', invoiceId: 'inv_1', stage: 3 },
  } as unknown as Job<ReminderJobData>;

  it('skips email when customer email is suppressed', async () => {
    (prisma.reminder.findUnique as jest.Mock).mockResolvedValue(mockReminder);
    (mailService.isSuppressed as jest.Mock).mockResolvedValue(true);

    await processor.process(mockJob);

    expect(schedulerService.cancelForInvoice).toHaveBeenCalledWith(
      'inv_1',
      'Customer email is on suppression list',
    );
    expect(mailService.sendReminderEmail).not.toHaveBeenCalled();
  });

  it('cancels reminders when live Stripe check reveals invoice is already PAID', async () => {
    (prisma.reminder.findUnique as jest.Mock).mockResolvedValue(mockReminder);
    (stripeService.fetchLiveInvoice as jest.Mock).mockResolvedValue({
      id: 'in_123',
      status: 'paid',
    });
    (invoicesService.upsertFromStripe as jest.Mock).mockResolvedValue({
      invoice: { status: InvoiceStatus.PAID },
    });

    await processor.process(mockJob);

    expect(schedulerService.cancelForInvoice).toHaveBeenCalledWith(
      'inv_1',
      'Live Stripe re-check returned status PAID',
    );
    expect(mailService.sendReminderEmail).not.toHaveBeenCalled();
  });

  it('moves reminder to PENDING_APPROVAL when account is in approval mode', async () => {
    const approvalReminder = {
      ...mockReminder,
      invoice: {
        ...mockReminder.invoice,
        account: {
          ...mockReminder.invoice.account,
          approvalMode: true,
        },
      },
    };

    (prisma.reminder.findUnique as jest.Mock).mockResolvedValue(approvalReminder);
    (stripeService.fetchLiveInvoice as jest.Mock).mockResolvedValue({
      id: 'in_123',
      status: 'open',
    });
    (invoicesService.upsertFromStripe as jest.Mock).mockResolvedValue({
      invoice: { status: InvoiceStatus.OPEN },
    });
    (prisma.reminder.count as jest.Mock).mockResolvedValue(0);

    await processor.process(mockJob);

    expect(prisma.reminder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rem_1' },
        data: expect.objectContaining({
          status: ReminderStatus.PENDING_APPROVAL,
        }),
      }),
    );
    expect(mailService.sendReminderEmail).not.toHaveBeenCalled();
  });

  it('sends email and marks reminder SENT in normal mode', async () => {
    (prisma.reminder.findUnique as jest.Mock).mockResolvedValue(mockReminder);
    (stripeService.fetchLiveInvoice as jest.Mock).mockResolvedValue({
      id: 'in_123',
      status: 'open',
    });
    (invoicesService.upsertFromStripe as jest.Mock).mockResolvedValue({
      invoice: { status: InvoiceStatus.OPEN },
    });
    (prisma.reminder.count as jest.Mock).mockResolvedValue(0);

    await processor.process(mockJob);

    expect(mailService.sendReminderEmail).toHaveBeenCalled();
    expect(prisma.reminder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rem_1' },
        data: expect.objectContaining({
          status: ReminderStatus.SENT,
          resendEmailId: 're_mock_test',
        }),
      }),
    );
  });
});
