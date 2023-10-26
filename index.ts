import { expressConnectMiddleware } from "@connectrpc/connect-express";
import { ActionStatus } from "@prisma/client";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { config } from "dotenv";
import express from "express";
import prisma from "./lib/db";
import { getMaintainers, joinChannels, syncParticipants } from "./lib/utils";
import routes from "./routes";
import yaml from "js-yaml";
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { Config } from "./lib/types";

dayjs.extend(customParseFormat);
config();

const app = express();
app.use(expressConnectMiddleware({ routes }));

app.get("/", async (_, res) => {
  res.send("Hello World!");
});

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

    const data = await prisma.actionItem.findMany({
      where: {
        OR: [
          ...(!filter || filter === "all" || filter === "slack"
            ? [{ slackMessage: { channel: { slackId: { in: channels.map((c) => c.id) } } } }]
            : []),
          ...(!filter || filter === "all" || filter === "github"
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
        participants: true,
      },
    });

    console.log(data.length);

    writeFileSync("./output.json", JSON.stringify(data, null, 2));
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
