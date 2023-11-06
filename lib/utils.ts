import fs, { readFileSync, readdirSync } from "fs";
import { Config, Maintainer } from "./types";
import yaml from "js-yaml";
import { slack } from "..";
import prisma from "./db";

export const joinChannels = async () => {
  const files = fs.readdirSync("./config");

  files.forEach(async (file) => {
    try {
      const config = yaml.load(fs.readFileSync(`./config/${file}`, "utf-8")) as Config;
      const channels = config.channels || [];

      for (let i = 0; i < channels.length; i++) {
        const channel = channels[i];

        const c = await prisma.channel.upsert({
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

export const getMaintainers = async ({
  channelId,
  repoUrl,
}: {
  channelId?: string;
  repoUrl?: string;
}) => {
  const files = fs.readdirSync("./config");
  const arr: string[] = [];

  files.forEach(async (file) => {
    try {
      const config = yaml.load(fs.readFileSync(`./config/${file}`, "utf-8")) as Config;
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

  const users = yaml.load(fs.readFileSync(`./config/maintainers.yaml`, "utf-8")) as Maintainer[];

  return arr.map((id) => users.find((user) => user.id === id));
};

export const syncParticipants = async (participants: string[], id: string) => {
  for (let i = 0; i < participants.length; i++) {
    const userInfo = await slack.client.users.info({ user: participants[i] as string });
    const user = await prisma.user.findFirst({ where: { slackId: participants[i] as string } });

    await prisma.participant.create({
      data: {
        actionItem: { connect: { id } },
        user: {
          connectOrCreate: {
            where: { id: user?.id },
            create: {
              slackId: participants[i] as string,
              email: userInfo.user?.profile?.email || "",
            },
          },
        },
      },
    });
  }
};

export const syncGithubParticipants = async (participants: string[], id: string) => {
  for (let i = 0; i < participants.length; i++) {
    const user = await prisma.user.findFirst({
      where: { githubUsername: participants[i] as string },
    });

    await prisma.participant.create({
      data: {
        actionItem: { connect: { id } },
        user: {
          connectOrCreate: {
            where: { id: user?.id },
            create: { githubUsername: participants[i] as string, email: participants[i] },
          },
        },
      },
    });
  }
};

export const getYamlDetails = async (
  project: string,
  user_id: string,
  login: string | null | undefined
) => {
  const files = readdirSync("./config");
  let channels: Config["channels"] = [];
  let repositories: Config["repos"] = [];
  let maintainers: Config["maintainers"] = [];
  const users = yaml.load(fs.readFileSync(`./config/maintainers.yaml`, "utf-8")) as Maintainer[];

  if (project === "all") {
    files.forEach((file) => {
      const config = yaml.load(readFileSync(`./config/${file}`, "utf-8")) as Config;

      const topLevelMaintainers = config.maintainers.map((id) =>
        users.find((user) => user.id === id)
      );

      if (
        topLevelMaintainers.some(
          (maintainer) => maintainer?.github === login || maintainer?.slack === user_id
        )
      ) {
        channels = [...(channels || []), ...(config.channels || [])];
        repositories = [...repositories, ...config["repos"]];
        maintainers = [...maintainers, ...config.maintainers];
      }
    });
  } else {
    const config = yaml.load(readFileSync(`./config/${project}.yaml`, "utf-8")) as Config;
    channels = config.channels || [];
    repositories = config["repos"];
    maintainers = config.maintainers;
  }

  return {
    channels,
    repositories,
    maintainers: maintainers.map((id) => users.find((user) => user.id === id)) as Maintainer[],
  };
};

export const logActivity = async (
  client: typeof slack.client,
  user: string,
  actionId: string,
  type: "resolved" | "irrelevant" | "snoozed" | "reopened" | "unsnoozed"
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
    text: `:white_check_mark: <@${user}> ${type} an action item. ID: ${actionId}\n\n${
      url ? `<${url}|View action item>` : ""
    }`,
  });
};
