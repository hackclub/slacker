import { Client } from "@elastic/elasticsearch";
import { ActionStatus } from "@prisma/client";
import dayjs from "dayjs";
import { config } from "dotenv";
import prisma from "./db";
import { getDisplayName } from "./octokit";
import { ElasticDocument } from "./types";
import { MAINTAINERS, getProject } from "./utils";
config();

export const elastic = new Client({
  node: process.env.ELASTIC_NODE || "https://localhost:9200",
  auth: { apiKey: process.env.ELASTIC_API_TOKEN || "" },
  tls: { rejectUnauthorized: false },
});

export const indexDocument = async (id: string, data?: ElasticDocument) => {
  try {
    const item = await prisma.actionItem.findUnique({
      where: { id },
      include: {
        slackMessage: { include: { channel: true, author: true } },
        githubItem: { include: { repository: true, author: true } },
        assignee: true,
        snoozedBy: true,
        participants: { select: { user: true } },
      },
    });

    if (!item) return;

    const doc = await elastic
      .get<ElasticDocument>({ id: item.id, index: "search-slacker-analytics" })
      .then((res) => res)
      .catch(() => undefined);

    const participants: ElasticDocument["actors"] = (doc?._source?.actors ?? []).filter(
      (p) =>
        item.participants.findIndex(
          ({ user }) => p.github === user.githubUsername || p.slack === user.slackId
        ) !== -1
    );

    for (let i = 0; i < item.participants.length; i++) {
      const { user } = item.participants[i];

      const maintainer = MAINTAINERS.find(
        (maintainer) =>
          maintainer.github === user.githubUsername || maintainer.slack === user.slackId
      );

      if (maintainer) {
        participants.push({
          displayName: maintainer.id,
          github: maintainer.github,
          slack: maintainer.slack,
        });
      } else {
        const displayName = await getDisplayName({
          owner: item.githubItem?.repository.owner ?? "",
          name: item.githubItem?.repository.name ?? "",
          github: user.githubUsername ?? undefined,
          slackId: user.slackId ?? undefined,
        });

        participants.push({ displayName, github: user.githubUsername, slack: user.slackId });
      }
    }

    if (item.snoozedBy) {
      const snoozedBy = participants.find(
        (actor) =>
          actor.slack === item.snoozedBy?.slackId || actor.github === item.snoozedBy?.githubUsername
      );

      if (!snoozedBy) {
        const displayName = await getDisplayName({
          owner: item.githubItem?.repository.owner ?? "",
          name: item.githubItem?.repository.name ?? "",
          github: item.snoozedBy.githubUsername ?? undefined,
          slackId: item.snoozedBy.slackId ?? undefined,
        });

        participants.push({
          displayName,
          github: item.snoozedBy.githubUsername,
          slack: item.snoozedBy.slackId,
        });
      }
    }

    if (item.assignee) {
      const assignee = participants.find(
        (actor) =>
          actor.slack === item.assignee?.slackId || actor.github === item.assignee?.githubUsername
      );

      if (!assignee) {
        const displayName = await getDisplayName({
          owner: item.githubItem?.repository.owner ?? "",
          name: item.githubItem?.repository.name ?? "",
          github: item.assignee.githubUsername ?? undefined,
          slackId: item.assignee.slackId ?? undefined,
        });

        participants.push({
          displayName,
          github: item.assignee.githubUsername,
          slack: item.assignee.slackId,
        });
      }
    }

    await elastic.index<ElasticDocument>({
      id: item.id,
      index: "search-slacker-analytics",
      document: {
        id: item.id,
        actionItemType: item.slackMessage
          ? "message"
          : item.githubItem?.type === "issue"
          ? "issue"
          : "pull",
        createdTime: item.slackMessage?.createdAt ?? item.githubItem?.createdAt ?? item.createdAt,
        firstResponseTime: item.firstReplyOn,
        state:
          item.snoozedUntil && dayjs(item.snoozedUntil).isAfter(dayjs())
            ? "snoozed"
            : item.status === ActionStatus.closed
            ? item.slackMessage
              ? "resolved"
              : "triaged"
            : "open",
        lastModifiedTime:
          item.lastReplyOn ??
          item.slackMessage?.updatedAt ??
          item.githubItem?.updatedAt ??
          item.updatedAt,
        project:
          getProject({
            channelId: item.slackMessage?.channel.slackId,
            repoUrl: item.githubItem?.repository.url,
          }) ?? "",
        snoozedUntil: item.snoozedUntil,
        timesCommented: item.totalReplies,
        timesReopened: (doc?._source?.timesReopened ?? 0) + (data?.timesReopened ?? 0),
        timesResolved: (doc?._source?.timesResolved ?? 0) + (data?.timesResolved ?? 0),
        timesAssigned: (doc?._source?.timesAssigned ?? 0) + (data?.timesAssigned ?? 0),
        timesSnoozed: item.snoozeCount,
        actors: participants,
        assignee: participants.find(
          (actor) =>
            actor.slack === item.assignee?.slackId || actor.github === item.assignee?.githubUsername
        ),
        author: participants.find(
          (actor) =>
            actor.slack === (item.slackMessage || item.githubItem)?.author.slackId ||
            actor.github === (item.slackMessage || item.githubItem)?.author.githubUsername
        ),
      },
    });
  } catch (err) {
    console.error(err);
  }
};
