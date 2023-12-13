import { Client } from "@elastic/elasticsearch";
import { ActionStatus } from "@prisma/client";
import dayjs from "dayjs";
import { config } from "dotenv";
import prisma from "./db";
import { getDisplayName } from "./octokit";
import { ElasticDocument } from "./types";
import { MAINTAINERS, getProjectName } from "./utils";
import metrics from "./metrics";
config();

export const elastic = new Client({
  node: process.env.ELASTIC_NODE || "https://localhost:9200",
  auth: { apiKey: process.env.ELASTIC_API_TOKEN || "" },
  tls: { rejectUnauthorized: false },
});

const INDEX_NAME = "search-slacker-analytics";

const getParticipant = async (user, item) => {
  const maintainer = MAINTAINERS.find(
    (maintainer) => maintainer.github === user.githubUsername || maintainer.slack === user.slackId
  );

  if (maintainer) {
    return {
      displayName: maintainer.id,
      github: maintainer.github,
      slack: maintainer.slack,
    };
  } else {
    const displayName = await getDisplayName({
      owner: item.githubItem?.repository.owner ?? "",
      name: item.githubItem?.repository.name ?? "",
      github: user.githubUsername ?? undefined,
      slackId: user.slackId ?? undefined,
    });

    return { displayName, github: user.githubUsername, slack: user.slackId };
  }
};

const getActor = async (actor, item) => {
  const displayName = await getDisplayName({
    owner: item.githubItem?.repository.owner ?? "",
    name: item.githubItem?.repository.name ?? "",
    github: actor.githubUsername ?? undefined,
    slackId: actor.slackId ?? undefined,
  });

  return {
    displayName,
    github: actor.githubUsername,
    slack: actor.slackId,
  };
};

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
      .get<ElasticDocument>({ id: item.id, index: INDEX_NAME })
      .then((res) => res)
      .catch(() => undefined);

    const project = getProjectName({
      channelId: item.slackMessage?.channel.slackId,
      repoUrl: item.githubItem?.repository.url,
    });

    if (!project) return;

    let participants: ElasticDocument["actors"] = (doc?._source?.actors ?? []).filter(
      (p) =>
        item.participants.findIndex(
          ({ user }) => p.github === user.githubUsername || p.slack === user.slackId
        ) !== -1
    );

    participants = await Promise.all(
      item.participants.map(({ user }) => getParticipant(user, item))
    );

    if (item.snoozedBy) {
      const snoozedBy = participants.find(
        (actor) =>
          actor.slack === item.snoozedBy?.slackId || actor.github === item.snoozedBy?.githubUsername
      );

      if (!snoozedBy) {
        participants.push(await getActor(item.snoozedBy, item));
      }
    }

    if (item.assignee) {
      const assignee = participants.find(
        (actor) =>
          actor.slack === item.assignee?.slackId || actor.github === item.assignee?.githubUsername
      );

      if (!assignee) {
        participants.push(await getActor(item.assignee, item));
      }
    }

    let timesAssigned = (doc?._source?.timesAssigned ?? 0) + (data?.timesAssigned ?? 0);
    timesAssigned = timesAssigned === 0 && item.assignee ? 1 : timesAssigned;

    const createdAt =
      item.githubItem?.createdAt || dayjs(item.slackMessage?.ts?.split(".")[0], "X").toDate();

    await elastic.index<ElasticDocument>({
      id: item.id,
      timeout: "1m",
      index: "search-slacker-analytics",
      document: {
        id: item.id,
        actionItemType: item.slackMessage
          ? "message"
          : item.githubItem?.type === "issue"
          ? "issue"
          : "pull",
        createdTime: createdAt ?? item.createdAt,
        resolvedTime: item.resolvedAt,
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
        project,
        source: item.githubItem
          ? item.githubItem?.repository.owner + "/" + item.githubItem?.repository.name
          : `#${item.slackMessage?.channel.name}`,
        snoozedUntil: item.snoozedUntil,
        timesCommented: item.totalReplies,
        timesReopened: (doc?._source?.timesReopened ?? 0) + (data?.timesReopened ?? 0),
        timesResolved: (doc?._source?.timesResolved ?? 0) + (data?.timesResolved ?? 0),
        timesAssigned,
        timesSnoozed: item.snoozeCount,
        firstResponseTimeInS: item.firstReplyOn
          ? dayjs(item.firstReplyOn).diff(createdAt, "seconds")
          : null,
        resolutionTimeInS: item.resolvedAt
          ? dayjs(item.resolvedAt).diff(createdAt, "seconds")
          : null,
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
        url: item.githubItem
          ? `https://github.com/${item.githubItem?.repository?.owner}/${item.githubItem?.repository?.name}/issues/${item.githubItem?.number}`
          : `https://hackclub.slack.com/archives/${
              item.slackMessage?.channel.slackId
            }/p${item.slackMessage?.ts.replace(".", "")}`,
      },
    });
  } catch (err) {
    metrics.increment("errors.elastic.index", 1);
    console.error(err);
  }
};
