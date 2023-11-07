import { ActionStatus } from "@prisma/client";
import { Middleware, SlackCommandMiddlewareArgs } from "@slack/bolt";
import { StringIndexed } from "@slack/bolt/dist/types/helpers";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import relativeTime from "dayjs/plugin/relativeTime";
import { readdirSync } from "fs";
import { buttons, githubItem, slackItem, unauthorizedError } from "./blocks";
import prisma from "./db";
import { MAINTAINERS, getMaintainers, getYamlDetails, getYamlFile, logActivity } from "./utils";
dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);

export const handleSlackerCommand: Middleware<SlackCommandMiddlewareArgs, StringIndexed> = async ({
  command,
  ack,
  client,
  logger,
}) => {
  await ack();

  try {
    const { text, user_id, channel_id } = command;
    const user = await prisma.user.findFirst({ where: { slackId: user_id } });
    const args = text.split(" ");

    if (!args[0] || args[0] === "help") {
      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `:wave: Hi there! I'm Slacker, your friendly neighborhood action item manager. Here's what I can do:
        \n• *List your action items:* \`/slacker me\`
        \n• *List action items:* \`/slacker list [project] [filter]\`
        \n• *Reopen action item:* \`/slacker reopen [id]\`
        \n• *List projects:* \`/slacker whatsup\`
        \n• *List snoozed items:* \`/slacker snoozed [project]\`
        \n• *Get action item details:* \`/slacker get [id]\`
        \n• *Get a project report:* \`/slacker report [project]\`
        \n• *Assign an action item:* \`/slacker assign [id] [assignee]\`
        \n• *Help:* \`/slacker help\``,
      });
    } else if (args[0] === "list") {
      const project = args[1]?.trim() || "all";
      const filter = args[2]?.trim() || "";
      const files = readdirSync("./config");

      if (project !== "all" && !files.includes(`${project}.yaml`)) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Project not found. Please check your command and try again.`,
        });
        return;
      }

      if (filter && !["", "all", "github", "slack"].includes(filter.trim())) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Invalid filter. Please check your command and try again.`,
        });
        return;
      }

      const { maintainers, channels, repositories } = await getYamlDetails(
        project,
        user_id,
        user?.githubUsername
      );

      if (!maintainers.find((m) => m.slack === user_id)) {
        if (!user) {
          return await unauthorizedError({ client, user_id, channel_id });
        } else if (!user.githubUsername) {
          return await unauthorizedError({ client, user_id, channel_id });
        } else if (!maintainers.find((m) => m.github === user.githubUsername)) {
          return await unauthorizedError({ client, user_id, channel_id });
        }
      }

      const data = await prisma.actionItem
        .findMany({
          where: {
            OR: [
              ...(!filter || filter === "all" || filter === "slack"
                ? [{ slackMessage: { channel: { slackId: { in: channels.map((c) => c.id) } } } }]
                : []),
              ...((!filter || filter === "all" || filter === "github") &&
              !!maintainers.find((m) => m.github === user?.githubUsername)
                ? [
                    {
                      githubItem: {
                        repository: {
                          owner: { in: repositories.map((r) => r.uri.split("/")[3]) },
                          name: { in: repositories.map((r) => r.uri.split("/")[4]) },
                        },
                      },
                    },
                  ]
                : []),
            ],
            status: { not: ActionStatus.closed },
          },
          include: {
            githubItem: { include: { author: true, repository: true } },
            slackMessage: { include: { author: true, channel: true } },
            participants: { include: { user: true } },
            assignee: true,
          },
        })
        .then((res) =>
          res.filter((i) => i.snoozedUntil === null || dayjs().isAfter(dayjs(i.snoozedUntil)))
        );

      await client.chat.postMessage({
        channel: user_id,
        unfurl_links: false,
        text: `:white_check_mark: Here are your action items:`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `:white_check_mark: Here are your action items:` },
          },
          { type: "divider" },
          ...data
            .slice(0, 15)
            .map((item) => {
              const arr: any[] = [];

              if (item.slackMessage !== null) arr.push(slackItem({ item }));
              if (item.githubItem !== null) arr.push(githubItem({ item }));
              arr.push(buttons({ item }));

              return arr;
            })
            .flat(),
          { type: "divider" },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `*Total action items:* ${data.length} | ${
                  user?.githubUsername
                    ? `Logged in with github. You're all good.`
                    : `In order to get github items, please <${process.env.DEPLOY_URL}/auth?id=${user_id}|authenticate> slacker to access your github account.`
                }`,
              },
            ],
          },
        ],
      });
    } else if (args[0] === "reopen") {
      const item = await prisma.actionItem.findFirst({
        where: { id: args[1] },
        include: { slackMessage: true, githubItem: true },
      });

      if (!item) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Action item not found. Please check your command and try again.`,
        });
        return;
      }

      if (item.status === ActionStatus.closed) {
        await prisma.actionItem.update({
          where: { id: item.id },
          data: { status: ActionStatus.open, flag: null, resolvedAt: null },
        });

        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:white_check_mark: Action item reopened.`,
        });

        await logActivity(client, user_id, item.id, "reopened");
      } else {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Action item is already open.`,
        });
      }
    } else if (args[0] === "whatsup") {
      const files = readdirSync("./config");
      const text = `:white_check_mark: Here are your projects:\n\n
        ${files
          .map((file) => {
            const config = getYamlFile(file);

            const maintainers = config.maintainers.map((id) =>
              MAINTAINERS.find((user) => user.id === id)
            );

            if (
              maintainers.find(
                (maintainer) =>
                  maintainer?.slack === user_id || maintainer?.github === user?.githubUsername
              )
            )
              return `\n• *${file.split(".")[0]}* - ${config.description}`;
          })
          .join("")}`;

      await client.chat.postEphemeral({ user: user_id, channel: channel_id, text });
    } else if (args[0] === "snoozed") {
      const project = args[1]?.trim() || "all";
      const files = readdirSync("./config");

      if (project !== "all" && !files.includes(`${project}.yaml`)) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Project not found. Please check your command and try again.`,
        });
        return;
      }

      const { maintainers, channels, repositories } = await getYamlDetails(
        project,
        user_id,
        user?.githubUsername
      );

      if (!maintainers.find((m) => m.slack === user_id)) {
        if (!user) {
          return await unauthorizedError({ client, user_id, channel_id });
        } else if (!user.githubUsername) {
          return await unauthorizedError({ client, user_id, channel_id });
        } else if (!maintainers.find((m) => m.github === user.githubUsername)) {
          return await unauthorizedError({ client, user_id, channel_id });
        }
      }

      const data = await prisma.actionItem.findMany({
        where: {
          snoozedUntil: { not: null, lte: dayjs().toDate() },
          OR: [
            { slackMessage: { channel: { slackId: { in: channels.map((c) => c.id) } } } },
            ...(maintainers.find((m) => m.github === user?.githubUsername)
              ? [
                  {
                    githubItem: {
                      repository: {
                        owner: { in: repositories.map((r) => r.uri.split("/")[3]) },
                        name: { in: repositories.map((r) => r.uri.split("/")[4]) },
                      },
                    },
                  },
                ]
              : []),
          ],
          status: { not: ActionStatus.closed },
        },
        include: {
          githubItem: { include: { author: true, repository: true } },
          slackMessage: { include: { author: true, channel: true } },
          participants: { include: { user: true } },
        },
      });

      await client.chat.postMessage({
        channel: user_id,
        unfurl_links: false,
        text: `:white_check_mark: Here are your snoozed action items:`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:white_check_mark: Here are your snoozed action items:`,
            },
          },
          { type: "divider" },
          ...data
            .map((item) => {
              const arr: any[] = [];

              if (item.slackMessage !== null)
                arr.push({
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `${item.id}: https://hackclub.slack.com/archives/${
                      item.slackMessage?.channel?.slackId
                    }/p${item.slackMessage?.ts.replace(".", "")}`,
                  },
                  accessory: {
                    type: "button",
                    text: { type: "plain_text", emoji: true, text: "Unsnooze" },
                    style: "primary",
                    value: item.id,
                    action_id: "unsnooze",
                  },
                });

              if (item.githubItem !== null)
                arr.push({
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `${item.id}: https://github.com/${item.githubItem?.repository?.owner}/${item.githubItem?.repository?.name}/issues/${item.githubItem?.number}`,
                  },
                  accessory: {
                    type: "button",
                    text: { type: "plain_text", emoji: true, text: "Unsnooze" },
                    style: "primary",
                    value: item.id,
                    action_id: "unsnooze",
                  },
                });

              return arr;
            })
            .flat(),
        ],
      });
    } else if (args[0] === "get") {
      const item = await prisma.actionItem.findFirst({
        where: { id: args[1] },
        include: { slackMessage: true, githubItem: true },
      });

      if (!item) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Action item not found. Please check your command and try again.`,
        });
        return;
      }

      // await client.chat.postMessage({});
    } else if (args[0] === "report") {
      const project = args[1]?.trim();

      if (!project) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Project not found. Please check your command and try again.`,
        });
        return;
      }

      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `🚧 Work in progress. Please check back later.`,
      });
    } else if (args[0] === "assign") {
      const id = args[1]?.trim();
      const assignee = args[2]?.trim();

      if (!id || !assignee) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: No ID or assignee provided. Please check your command and try again.`,
        });
        return;
      }

      const item = await prisma.actionItem.findFirst({
        where: { id, status: ActionStatus.open },
        include: {
          githubItem: { include: { repository: true } },
          slackMessage: { include: { channel: true } },
        },
      });

      if (!item) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Action item not found or already closed. Please check your command and try again.`,
        });
        return;
      }

      const maintainers = await getMaintainers({
        channelId: item.slackMessage?.channel?.slackId,
        repoUrl: item.githubItem?.repository?.url,
      });

      if (!maintainers.find((m) => m?.id === assignee)) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Assignee is not a top-level maintainer. Please check your command and try again.\n*Top-level maintainers:* ${maintainers
            .map((m) => `<@${m?.id}>`)
            .join(", ")}`,
        });
        return;
      }

      const maintainer = maintainers.find((m) => m?.id === assignee);
      let user = await prisma.user.findFirst({
        where: { OR: [{ slackId: maintainer?.slack }, { githubUsername: maintainer?.github }] },
      });

      if (!user) {
        const userInfo = await client.users.info({ user: maintainer?.slack as string });
        user = await prisma.user.create({
          data: {
            slackId: maintainer?.slack,
            githubUsername: maintainer?.github,
            email: userInfo.user?.profile?.email || "",
          },
        });
      }

      await prisma.actionItem.update({
        where: { id },
        data: { assignee: { connect: { id: user?.id } } },
      });

      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `:white_check_mark: Action item assigned to <@${maintainer?.slack}>.`,
      });
    } else if (args[0] === "me") {
      const maintainer = MAINTAINERS.find((m) => m.slack === user_id);

      const item = await prisma.actionItem.findFirst({
        where: {
          assignee: { OR: [{ slackId: user_id }, { githubUsername: maintainer?.github }] },
          status: { not: ActionStatus.closed },
        },
        include: {
          githubItem: { include: { repository: true, author: true } },
          slackMessage: { include: { channel: true, author: true } },
          assignee: true,
        },
      });

      if (item) {
        const arr: any[] = [];

        if (item.slackMessage !== null) arr.push(slackItem({ item }));
        if (item.githubItem !== null) arr.push(githubItem({ item }));
        arr.push(buttons({ item }));

        await client.chat.postMessage({
          channel: user_id,
          unfurl_links: false,
          text: `:white_check_mark: Here is the action item currently assigned to you:`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:white_check_mark: Here is the action item currently assigned to you:`,
              },
            },
            { type: "divider" },
            ...arr.flat(),
          ],
        });
      } else {
        const { channels, repositories } = await getYamlDetails(
          "all",
          user_id,
          user?.githubUsername
        );

        const data = await prisma.actionItem.findMany({
          where: {
            OR: [
              { slackMessage: { channel: { slackId: { in: channels.map((c) => c.id) } } } },
              { githubItem: { repository: { url: { in: repositories.map((r) => r.uri) } } } },
            ],
            status: { not: ActionStatus.closed },
          },
          include: {
            githubItem: { include: { author: true, repository: true } },
            slackMessage: { include: { author: true, channel: true } },
            participants: { include: { user: true } },
            assignee: true,
          },
          orderBy: { createdAt: "asc" },
          take: 1,
        });

        await prisma.actionItem.update({
          where: { id: data[0].id },
          data: { assignee: { connect: { id: user?.id } } },
        });

        const arr: any[] = [];
        if (data[0].slackMessage !== null) arr.push(slackItem({ item: data[0] }));
        if (data[0].githubItem !== null) arr.push(githubItem({ item: data[0] }));
        arr.push(buttons({ item: data[0] }));

        await client.chat.postMessage({
          channel: user_id,
          unfurl_links: false,
          text: `:white_check_mark: Here is the action item currently assigned to you:`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:white_check_mark: Here is the action item currently assigned to you:`,
              },
            },
            { type: "divider" },
            ...arr.flat(),
          ],
        });
      }
    }
  } catch (err) {
    logger.error(err);
  }
};
