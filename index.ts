import { expressConnectMiddleware } from "@connectrpc/connect-express";
import { ActionStatus } from "@prisma/client";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import dayjs from "dayjs";
import { config } from "dotenv";
import express from "express";
import prisma from "./lib/db";
import { getMaintainers, joinChannels } from "./lib/utils";
import routes from "./routes";

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
    if (message.subtype || message.bot_id) return;

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

    const authorInfo = await client.users
      .info({ user: parent.user as string })
      .then((res) => res.user as typeof res.user & { email?: string });

    if (parentInDb) {
      // update action item:
      const action = await prisma.slackMessage.update({
        where: { id: parentInDb.id },
        data: {
          text: parent.text || "",
          actionItem: {
            update: {
              firstReplyOn: threadReplies?.[0]?.ts,
              lastReplyOn: parent.latest_reply ? dayjs(parent.latest_reply).toDate() : undefined,
              totalReplies: parent.reply_count || 0,
              participants: { deleteMany: {} },
            },
          },
        },
      });

      for (let i = 0; i < (parent.reply_users_count ?? 0); i++) {
        await prisma.participant.create({
          data: {
            actionItem: { connect: { id: action.id } },
            user: {
              connectOrCreate: {
                where: { slackId: parent.reply_users?.[i] as string },
                create: { slackId: parent.reply_users?.[i] as string },
              },
            },
          },
        });
      }
    } else {
      // create new action item:
      const maintainers = await getMaintainers({ channelId: event.channel });
      if (maintainers.includes(parent.user as string)) return;

      const action = await prisma.slackMessage.create({
        data: {
          text: parent.text || "",
          ts: parent.ts || "",
          actionItem: {
            create: {
              lastReplyOn: parent.latest_reply ? dayjs(parent.latest_reply).toDate() : undefined,
              firstReplyOn: threadReplies?.[0]?.ts
                ? dayjs(threadReplies[0].ts).toDate()
                : undefined,
              totalReplies: parent.reply_count || 0,
              status: ActionStatus.open,
            },
          },
          channel: { connect: { slackId: event.channel } },
          author: {
            connectOrCreate: {
              where: { slackId: parent.user as string, email: authorInfo?.email || "" },
              create: { email: authorInfo?.email || "", slackId: parent.user as string },
            },
          },
        },
      });

      for (let i = 0; i < (parent.reply_users_count ?? 0); i++) {
        await prisma.participant.create({
          data: {
            actionItem: { connect: { id: action.id } },
            user: {
              connectOrCreate: {
                where: { slackId: parent.reply_users?.[i] as string },
                create: { slackId: parent.reply_users?.[i] as string },
              },
            },
          },
        });
      }
    }
  } catch (err) {
    logger.error(err);
  }
});

(async () => {
  try {
    await slack.start(5000);
    await joinChannels();
    console.log(`Server running on http://localhost:5000`);
  } catch (err) {
    console.error(err);
  }
})();
