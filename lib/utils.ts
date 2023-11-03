import fs, { readFileSync, readdirSync } from "fs";
import { Config } from "./types";
import yaml from "js-yaml";
import { slack } from "..";
import prisma from "./db";

export const joinChannels = async () => {
  const files = fs.readdirSync("./config");

  files.forEach(async (file) => {
    try {
      const config = yaml.load(fs.readFileSync(`./config/${file}`, "utf-8")) as Config;
      const channels = config["slack-channels"] || [];

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
      const managers = config["slack-managers"];
      const maintainers = config["maintainers"];
      const channels = config["slack-channels"] || [];
      const repos = config["repos"];

      if (channelId && channels.some((channel) => channel.id === channelId)) arr.push(...managers);
      else if (repoUrl && repos.some((repo) => repo.uri === repoUrl)) arr.push(...maintainers);
    } catch (err) {}
  });

  return arr;
};

export const syncParticipants = async (participants: string[], id: string) => {
  for (let i = 0; i < participants.length; i++) {
    const userInfo = await slack.client.users.info({ user: participants[i] as string });

    await prisma.participant.create({
      data: {
        actionItem: { connect: { id } },
        user: {
          connectOrCreate: {
            where: { slackId: participants[i] as string, email: userInfo.user?.profile?.email },
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
    await prisma.participant.create({
      data: {
        actionItem: { connect: { id } },
        user: {
          connectOrCreate: {
            where: { githubUsername: participants[i] as string, email: participants[i] },
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
  let channels: Config["slack-channels"] = [];
  let repositories: Config["repos"] = [];
  let managers: Config["slack-managers"] = [];
  let maintainers: Config["maintainers"] = [];

  if (project === "all") {
    files.forEach((file) => {
      const config = yaml.load(readFileSync(`./config/${file}`, "utf-8")) as Config;
      if (config.maintainers.includes(login ?? "") || config["slack-managers"].includes(user_id)) {
        channels = [...(channels || []), ...(config["slack-channels"] || [])];
        repositories = [...repositories, ...config["repos"]];
        managers = [...managers, ...config["slack-managers"]];
        maintainers = [...maintainers, ...config.maintainers];
      }
    });
  } else {
    const config = yaml.load(readFileSync(`./config/${project}.yaml`, "utf-8")) as Config;
    channels = config["slack-channels"] || [];
    repositories = config["repos"];
    managers = config["slack-managers"];
    maintainers = config.maintainers;
  }

  return { channels, repositories, managers, maintainers };
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
