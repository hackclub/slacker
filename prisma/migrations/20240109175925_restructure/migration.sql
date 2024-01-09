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
    "id" TEXT NOT NULL,
    "githubUsername" TEXT,
    "email" TEXT,
    "githubToken" TEXT,
    "slackId" TEXT,
    "optOut" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlackMessage" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "ts" TEXT NOT NULL,
    "replies" INTEGER NOT NULL DEFAULT 0,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "actionItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlackMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubItem" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "number" INTEGER NOT NULL,
    "nodeId" TEXT NOT NULL,
    "state" "GithubState" NOT NULL,
    "type" "GithubItemType" NOT NULL,
    "actionItemId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "lastAssignedOn" TIMESTAMP(3),
    "lastPromptedOn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionItem" (
    "id" TEXT NOT NULL,
    "firstReplyOn" TIMESTAMP(3),
    "lastReplyOn" TIMESTAMP(3),
    "totalReplies" INTEGER NOT NULL,
    "snoozeCount" INTEGER NOT NULL DEFAULT 0,
    "snoozedUntil" TIMESTAMP(3),
    "snoozedById" TEXT,
    "assigneeId" TEXT,
    "assignedOn" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "status" "ActionStatus" NOT NULL,
    "flag" "ExtraFlags",
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "actionItemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("actionItemId","userId")
);

-- CreateTable
CREATE TABLE "VolunteerDetail" (
    "id" TEXT NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "assignedOn" TIMESTAMP(3) NOT NULL,
    "issueId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slackId" TEXT NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participant" (
    "userId" TEXT NOT NULL,
    "actionItemId" TEXT NOT NULL,

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("userId","actionItemId")
);

-- CreateTable
CREATE TABLE "LabelsOnItems" (
    "labelId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,

    CONSTRAINT "LabelsOnItems_pkey" PRIMARY KEY ("labelId","itemId")
);

-- CreateTable
CREATE TABLE "Label" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_id_idx" ON "User"("id");

-- CreateIndex
CREATE INDEX "SlackMessage_id_idx" ON "SlackMessage"("id");

-- CreateIndex
CREATE INDEX "SlackMessage_authorId_idx" ON "SlackMessage"("authorId");

-- CreateIndex
CREATE INDEX "SlackMessage_channelId_idx" ON "SlackMessage"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubItem_nodeId_key" ON "GithubItem"("nodeId");

-- CreateIndex
CREATE INDEX "GithubItem_id_idx" ON "GithubItem"("id");

-- CreateIndex
CREATE INDEX "GithubItem_repositoryId_idx" ON "GithubItem"("repositoryId");

-- CreateIndex
CREATE INDEX "GithubItem_authorId_idx" ON "GithubItem"("authorId");

-- CreateIndex
CREATE INDEX "ActionItem_id_idx" ON "ActionItem"("id");

-- CreateIndex
CREATE INDEX "ActionItem_snoozedById_idx" ON "ActionItem"("snoozedById");

-- CreateIndex
CREATE INDEX "FollowUp_actionItemId_idx" ON "FollowUp"("actionItemId");

-- CreateIndex
CREATE INDEX "FollowUp_userId_idx" ON "FollowUp"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerDetail_issueId_key" ON "VolunteerDetail"("issueId");

-- CreateIndex
CREATE INDEX "VolunteerDetail_id_idx" ON "VolunteerDetail"("id");

-- CreateIndex
CREATE INDEX "VolunteerDetail_assigneeId_idx" ON "VolunteerDetail"("assigneeId");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_slackId_key" ON "Channel"("slackId");

-- CreateIndex
CREATE INDEX "Channel_id_idx" ON "Channel"("id");

-- CreateIndex
CREATE UNIQUE INDEX "Label_name_key" ON "Label"("name");

-- CreateIndex
CREATE INDEX "Label_id_idx" ON "Label"("id");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_url_key" ON "Repository"("url");

-- CreateIndex
CREATE INDEX "Repository_id_idx" ON "Repository"("id");

-- AddForeignKey
ALTER TABLE "SlackMessage" ADD CONSTRAINT "SlackMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackMessage" ADD CONSTRAINT "SlackMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackMessage" ADD CONSTRAINT "SlackMessage_actionItemId_fkey" FOREIGN KEY ("actionItemId") REFERENCES "ActionItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubItem" ADD CONSTRAINT "GithubItem_actionItemId_fkey" FOREIGN KEY ("actionItemId") REFERENCES "ActionItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubItem" ADD CONSTRAINT "GithubItem_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubItem" ADD CONSTRAINT "GithubItem_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_snoozedById_fkey" FOREIGN KEY ("snoozedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_actionItemId_fkey" FOREIGN KEY ("actionItemId") REFERENCES "ActionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerDetail" ADD CONSTRAINT "VolunteerDetail_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerDetail" ADD CONSTRAINT "VolunteerDetail_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "GithubItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_actionItemId_fkey" FOREIGN KEY ("actionItemId") REFERENCES "ActionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelsOnItems" ADD CONSTRAINT "LabelsOnItems_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelsOnItems" ADD CONSTRAINT "LabelsOnItems_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "GithubItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
