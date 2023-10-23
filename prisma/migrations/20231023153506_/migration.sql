/*
  Warnings:

  - The values [ongoing,resolved,irrelevant] on the enum `ActionStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `project` on the `ActionItem` table. All the data in the column will be lost.
  - You are about to drop the column `resolvedById` on the `ActionItem` table. All the data in the column will be lost.
  - You are about to drop the column `body` on the `GithubItem` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `GithubItem` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[slackId]` on the table `Channel` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[email]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[slackId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `totalReplies` to the `ActionItem` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ExtraFlags" AS ENUM ('irrelevant', 'resolved');

-- AlterEnum
BEGIN;
CREATE TYPE "ActionStatus_new" AS ENUM ('open', 'closed');
ALTER TABLE "ActionItem" ALTER COLUMN "status" TYPE "ActionStatus_new" USING ("status"::text::"ActionStatus_new");
ALTER TYPE "ActionStatus" RENAME TO "ActionStatus_old";
ALTER TYPE "ActionStatus_new" RENAME TO "ActionStatus";
DROP TYPE "ActionStatus_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "ActionItem" DROP CONSTRAINT "ActionItem_githubItemId_fkey";

-- DropForeignKey
ALTER TABLE "ActionItem" DROP CONSTRAINT "ActionItem_resolvedById_fkey";

-- DropForeignKey
ALTER TABLE "ActionItem" DROP CONSTRAINT "ActionItem_slackMessageId_fkey";

-- AlterTable
ALTER TABLE "ActionItem" DROP COLUMN "project",
DROP COLUMN "resolvedById",
ADD COLUMN     "firstReplyOn" TIMESTAMP(3),
ADD COLUMN     "flag" "ExtraFlags",
ADD COLUMN     "lastReplyOn" TIMESTAMP(3),
ADD COLUMN     "totalReplies" INTEGER NOT NULL,
ALTER COLUMN "slackMessageId" DROP NOT NULL,
ALTER COLUMN "githubItemId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "GithubItem" DROP COLUMN "body",
DROP COLUMN "title";

-- AlterTable
ALTER TABLE "SlackMessage" ALTER COLUMN "ts" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ActionItem_slackMessageId_idx" ON "ActionItem"("slackMessageId");

-- CreateIndex
CREATE INDEX "ActionItem_githubItemId_idx" ON "ActionItem"("githubItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_slackId_key" ON "Channel"("slackId");

-- CreateIndex
CREATE INDEX "GithubItem_repositoryId_idx" ON "GithubItem"("repositoryId");

-- CreateIndex
CREATE INDEX "GithubItem_authorId_idx" ON "GithubItem"("authorId");

-- CreateIndex
CREATE INDEX "Repository_id_idx" ON "Repository"("id");

-- CreateIndex
CREATE INDEX "SlackMessage_channelId_idx" ON "SlackMessage"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_slackId_key" ON "User"("slackId");

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_slackMessageId_fkey" FOREIGN KEY ("slackMessageId") REFERENCES "SlackMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_githubItemId_fkey" FOREIGN KEY ("githubItemId") REFERENCES "GithubItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
