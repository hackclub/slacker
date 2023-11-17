import fs, { readFileSync, readdirSync } from "fs";
import yaml from "js-yaml";
import { slack } from "..";
import prisma from "./db";
import { Config, Maintainer } from "./types";

export const MAINTAINERS = yaml.load(readFileSync(`./maintainers.yaml`, "utf-8")) as Maintainer[];

export const joinChannels = async () => {
  const files = fs.readdirSync("./config");

  files.forEach(async (file) => {
    try {
      const config = getYamlFile(file);
      const channels = config.channels || [];

      for (let i = 0; i < channels.length; i++) {
        const channel = channels[i];

        await prisma.channel.upsert({
          where: { slackId: channel.id },
          update: { name: channel.name },
          create: { name: channel.name, slackId: channel.id },
        });

        await slack.client.conversations.join({ channel: channel.id });
      }
    } catch (err) {
      console.error(err);
    }
  });
};

export const getMaintainers = ({
  channelId,
  repoUrl,
}: {
  channelId?: string;
  repoUrl?: string;
}) => {
  const files = fs.readdirSync("./config");
  const arr: string[] = [];

  files.forEach((file) => {
    try {
      const config = getYamlFile(file);
      const maintainers = config["maintainers"];
      const channels = config.channels || [];
      const repos = config["repos"];

      if (
        channels.some((channel) => channel.id === channelId) ||
        repos.some((repo) => repo.uri === repoUrl)
      )
        arr.push(...maintainers);
    } catch (err) {}
  });

  return arr.map((id) => MAINTAINERS.find((user) => user.id === id));
};

export const getProject = ({ channelId, repoUrl }: { channelId?: string; repoUrl?: string }) => {
  const files = fs.readdirSync("./config");
  let project: string | undefined;

  files.forEach((file) => {
    try {
      const config = getYamlFile(file);
      const channels = config.channels || [];
      const repos = config["repos"];

      if (
        channels.some((channel) => channel.id === channelId) ||
        repos.some((repo) => repo.uri === repoUrl)
      )
        project = file.replace(".yaml", "");
    } catch (err) {}
  });

  return project;
};

export const syncParticipants = async (participants: string[], id: string) => {
  for (let i = 0; i < participants.length; i++) {
    const userInfo = await slack.client.users.info({ user: participants[i] as string });
    const userId = await prisma.user
      .findFirst({ where: { slackId: participants[i] as string } })
      .then((user) => user?.id || "-1");

    await prisma.participant.upsert({
      where: { userId_actionItemId: { userId, actionItemId: id } },
      create: {
        actionItem: { connect: { id } },
        user: {
          connectOrCreate: {
            where: { id: userId },
            create: {
              slackId: participants[i] as string,
              email: userInfo.user?.profile?.email || "",
              githubUsername: MAINTAINERS.find((user) => user.slack === participants[i])?.github,
            },
          },
        },
      },
      update: {},
    });
  }
};

export const syncGithubParticipants = async (participants: string[], id: string) => {
  for (let i = 0; i < participants.length; i++) {
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ githubUsername: participants[i] as string }, { email: participants[i] as string }],
      },
    });

    await prisma.participant.create({
      data: {
        actionItem: { connect: { id } },
        user: {
          connectOrCreate: {
            where: { id: user?.id || "-1" },
            create: { githubUsername: participants[i] as string, email: participants[i] },
          },
        },
      },
    });
  }
};

export const getYamlFile = (filename: string) => {
  return yaml.load(readFileSync(`./config/${filename}`, "utf-8")) as Config;
};

export const getYamlDetails = async (
  project: string,
  user_id?: string,
  login?: string | null,
  checkMembership: boolean = true
) => {
  const files = readdirSync("./config");
  let channels: Config["channels"] = [];
  let repositories: Config["repos"] = [];
  let maintainers: Config["maintainers"] = [];

  if (project === "all") {
    files.forEach((file) => {
      const config = getYamlFile(file);

      const topLevelMaintainers = config.maintainers.map((id) =>
        MAINTAINERS.find((user) => user.id === id)
      );

      if (
        (checkMembership &&
          topLevelMaintainers.some(
            (maintainer) => maintainer?.github === login || maintainer?.slack === user_id
          )) ||
        !checkMembership
      ) {
        channels = [...(channels || []), ...(config.channels || [])];
        repositories = [...repositories, ...config["repos"]];
        maintainers = [...maintainers, ...config.maintainers];
      }
    });
  } else {
    const config = getYamlFile(`${project}.yaml`);
    channels = config.channels || [];
    repositories = config["repos"];
    maintainers = config.maintainers;
  }

  return {
    channels,
    repositories,
    maintainers: maintainers.map((id) =>
      MAINTAINERS.find((user) => user.id === id)
    ) as Maintainer[],
  };
};

export const logActivity = async (
  client: typeof slack.client,
  user: string,
  actionId: string,
  type: "resolved" | "irrelevant" | "snoozed" | "reopened" | "unsnoozed" | "assigned",
  notifyUser?: string
) => {
  if (process.env.ACTIVITY_LOG_CHANNEL_ID === undefined) return;

  const action = await prisma.actionItem.findUnique({
    where: { id: actionId },
    include: {
      slackMessage: { include: { channel: true } },
      githubItem: { include: { repository: true } },
    },
  });

  if (!action) return;

  const url = action.githubItem
    ? `https://github.com/${action.githubItem.repository.owner}/${action.githubItem.repository.name}/issues/${action.githubItem.number}`
    : action.slackMessage
    ? `https://hackclub.slack.com/archives/${
        action.slackMessage.channel.slackId
      }/p${action.slackMessage.ts.replace(".", "")}`
    : undefined;

  await client.chat.postMessage({
    channel: process.env.ACTIVITY_LOG_CHANNEL_ID,
    text: `:white_check_mark: ${
      MAINTAINERS.find((u) => u.slack === user)?.id || user
    } ${type} an action item. ID: ${actionId} ${
      notifyUser && user !== notifyUser ? `cc:<@${notifyUser}>` : ""
    }\n\n${url ? `<${url}|View action item>` : ""}`,
  });

  if (notifyUser && user !== notifyUser && type === "assigned") {
    await client.chat.postMessage({
      channel: notifyUser,
      text: `Hey <@${notifyUser}>, ${
        MAINTAINERS.find((u) => u.slack === user)?.id || user
      } ${type} an action item to you. ID: ${actionId}\n\n${
        url ? `<${url}|View action item>` : ""
      }`,
    });
  }
};
