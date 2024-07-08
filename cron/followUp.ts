import dayjs from "dayjs";
import { slack } from "..";
import { buttons } from "../blocks/buttons";
import { githubItem } from "../blocks/githubItem";
import { slackItem } from "../blocks/slackItem";
import prisma from "../lib/db";

// Runs every day at 12:00 AM
export const followUpCron = async () => {
  console.log("⏳⏳ Running follow up cron job ⏳⏳");
  try {
    const followUps = await prisma.followUp.findMany({
      include: {
        parent: {
          include: {
            githubItems: { include: { author: true, repository: true } },
            slackMessages: { include: { author: true, channel: true } },
            participants: { include: { user: true } },
            assignee: true,
          },
        },
        nextItem: { include: { assignee: true } },
      },
    });

    for await (const followUp of followUps) {
      const now = dayjs();
      const followUpOn = dayjs(followUp.date);
      const diff = parseFloat(now.diff(followUpOn, "hour", true).toFixed(2));

      if (followUpOn.isAfter(now) || diff >= 1) continue;

      const url =
        followUp.parent.githubItems.length > 0
          ? `${followUp.parent.githubItems.at(-1)?.repository.url}/issues/${
              followUp.parent.githubItems.at(-1)?.number
            }`
          : `https://hackclub.slack.com/archives/${
              followUp.parent.slackMessages.at(-1)?.channel?.slackId
            }/p${followUp.parent.slackMessages.at(-1)?.ts.replace(".", "")}`;

      await prisma.followUp.update({
        where: {
          parentId_nextItemId: { parentId: followUp.parentId, nextItemId: followUp.nextItemId },
        },
        data: { nextItem: { update: { status: "open" } } },
      });

      const followUpDuration = dayjs(followUp.date).diff(
        followUp.parent.resolvedAt ?? followUp.createdAt,
        "day"
      );

      await slack.client.chat.postMessage({
        channel: followUp.nextItem.assignee?.slackId ?? "",
        text: `:wave: Hey, you asked us to follow up on <${url}|${followUp.parent.id}>. Take a look at it again!`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:wave: Hey, you asked us to follow up on <${url}|${followUp.parent.id}>. Take a look at it again!`,
            },
          },
          ...(followUp.parent.githubItems.length > 0
            ? [
                githubItem({
                  item: followUp.parent,
                  followUp: { id: followUp.nextItemId, duration: followUpDuration },
                }),
              ]
            : followUp.parent.slackMessages.length > 0
            ? [
                slackItem({
                  item: followUp.parent,
                  followUp: { id: followUp.nextItemId, duration: followUpDuration },
                }),
              ]
            : []),
          ...buttons({
            item: followUp.parent,
            showAssignee: true,
            showActions: true,
            followUpId: followUp.nextItemId,
          }),
        ],
      });
    }
  } catch (err) {
    console.log("🚨🚨 Error in follow up cron job 🚨🚨");
    console.error(err);
  }
};