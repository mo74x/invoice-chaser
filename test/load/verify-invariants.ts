import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
    PrismaClient,
    InvoiceStatus,
    ReminderStatus,
} from '../../generated/prisma/client';

async function verifyInvariants() {
    const adapter = new PrismaPg({
        connectionString: process.env.DATABASE_URL,
    });
    const prisma = new PrismaClient({ adapter });

    try {
        console.log('Verifying post-load database invariants...\n');

        // 1. Check total synced invoices & webhook events
        const [invoiceCount, webhookCount, reminderSentCount] = await Promise.all([
            prisma.invoice.count(),
            prisma.webhookEvent.count(),
            prisma.reminder.count({ where: { status: ReminderStatus.SENT } }),
        ]);

        console.log(`Total Invoices synced:       ${invoiceCount}`);
        console.log(`Total Unique Webhooks saved: ${webhookCount}`);
        console.log(`Total Reminders SENT:        ${reminderSentCount}`);

        // 2. Verify zero out-of-order downgrades on race test invoices (in_loadtest_race_*)
        const downgradedRaceInvoices = await prisma.invoice.count({
            where: {
                stripeInvoiceId: { startsWith: 'in_loadtest_race_' },
                status: InvoiceStatus.OPEN,
            },
        });

        if (downgradedRaceInvoices > 0) {
            throw new Error(
                `INVARIANT VIOLATION: ${downgradedRaceInvoices} paid race invoices were downgraded back to OPEN!`,
            );
        }
        console.log(
            'PASS: Out-of-order guard preserved PAID status on all race invoices.',
        );

        // 3. Verify zero SENT reminders on race invoices that were already PAID
        const sentOnPaidRace = await prisma.reminder.count({
            where: {
                status: ReminderStatus.SENT,
                invoice: {
                    stripeInvoiceId: { startsWith: 'in_loadtest_race_' },
                },
            },
        });

        if (sentOnPaidRace > 0) {
            throw new Error(
                `INVARIANT VIOLATION: ${sentOnPaidRace} reminders were sent for already-paid race invoices!`,
            );
        }
        console.log(
            'PASS: Zero reminders sent after payment across all race test invoices.',
        );

        console.log(
            '\nAll load-test safety invariants passed with zero violations!',
        );
    } finally {
        await prisma.$disconnect();
    }
}

verifyInvariants().catch((err) => {
    console.error(err);
    process.exit(1);
});