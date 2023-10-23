-- DropForeignKey
ALTER TABLE "ActionItem" DROP CONSTRAINT "ActionItem_githubItemId_fkey";

-- DropForeignKey
ALTER TABLE "ActionItem" DROP CONSTRAINT "ActionItem_slackMessageId_fkey";

-- DropForeignKey
ALTER TABLE "GithubItem" DROP CONSTRAINT "GithubItem_authorId_fkey";

-- DropForeignKey
ALTER TABLE "GithubItem" DROP CONSTRAINT "GithubItem_repositoryId_fkey";

-- DropForeignKey
ALTER TABLE "SlackMessage" DROP CONSTRAINT "SlackMessage_authorId_fkey";

-- DropForeignKey
ALTER TABLE "SlackMessage" DROP CONSTRAINT "SlackMessage_channelId_fkey";

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
