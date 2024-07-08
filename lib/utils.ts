import fs, { readFileSync, readdirSync } from "fs";
import yaml from "js-yaml";
import { slack } from "..";
import { buttons } from "../blocks/buttons";
import { githubItem } from "../blocks/githubItem";
import { slackItem } from "../blocks/slackItem";
import prisma from "./db";
import { indexDocument } from "./elastic";
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

  return arr
    .map((id) => MAINTAINERS.find((user) => user.id === id))
    .filter((user) => user) as Maintainer[];
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

export const checkNeedsNotifying = async (actionId: string) => {
  const item = await prisma.actionItem.findUnique({
    where: { id: actionId },
    include: {
      githubItems: { include: { repository: true, author: true } },
      slackMessages: { include: { channel: true, author: true } },
      assignee: true,
    },
  });

  if (!item) return;

  const msg = item?.slackMessages[0];
  const gh = item?.githubItems[0];

  const project = getProjectName({ channelId: msg?.channel.slackId, repoUrl: gh?.repository.url });
  if (!project) return;

  const config = getYamlFile(`${project}.yaml`);
  let maintainers: Maintainer[] = [];

  if (gh) {
    const usersToNotify = config.repos?.find((r) => r.uri === gh.repository.url)?.notify || [];

    const section = config.sections?.filter((s) => {
      const regex = new RegExp(s.pattern);
      return regex.test(gh.title || "") || regex.test(gh.body || "");
    });

    const sectionUsers = section?.map((s) => s.notify).flat() || [];
    const allUsers = Array.from(new Set([...usersToNotify, ...sectionUsers]));

    maintainers = allUsers.map((id) => MAINTAINERS.find((user) => user.id === id) as Maintainer);
  } else if (msg) {
    const usersToNotify = config.channels?.find((c) => c.id === msg.channel.slackId)?.notify || [];

    const section = config.sections?.filter((s) => {
      const regex = new RegExp(s.pattern);
      return regex.test(msg.text || "");
    });

    const sectionUsers = section?.map((s) => s.notify).flat() || [];
    const allUsers = Array.from(new Set([...usersToNotify, ...sectionUsers]));

    maintainers = allUsers.map((id) => MAINTAINERS.find((user) => user.id === id) as Maintainer);
  }

  const arr: any[] = [];

  if (msg) arr.push(slackItem({ item }));
  if (gh) arr.push(githubItem({ item }));
  arr.push(...buttons({ item, showAssignee: true, showActions: true }));

  for await (const maintainer of maintainers) {
    if (!maintainer?.slack) continue;

    await slack.client.chat.postMessage({
      channel: maintainer.slack,
      text: `Hey <@${maintainer.slack}>, you asked us to notify for a new action item:`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Hey <@${maintainer.slack}>, you asked us to notify for a new action item:`,
          },
        },
        { type: "divider" },
        ...arr.flat(),
      ],
    });
  }
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
  try {
    if (process.env.ACTIVITY_LOG_CHANNEL_ID === undefined) return;

    const item = await prisma.actionItem.findUnique({
      where: { id: actionId },
      include: {
        githubItems: { include: { repository: true, author: true } },
        slackMessages: { include: { channel: true, author: true } },
        assignee: true,
        parentItems: {
          include: {
            parent: {
              include: {
                githubItems: { include: { author: true, repository: true } },
                slackMessages: { include: { author: true, channel: true } },
                participants: { include: { user: true } },
                assignee: true,
              },
            },
          },
        },
      },
    });

    const msg = item?.slackMessages[0] || item?.parentItems[0]?.parent?.slackMessages[0];
    const gh = item?.githubItems[0] || item?.parentItems[0]?.parent?.githubItems[0];

    const project = getProjectName({
      channelId: msg?.channel.slackId,
      repoUrl: gh?.repository.url,
    });

    if (!project) return;

    const config = getYamlFile(`${project}.yaml`);
    if (!item || config.private) return;

    const url = gh
      ? `https://github.com/${gh.repository.owner}/${gh.repository.name}/issues/${gh.number}`
      : msg
      ? `https://hackclub.slack.com/archives/${msg.channel.slackId}/p${msg.ts.replace(".", "")}`
      : undefined;

    await client.chat.postMessage({
      channel: process.env.ACTIVITY_LOG_CHANNEL_ID,
      text: `:white_check_mark: ${
        MAINTAINERS.find((u) => u.slack === user)?.id || user
      } ${type} an action item. ${
        type === "irrelevant" || type === "resolved" ? `\n\nReason: ${item.reason}` : ""
      }\n\n${url ? `<${url}|View action item>` : ""} id=${actionId}`,
    });

    if (notifyUser && user !== notifyUser && type === "assigned") {
      const arr: any[] = [];

      if (msg) arr.push(slackItem({ item }));
      if (gh) arr.push(githubItem({ item }));
      arr.push(
        ...buttons({
          item,
          showAssignee: true,
          showActions: true,
          followUpId: item.parentItems.length > 0 ? item.id : undefined,
        })
      );

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
  } catch (err) {
    console.error(err);
  }
};

export const checkDuplicateResources = async () => {
  console.log("⏳⏳ Checking for duplicates ⏳⏳");
  const { channels, repositories } = await getProjectDetails("all", undefined, null, false);

  const hasChannelDuplicates = channels.some(
    (channel) => channels.filter((c) => c.id === channel.id).length > 1
  );

  const hasRepoDuplicates = repositories.some(
    (repo) => repositories.filter((r) => r.uri === repo.uri).length > 1
  );

  if (hasChannelDuplicates || hasRepoDuplicates) {
    console.log("🚨🚨 Found duplicates. Aborting 🚨🚨");
    console.log("Channels:");
    console.log(
      channels.filter((channel) => channels.filter((c) => c.id === channel.id).length > 1)
    );
    console.log("Repositories:");
    console.log(
      repositories.filter((repo) => repositories.filter((r) => r.uri === repo.uri).length > 1)
    );

    process.exit(1);
  }

  console.log("✅✅ No duplicates found ✅✅");
};

export const backFill = async () => {
  // await elastic.indices.delete({ index: "search-slacker-analytics" });
  // await elastic.indices.create({ index: "search-slacker-analytics" });

  const actionItems = await prisma.actionItem.findMany({ select: { id: true } });
  const batchSize = 10; // Set the desired batch size

  const chunk = <T>(array: T[], size: number): T[][] => {
    return Array.from({ length: Math.ceil(array.length / size) }, (_, index) =>
      array.slice(index * size, index * size + size)
    );
  };

  const backfillBatch = async (batch: { id: string }[]) => {
    await Promise.allSettled(
      batch.map(async (item, index) => {
        await indexDocument(item.id);
      })
    );
  };

  const batches = chunk(actionItems, batchSize);

  for (const batch of batches) {
    console.log(`Backfilling batch #${batches.indexOf(batch) + 1}/${batches.length}`);
    await backfillBatch(batch);
  }
};
