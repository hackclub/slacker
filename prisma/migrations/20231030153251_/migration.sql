/*
  Warnings:

  - The primary key for the `ActionItem` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `Channel` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `GithubItem` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `Participant` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `Repository` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `SlackMessage` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `User` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- DropForeignKey
ALTER TABLE "ActionItem" DROP CONSTRAINT "ActionItem_githubItemId_fkey";

-- DropForeignKey
ALTER TABLE "ActionItem" DROP CONSTRAINT "ActionItem_slackMessageId_fkey";

-- DropForeignKey
ALTER TABLE "GithubItem" DROP CONSTRAINT "GithubItem_authorId_fkey";

-- DropForeignKey
ALTER TABLE "GithubItem" DROP CONSTRAINT "GithubItem_repositoryId_fkey";

-- DropForeignKey
ALTER TABLE "Participant" DROP CONSTRAINT "Participant_actionItemId_fkey";

-- DropForeignKey
ALTER TABLE "Participant" DROP CONSTRAINT "Participant_userId_fkey";

-- DropForeignKey
ALTER TABLE "SlackMessage" DROP CONSTRAINT "SlackMessage_authorId_fkey";

-- DropForeignKey
ALTER TABLE "SlackMessage" DROP CONSTRAINT "SlackMessage_channelId_fkey";

-- AlterTable
ALTER TABLE "ActionItem" DROP CONSTRAINT "ActionItem_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "slackMessageId" SET DATA TYPE TEXT,
ALTER COLUMN "githubItemId" SET DATA TYPE TEXT,
ADD CONSTRAINT "ActionItem_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "ActionItem_id_seq";

-- AlterTable
ALTER TABLE "Channel" DROP CONSTRAINT "Channel_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "Channel_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Channel_id_seq";

-- AlterTable
ALTER TABLE "GithubItem" DROP CONSTRAINT "GithubItem_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "repositoryId" SET DATA TYPE TEXT,
ALTER COLUMN "authorId" SET DATA TYPE TEXT,
ADD CONSTRAINT "GithubItem_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "GithubItem_id_seq";

-- AlterTable
ALTER TABLE "Participant" DROP CONSTRAINT "Participant_pkey",
ALTER COLUMN "userId" SET DATA TYPE TEXT,
ALTER COLUMN "actionItemId" SET DATA TYPE TEXT,
ADD CONSTRAINT "Participant_pkey" PRIMARY KEY ("userId", "actionItemId");

-- AlterTable
ALTER TABLE "Repository" DROP CONSTRAINT "Repository_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "Repository_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Repository_id_seq";

-- AlterTable
ALTER TABLE "SlackMessage" DROP CONSTRAINT "SlackMessage_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "channelId" SET DATA TYPE TEXT,
ALTER COLUMN "authorId" SET DATA TYPE TEXT,
ADD CONSTRAINT "SlackMessage_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "SlackMessage_id_seq";

-- AlterTable
ALTER TABLE "User" DROP CONSTRAINT "User_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "User_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "User_id_seq";

-- AddForeignKey
ALTER TABLE "SlackMessage" ADD CONSTRAINT "SlackMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackMessage" ADD CONSTRAINT "SlackMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubItem" ADD CONSTRAINT "GithubItem_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubItem" ADD CONSTRAINT "GithubItem_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_slackMessageId_fkey" FOREIGN KEY ("slackMessageId") REFERENCES "SlackMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_githubItemId_fkey" FOREIGN KEY ("githubItemId") REFERENCES "GithubItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_actionItemId_fkey" FOREIGN KEY ("actionItemId") REFERENCES "ActionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
