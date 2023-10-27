import { expressConnectMiddleware } from "@connectrpc/connect-express";
import { ActionStatus } from "@prisma/client";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import relativeTime from "dayjs/plugin/relativeTime";
import { config } from "dotenv";
import express from "express";
import { readFileSync, readdirSync } from "fs";
import yaml from "js-yaml";
import prisma from "./lib/db";
import { Config } from "./lib/types";
import { getMaintainers, syncParticipants } from "./lib/utils";
import routes from "./routes";
dayjs.extend(relativeTime);

dayjs.extend(customParseFormat);
config();

const app = express();
app.use(expressConnectMiddleware({ routes }));

app.get("/", async (_, res) => {
  res.send("Hello World!");
});

app.get("/auth", async (_, res) => {
  res.redirect(
    `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&redirect_uri=${"https://slacker.underpass.clb.li/auth/callback"}`
  );
})

app.get("/auth/callback", async (req, res) => {
  console.log(req.query);

  return "ok";
})

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET as string,
  app,
});

export const slack = new App({
  logLevel: LogLevel.INFO,
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

slack.event("message", async ({ event, client, logger, message }) => {
  try {
    if (message.subtype === "message_deleted") {
      await prisma.slackMessage.deleteMany({
        where: { ts: message.deleted_ts, channel: { slackId: event.channel } },
      });
    }

    if (message.subtype || message.bot_id) return;

    const channel = await prisma.channel.findFirst({ where: { slackId: event.channel } });
    if (!channel) return;

    const parent = await client.conversations
      .history({ channel: event.channel, latest: message.thread_ts, limit: 1, inclusive: true })
      .then((res) => res.messages?.[0]);

    if (!parent) return;

    const parentInDb = await prisma.slackMessage.findFirst({
      where: { ts: parent.ts, channel: { slackId: event.channel } },
      include: { actionItem: true },
    });

    const threadReplies = await client.conversations
      .replies({ channel: event.channel, ts: parent.ts as string, limit: 100 })
      .then((res) => res.messages?.slice(1));

    const authorInfo = await client.users.info({ user: parent.user as string });
    const email = authorInfo?.user?.profile?.email || "";

    if (parentInDb) {
      // update action item:
      const action = await prisma.slackMessage.update({
        where: { id: parentInDb.id },
        data: {
          text: parent.text || "",
          actionItem: {
            update: {
              firstReplyOn: threadReplies?.[0]?.ts
                ? dayjs(threadReplies[0].ts.split(".")[0], "X").toDate()
                : undefined,
              lastReplyOn: parent.latest_reply
                ? dayjs(parent.latest_reply.split(".")[0], "X").toDate()
                : undefined,
              totalReplies: parent.reply_count || 0,
              participants: { deleteMany: {} },
            },
          },
        },
      });

      await syncParticipants(parent.reply_users || [], action.id);
    } else {
      // create new action item:
      const maintainers = await getMaintainers({ channelId: event.channel });
      if (maintainers.includes(parent.user as string)) return;

      const author = await prisma.user.upsert({
        where: { email },
        create: { email, slackId: parent.user as string },
        update: { slackId: parent.user as string },
      });

      const slackMessage = await prisma.slackMessage.create({
        data: {
          text: parent.text || "",
          ts: parent.ts || "",
          actionItem: {
            create: {
              lastReplyOn: parent.latest_reply
                ? dayjs(parent.latest_reply.split(".")[0], "X").toDate()
                : undefined,
              firstReplyOn: threadReplies?.[0]?.ts
                ? dayjs(threadReplies[0].ts.split(".")[0], "X").toDate()
                : undefined,
              totalReplies: parent.reply_count || 0,
              status: ActionStatus.open,
            },
          },
          channel: { connect: { slackId: event.channel } },
          author: { connect: { id: author.id } },
        },
        include: { actionItem: true },
      });

      await syncParticipants(parent.reply_users || [], slackMessage.actionItem?.id ?? -1);
    }
  } catch (err) {
    logger.error(err);
  }
});

// fix not in channel error

slack.command("/slacker", async ({ command, ack, client, logger, body }) => {
  await ack();

  try {
    const { text, user_id, channel_id } = command;
    const [project, filter] = text.split(" ");

    const files = readdirSync("./config");
    if (!files.includes(`${project}.yaml`)) {
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

    const config = yaml.load(readFileSync(`./config/${project}.yaml`, "utf-8")) as Config;
    const channels = config["slack-channels"];
    const repositories = config["repos"];
    const managers = config["slack-managers"];
    const maintainers = config.maintainers;

    if (!managers.includes(user_id)) {
      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `:warning: Sorry, you are not a manager for this project. Make sure you're listed inside the config/[project].yaml file.`,
      });
      return;
    }

    const user = await prisma.user.findFirst({ where: { slackId: user_id } });

    const data = await prisma.actionItem.findMany({
      where: {
        OR: [
          ...(!filter || filter === "all" || filter === "slack"
            ? [{ slackMessage: { channel: { slackId: { in: channels.map((c) => c.id) } } } }]
            : []),
          ...((!filter || filter === "all" || filter === "github") &&
          maintainers.includes(user?.githubUsername ?? "")
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
      text: `:white_check_mark: Here are your action items:`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:white_check_mark: Here are your action items:`,
          },
        },
        {
          type: "divider",
        },
        ...data.map((item) => ({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Query: *${item.slackMessage?.text}*\n\nOpened by <@${
              item.slackMessage?.author?.slackId
            }> on ${dayjs(item.slackMessage?.createdAt).format("MMM DD, YYYY")} at ${dayjs(
              item.slackMessage?.createdAt
            ).format("hh:mm A")}\n*Last reply:* ${dayjs(
              item.lastReplyOn
            ).fromNow()}\n<https://hackclub.slack.com/archives/${
              item.slackMessage?.channel?.slackId
            }/p${item.slackMessage?.ts.replace(".", "")}|View on Slack>`,
          },
          accessory: {
            type: "button",
            text: {
              type: "plain_text",
              emoji: true,
              text: "Resolve",
            },
            style: "primary",
            value: item.id.toString(),
          },
        })),
        { type: "divider" },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `*Total action items:* ${data.length}`,
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `In order to get github items, please <https://slacker.underpass.clb.li/auth|authenticate> slacker to access your github account.`,
          },
        },
      ],
    });
  } catch (err) {
    logger.error(err);
  }
});

(async () => {
  try {
    await slack.start(process.env.PORT || 5000);
    // await joinChannels();
    console.log(`Server running on http://localhost:5000`);
  } catch (err) {
    console.error(err);
  }
})();
