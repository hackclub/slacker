-- AlterTable
ALTER TABLE "ActionItem" ADD COLUMN     "snoozeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "snoozedById" TEXT,
ADD COLUMN     "snoozedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ActionItem_snoozedById_idx" ON "ActionItem"("snoozedById");

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_snoozedById_fkey" FOREIGN KEY ("snoozedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
