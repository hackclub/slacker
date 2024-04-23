import dayjs from "dayjs";
import { slack } from "..";
import prisma from "../lib/db";
import { indexDocument } from "../lib/elastic";

// Runs every day at 12:00 AM
export const unassignCron = async () => {
  console.log("⏳⏳ Running unassign cron job ⏳⏳");

  try {
    const items = await prisma.actionItem
      .findMany({
        where: {
          assigneeId: { not: null },
          assignedOn: { not: null },
          status: "open",
        },
        include: {
          assignee: true,
          githubItems: { select: { repository: true, number: true } },
          slackMessages: { select: { channel: true, ts: true } },
        },
      })
      .then((res) =>
        res.filter(
          (item) => item.snoozedUntil === null || dayjs(item.snoozedUntil).isBefore(dayjs())
        )
      );

    for await (const item of items) {
      const assignedOn = dayjs(item.snoozedUntil || item.assignedOn);
      let deadline = assignedOn;

      let count = 0;
      while (count < 2) {
        deadline = deadline.add(1, "day");
        if (deadline.day() !== 0 && deadline.day() !== 6) count++;
      }

      if (dayjs().isBefore(deadline)) continue;
      await prisma.actionItem.update({ where: { id: item.id }, data: { assigneeId: null } });

      const url =
        item.githubItems.length > 0
          ? `${item.githubItems.at(-1)?.repository.url}/issues/${item.githubItems.at(-1)?.number}`
          : `https://hackclub.slack.com/archives/${
              item.slackMessages.at(-1)?.channel?.slackId
            }/p${item.slackMessages.at(-1)?.ts.replace(".", "")}`;

      await slack.client.chat.postMessage({
        channel: item.assignee?.slackId ?? "",
        text: `:warning: Hey, we unassigned <${url}|${item.id}> from you because you didn't resolve it in time. Feel free to pick it up again!`,
      });

      await indexDocument(item.id);
    }
  } catch (err) {
    console.log("🚨🚨 Error in unassign cron job 🚨🚨");
    console.error(err);
  }
};