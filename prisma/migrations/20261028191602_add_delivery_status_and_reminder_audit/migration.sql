-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('NONE', 'DELIVERED', 'BOUNCED', 'COMPLAINED');

-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "ReminderAudit" (
    "id" TEXT NOT NULL,
    "reminderId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "event" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReminderAudit_reminderId_createdAt_idx" ON "ReminderAudit"("reminderId", "createdAt");

-- CreateIndex
CREATE INDEX "ReminderAudit_accountId_invoiceId_idx" ON "ReminderAudit"("accountId", "invoiceId");

-- AddForeignKey
ALTER TABLE "ReminderAudit" ADD CONSTRAINT "ReminderAudit_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "Reminder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
