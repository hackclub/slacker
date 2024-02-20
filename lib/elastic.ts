import { Client } from "@elastic/elasticsearch";
import { ActionItem, ActionStatus, User } from "@prisma/client";
import dayjs from "dayjs";
import { config } from "dotenv";
import prisma from "./db";
import { getDisplayName } from "./octokit";
import { ElasticDocument, ItemType, State } from "./types";
import { MAINTAINERS, getProjectName } from "./utils";
import metrics from "./metrics";
config();

export const elastic = new Client({
  node: process.env.ELASTIC_NODE || "https://localhost:9200",
  auth: { apiKey: process.env.ELASTIC_API_TOKEN || "" },
  tls: { rejectUnauthorized: false },
});

const INDEX_NAME = "search-slacker-analytics";

const getParticipant = async (
  user: User,
  item: ActionItem & {
    slackMessages: { channel: { slackId: string }; author: { slackId: string | null } }[];
    githubItems: {
      repository: { owner: string; name: string };
      author: { githubUsername: string | null };
    }[];
  }
) => {
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
      owner: item.githubItems[0]?.repository.owner ?? "",
      name: item.githubItems[0]?.repository.name ?? "",
      github: user.githubUsername ?? undefined,
      slackId: user.slackId ?? undefined,
    });

    return { displayName, github: user.githubUsername, slack: user.slackId };
  }
};

const getActor = async (
  actor: User,
  item: ActionItem & {
    slackMessages: { channel: { slackId: string }; author: { slackId: string | null } }[];
    githubItems: {
      repository: { owner: string; name: string };
      author: { githubUsername: string | null };
    }[];
  }
) => {
  const displayName = await getDisplayName({
    owner: item.githubItems[0]?.repository.owner ?? "",
    name: item.githubItems[0]?.repository.name ?? "",
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
        slackMessages: { include: { channel: true, author: true } },
        githubItems: { include: { repository: true, author: true } },
        parentItems: {
          include: {
            parent: {
              include: {
                slackMessages: { include: { channel: true, author: true } },
                githubItems: { include: { repository: true, author: true } },
              },
            },
          },
        },
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
      item.githubItems[0]?.createdAt ||
      dayjs(item.slackMessages[0]?.ts?.split(".")[0], "X").toDate();

    const isFollowUp = item.parentItems.length > 0;

    if (isFollowUp) {
      const project = getProjectName({
        channelId: item.parentItems[0].parent.slackMessages[0]?.channel.slackId,
        repoUrl: item.parentItems[0].parent.githubItems[0]?.repository.url,
      });

      if (!project) return;

      await elastic.index<ElasticDocument>({
        id: item.id,
        timeout: "1m",
        index: "search-slacker-analytics",
        document: {
          id: item.id,
          actionItemType: ItemType.followUp,
          followUpDuration: dayjs(item.parentItems[0].date).diff(
            item.parentItems[0].parent.resolvedAt ?? item.parentItems[0].createdAt,
            "minutes"
          ),
          followUpTo: item.parentItems[0].parent.id,
          createdTime: createdAt ?? item.createdAt,
          resolvedTime: item.resolvedAt,
          firstResponseTime: item.firstReplyOn,
          reason: item.notes,
          state:
            item.snoozedUntil && dayjs(item.snoozedUntil).isAfter(dayjs())
              ? State.snoozed
              : item.status === ActionStatus.closed
              ? item.slackMessages.length > 0
                ? State.resolved
                : State.triaged
              : State.open,
          lastModifiedTime:
            item.lastReplyOn ??
            item.slackMessages.at(-1)?.updatedAt ??
            item.githubItems[0]?.updatedAt ??
            item.updatedAt,
          project,
          source:
            item.parentItems[0].parent.githubItems.length > 0
              ? item.parentItems[0].parent.githubItems[0].repository.owner +
                "/" +
                item.parentItems[0].parent.githubItems[0].repository.name
              : `#${item.parentItems[0].parent.slackMessages[0].channel.name}`,
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
              actor.slack === item.assignee?.slackId ||
              actor.github === item.assignee?.githubUsername
          ),
          author: participants.find(
            (actor) =>
              actor.slack ===
                (item.parentItems[0].parent.slackMessages.length > 0
                  ? item.parentItems[0].parent.slackMessages
                  : item.parentItems[0].parent.githubItems)[0].author.slackId ||
              actor.github ===
                (item.parentItems[0].parent.slackMessages.length > 0
                  ? item.parentItems[0].parent.slackMessages
                  : item.parentItems[0].parent.githubItems)[0].author.githubUsername
          ),
          url:
            item.parentItems[0].parent.githubItems.length > 0
              ? `https://github.com/${item.parentItems[0].parent.githubItems[0].repository?.owner}/${item.parentItems[0].parent.githubItems[0].repository?.name}/issues/${item.parentItems[0].parent.githubItems[0].number}`
              : `https://hackclub.slack.com/archives/${
                  item.parentItems[0].parent.slackMessages[0].channel.slackId
                }/p${item.parentItems[0].parent.slackMessages[0]?.ts.replace(".", "")}`,
        },
      });
    } else {
      const project = getProjectName({
        channelId: item.slackMessages[0]?.channel.slackId,
        repoUrl: item.githubItems[0]?.repository.url,
      });

      if (!project) return;

      await elastic.index<ElasticDocument>({
        id: item.id,
        timeout: "1m",
        index: "search-slacker-analytics",
        document: {
          id: item.id,
          actionItemType:
            item.slackMessages.length > 0
              ? ItemType.message
              : item.githubItems[0].type === "issue"
              ? ItemType.issue
              : ItemType.pull,
          createdTime: createdAt ?? item.createdAt,
          resolvedTime: item.resolvedAt,
          firstResponseTime: item.firstReplyOn,
          reason: item.reason,
          state:
            item.snoozedUntil && dayjs(item.snoozedUntil).isAfter(dayjs())
              ? State.snoozed
              : item.status === ActionStatus.closed
              ? item.slackMessages.length > 0
                ? State.resolved
                : State.triaged
              : State.open,
          lastModifiedTime:
            item.lastReplyOn ??
            item.slackMessages.at(-1)?.updatedAt ??
            item.githubItems[0].updatedAt ??
            item.updatedAt,
          project,
          source:
            item.githubItems.length > 0
              ? item.githubItems[0].repository.owner + "/" + item.githubItems[0].repository.name
              : `#${item.slackMessages[0].channel.name}`,
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
              actor.slack === item.assignee?.slackId ||
              actor.github === item.assignee?.githubUsername
          ),
          author: participants.find(
            (actor) =>
              actor.slack ===
                (item.slackMessages.length > 0 ? item.slackMessages : item.githubItems)[0].author
                  .slackId ||
              actor.github ===
                (item.slackMessages.length > 0 ? item.slackMessages : item.githubItems)[0].author
                  .githubUsername
          ),
          url:
            item.githubItems.length > 0
              ? `https://github.com/${item.githubItems[0].repository?.owner}/${item.githubItems[0].repository?.name}/issues/${item.githubItems[0].number}`
              : `https://hackclub.slack.com/archives/${
                  item.slackMessages[0].channel.slackId
                }/p${item.slackMessages[0]?.ts.replace(".", "")}`,
        },
      });
    }
  } catch (err) {
    metrics.increment("errors.elastic.index", 1);
    console.error(err);
  }
};
