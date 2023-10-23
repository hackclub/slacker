-- CreateEnum
CREATE TYPE "GithubItemType" AS ENUM ('issue', 'pull_request');

-- CreateEnum
CREATE TYPE "GithubState" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "ExtraFlags" AS ENUM ('irrelevant', 'resolved');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "githubUsername" TEXT,
    "email" TEXT NOT NULL,
    "slackId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlackMessage" (
    "id" SERIAL NOT NULL,
    "text" TEXT NOT NULL,
    "ts" TEXT NOT NULL,
    "channelId" INTEGER NOT NULL,
    "authorId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlackMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubItem" (
    "id" SERIAL NOT NULL,
    "number" INTEGER NOT NULL,
    "nodeId" TEXT NOT NULL,
    "databaseId" BIGINT NOT NULL,
    "state" "GithubState" NOT NULL,
    "type" "GithubItemType" NOT NULL,
    "repositoryId" INTEGER NOT NULL,
    "authorId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionItem" (
    "id" SERIAL NOT NULL,
    "slackMessageId" INTEGER,
    "githubItemId" INTEGER,
    "firstReplyOn" TIMESTAMP(3),
    "lastReplyOn" TIMESTAMP(3),
    "totalReplies" INTEGER NOT NULL,
    "status" "ActionStatus" NOT NULL,
    "flag" "ExtraFlags",
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slackId" TEXT NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participant" (
    "userId" INTEGER NOT NULL,
    "actionItemId" INTEGER NOT NULL,

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("userId","actionItemId")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_id_idx" ON "User"("id");

-- CreateIndex
CREATE INDEX "SlackMessage_id_idx" ON "SlackMessage"("id");

-- CreateIndex
CREATE INDEX "SlackMessage_authorId_idx" ON "SlackMessage"("authorId");

-- CreateIndex
CREATE INDEX "SlackMessage_channelId_idx" ON "SlackMessage"("channelId");

-- CreateIndex
CREATE INDEX "GithubItem_id_idx" ON "GithubItem"("id");

-- CreateIndex
CREATE INDEX "GithubItem_repositoryId_idx" ON "GithubItem"("repositoryId");

-- CreateIndex
CREATE INDEX "GithubItem_authorId_idx" ON "GithubItem"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionItem_slackMessageId_key" ON "ActionItem"("slackMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionItem_githubItemId_key" ON "ActionItem"("githubItemId");

-- CreateIndex
CREATE INDEX "ActionItem_id_idx" ON "ActionItem"("id");

-- CreateIndex
CREATE INDEX "ActionItem_slackMessageId_idx" ON "ActionItem"("slackMessageId");

-- CreateIndex
CREATE INDEX "ActionItem_githubItemId_idx" ON "ActionItem"("githubItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_slackId_key" ON "Channel"("slackId");

-- CreateIndex
CREATE INDEX "Channel_id_idx" ON "Channel"("id");

-- CreateIndex
CREATE INDEX "Repository_id_idx" ON "Repository"("id");

-- AddForeignKey
ALTER TABLE "SlackMessage" ADD CONSTRAINT "SlackMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackMessage" ADD CONSTRAINT "SlackMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubItem" ADD CONSTRAINT "GithubItem_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubItem" ADD CONSTRAINT "GithubItem_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_slackMessageId_fkey" FOREIGN KEY ("slackMessageId") REFERENCES "SlackMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_githubItemId_fkey" FOREIGN KEY ("githubItemId") REFERENCES "GithubItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_actionItemId_fkey" FOREIGN KEY ("actionItemId") REFERENCES "ActionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
