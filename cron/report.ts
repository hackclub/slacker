import { ActionStatus } from "@prisma/client";
import dayjs from "dayjs";
import { readdirSync } from "fs";
import { slack } from "..";
import prisma from "../lib/db";
import { MAINTAINERS, getYamlFile } from "../lib/utils";

// Runs every Friday at 12:00 PM
export const reportCron = async () => {
  console.log("⏳⏳ Running status report cron job ⏳⏳");
  try {
    for await (const maintainer of MAINTAINERS) {
      const files = readdirSync("./config");
      let text = `:wave: Hey ${maintainer.id}, here's your weekly status report!`;
      const user = await prisma.user.findFirst({
        where: { OR: [{ slackId: maintainer.slack }, { githubUsername: maintainer.github }] },
      });

      if (!user || user.optOut) continue;

      for await (const file of files) {
        const { maintainers, channels, repos } = getYamlFile(file);
        if (!maintainers.includes(maintainer.id)) continue;

        const items = await prisma.actionItem.findMany({
          where: {
            OR: [
              channels
                ? {
                    slackMessages: {
                      some: {
                        channel: { slackId: { in: channels?.map((c) => c.id) } },
                      },
                    },
                  }
                : {},
              repos
                ? {
                    githubItems: {
                      some: { repository: { url: { in: repos.map((r) => r.uri) } } },
                    },
                  }
                : {},
            ],
          },
          include: { slackMessages: true, githubItems: true, assignee: true },
        });

        const open = items.filter(
          (item) =>
            item.status === "open" &&
            (item.snoozedUntil === null || dayjs(item.snoozedUntil).isBefore(dayjs()))
        );
        const openMessages = open.filter((item) => item.slackMessages.length > 0);
        const openPRs = open.filter(
          (item) => item.githubItems.filter((i) => i.type === "pull_request").length > 0
        );
        const openIssues = open.filter(
          (item) => item.githubItems.filter((i) => i.type === "issue").length > 0
        );

        const closed = items.filter(
          (item) =>
            item.status === ActionStatus.closed &&
            dayjs(item.resolvedAt).isAfter(dayjs().subtract(6, "days"))
        );
        const closedMessages = closed.filter((item) => item.slackMessages.length > 0);
        const closedPRs = closed.filter(
          (item) => item.githubItems.filter((i) => i.type === "pull_request").length > 0
        );
        const closedIssues = closed.filter(
          (item) => item.githubItems.filter((i) => i.type === "issue").length > 0
        );

        const assigned = open.filter((item) => item.assigneeId !== null);
        const contributors = Array.from(
          new Set(
            assigned.map(
              (item) =>
                MAINTAINERS.find(
                  (m) =>
                    m.slack === item.assignee?.slackId || m.github === item.assignee?.githubUsername
                )?.id ||
                item.assignee?.githubUsername ||
                item.assignee?.slackId ||
                item.assignee?.email ||
                ""
            )
          )
        );

        text += `\n\nProject: *${file.replace(".yml", "")}*`;
        text += `\nOpen action items: ${open.length} (${openMessages.length} slack messages, ${openPRs.length} pull requests, ${openIssues.length} issues)`;
        text += `\nTriaged this week: ${closed.length} (${closedMessages.length} slack messages, ${closedPRs.length} pull requests, ${closedIssues.length} issues)`;
        text += `\nTotal contributors: ${contributors.length} ${
          contributors.length > 0 ? `(${contributors.join(", ")})` : ""
        }`;
      }

      text += `\n\nYou can opt out of these daily status reports by running \`/slacker opt-out\`.`;
      await slack.client.chat.postMessage({ channel: maintainer.slack, text });
    }
  } catch (err) {
    console.log("🚨🚨 Error in status report cron job 🚨🚨");
    console.error(err);
  }
};
