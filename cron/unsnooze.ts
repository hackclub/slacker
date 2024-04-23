import dayjs from "dayjs";
import { slack } from "..";
import prisma from "../lib/db";

// Runs every day at 12:00 AM
export const unsnoozeCron = async () => {
  console.log("⏳⏳ Running unsnooze cron job ⏳⏳");
  try {
    const items = await prisma.actionItem.findMany({
      where: { snoozedUntil: { not: null }, status: "open" },
      include: {
        snoozedBy: true,
        assignee: true,
        githubItems: { select: { repository: true, number: true } },
        slackMessages: { select: { channel: true, ts: true } },
      },
    });

    for await (const item of items) {
      const snoozedUntil = dayjs(item.snoozedUntil);
      const now = dayjs();
      const diff = now.diff(snoozedUntil, "hour", true).toFixed(2);

      if (snoozedUntil.isAfter(now) || parseFloat(diff) >= 1) continue;

      const url =
        item.githubItems.length > 0
          ? `${item.githubItems.at(-1)?.repository.url}/issues/${item.githubItems.at(-1)?.number}`
          : `https://hackclub.slack.com/archives/${
              item.slackMessages.at(-1)?.channel?.slackId
            }/p${item.slackMessages.at(-1)?.ts.replace(".", "")}`;

      await slack.client.chat.postMessage({
        channel: item.snoozedBy?.slackId ?? "",
        text: `:wave: Hey, we unsnoozed <${url}|${item.id}> for you. Feel free to pick it up again!`,
      });
    }
  } catch (err) {
    console.log("🚨🚨 Error in unsnooze cron job 🚨🚨");
    console.error(err);
  }
};