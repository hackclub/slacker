import { Client } from "@elastic/elasticsearch";
import { ActionStatus } from "@prisma/client";
import { config } from "dotenv";
import { Octokit } from "octokit";
import { slack } from "..";
import prisma from "./db";
import { getOctokitToken } from "./octokit";
import { ElasticDocument } from "./types";
import { MAINTAINERS, getProject } from "./utils";
config();

export const elastic = new Client({
  node: "https://localhost:9200",
  auth: { apiKey: process.env.ELASTIC_API_TOKEN || "" },
});

export const indexDocument = async (id: string, data?: ElasticDocument) => {
  const item = await prisma.actionItem.findUnique({
    where: { id },
    include: {
      slackMessage: { include: { channel: true, author: true } },
      githubItem: { include: { repository: true, author: true } },
      assignee: true,
      participants: { select: { user: true } },
    },
  });

  if (!item) return;

  const doc = await elastic.get<ElasticDocument>({
    id: item.id,
    index: "search-slacker-analytics",
  });

  const participants: ElasticDocument["actors"] = [];

  for (let i = 0; i < item.participants.length; i++) {
    const { user } = item.participants[i];

    const maintainer = MAINTAINERS.find(
      (maintainer) => maintainer.github === user.githubUsername || maintainer.slack === user.slackId
    );

    if (maintainer) {
      participants.push({
        displayName: maintainer.id,
        github: maintainer.github,
        slack: maintainer.slack,
      });
    } else {
      const token = await getOctokitToken(
        item.githubItem?.repository.url.split("/")[3] || "",
        item.githubItem?.repository.url.split("/")[4] || ""
      );
      const octokit = new Octokit({ auth: "Bearer " + token });
      const displayName = user.slackId
        ? await slack.client.users
            .info({ user: user.slackId })
            .then(
              (res) =>
                res.user?.name || res.user?.real_name || res.user?.profile?.display_name || ""
            )
        : await octokit.rest.users
            .getByUsername({ username: user.githubUsername ?? "" })
            .then((res) => res.data.name || "");

      participants.push({
        displayName: displayName,
        github: user.githubUsername,
        slack: user.slackId,
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
      state: item.status === ActionStatus.closed ? "resolved" : "open",
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
      timesReopened: doc._source?.timesReopened ?? 0,
      timesResolved: doc._source?.timesResolved ?? 0,
      timesSnoozed: doc._source?.timesSnoozed ?? 0,
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
};
