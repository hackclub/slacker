import fs, { readFileSync, readdirSync } from "fs";
import yaml from "js-yaml";
import { slack } from "..";
import prisma from "./db";
import { Config, Maintainer } from "./types";
import { buttons, githubItem, slackItem } from "./blocks";

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

export const getProjectName = ({
  channelId,
  repoUrl,
}: {
  channelId?: string;
  repoUrl?: string;
}) => {
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

export const getProjectDetails = async (
  project: string,
  user_id?: string,
  login?: string | null,
  checkMembership: boolean = true
) => {
  const files = readdirSync("./config");
  let channels: Config["channels"] = [];
  let repositories: Config["repos"] = [];
  let maintainers: Config["maintainers"] = [];
  let sections: Config["sections"] = [];

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
        sections = [...(sections || []), ...(config.sections || [])];
      }
    });
  } else {
    const config = getYamlFile(`${project}.yaml`);
    channels = config.channels || [];
    repositories = config["repos"];
    maintainers = config.maintainers;
    sections = config.sections || [];
  }

  return {
    channels,
    repositories,
    maintainers: maintainers.map((id) =>
      MAINTAINERS.find((user) => user.id === id)
    ) as Maintainer[],
    sections,
  };
};

export const logActivity = async (
  client: typeof slack.client,
  user: string,
  actionId: string,
  type:
    | "resolved"
    | "irrelevant"
    | "snoozed"
    | "reopened"
    | "unsnoozed"
    | "assigned"
    | "unassigned",
  notifyUser?: string
) => {
  if (process.env.ACTIVITY_LOG_CHANNEL_ID === undefined) return;

  const item = await prisma.actionItem.findUnique({
    where: { id: actionId },
    include: {
      githubItems: { include: { repository: true, author: true } },
      slackMessages: { include: { channel: true, author: true } },
      assignee: true,
    },
  });

  const project = getProjectName({
    channelId: item?.slackMessages[0].channel.slackId,
    repoUrl: item?.githubItems[0].repository.url,
  });

  const config = getYamlFile(`${project}.yaml`);
  if (!item || config.logging === false) return;

  const url =
    item.githubItems.length > 0
      ? `https://github.com/${item.githubItems[0].repository.owner}/${item.githubItems[0].repository.name}/issues/${item.githubItems[0].number}`
      : item.slackMessages.length > 0
      ? `https://hackclub.slack.com/archives/${
          item.slackMessages[0].channel.slackId
        }/p${item.slackMessages[0].ts.replace(".", "")}`
      : undefined;

  await client.chat.postMessage({
    channel: process.env.ACTIVITY_LOG_CHANNEL_ID,
    text: `:white_check_mark: ${
      MAINTAINERS.find((u) => u.slack === user)?.id || user
    } ${type} an action item. ${notifyUser && user !== notifyUser ? `cc:<@${notifyUser}>` : ""}${
      type === "irrelevant" || type === "resolved" ? `\n\nReason: ${item.reason}` : ""
    }\n\n${url ? `<${url}|View action item>` : ""}`,
  });

  if (notifyUser && user !== notifyUser && type === "assigned") {
    const arr: any[] = [];

    if (item.slackMessages.length > 0) arr.push(slackItem({ item }));
    if (item.githubItems.length > 0) arr.push(githubItem({ item }));
    arr.push(...buttons({ item, showAssignee: true, showActions: true }));

    await client.chat.postMessage({
      channel: notifyUser,
      unfurl_links: false,
      text: `Hey <@${notifyUser}>, ${
        MAINTAINERS.find((u) => u.slack === user)?.id || user
      } ${type} an action item to you:`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Hey <@${notifyUser}>, ${
              MAINTAINERS.find((u) => u.slack === user)?.id || user
            } ${type} an action item to you:`,
          },
        },
        { type: "divider" },
        ...arr.flat(),
      ],
    });
  }
};
