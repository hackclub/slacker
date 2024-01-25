/*
  Warnings:

  - The primary key for the `FollowUp` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `actionItemId` on the `FollowUp` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `FollowUp` table. All the data in the column will be lost.
  - Added the required column `nextItemId` to the `FollowUp` table without a default value. This is not possible if the table is not empty.
  - Added the required column `parentId` to the `FollowUp` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "ActionStatus" ADD VALUE 'followUp';

-- DropForeignKey
ALTER TABLE "FollowUp" DROP CONSTRAINT "FollowUp_actionItemId_fkey";

-- DropForeignKey
ALTER TABLE "FollowUp" DROP CONSTRAINT "FollowUp_userId_fkey";

-- DropIndex
DROP INDEX "FollowUp_actionItemId_idx";

-- DropIndex
DROP INDEX "FollowUp_userId_idx";

-- AlterTable
ALTER TABLE "FollowUp" DROP CONSTRAINT "FollowUp_pkey",
DROP COLUMN "actionItemId",
DROP COLUMN "userId",
ADD COLUMN     "nextItemId" TEXT NOT NULL,
ADD COLUMN     "parentId" TEXT NOT NULL,
ADD CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("parentId", "nextItemId");

-- CreateIndex
CREATE INDEX "FollowUp_parentId_idx" ON "FollowUp"("parentId");

-- CreateIndex
CREATE INDEX "FollowUp_nextItemId_idx" ON "FollowUp"("nextItemId");

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ActionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_nextItemId_fkey" FOREIGN KEY ("nextItemId") REFERENCES "ActionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
