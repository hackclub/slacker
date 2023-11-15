import { expressConnectMiddleware } from "@connectrpc/connect-express";
import { createOAuthUserAuth } from "@octokit/auth-app";
import { ActionStatus, User } from "@prisma/client";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import relativeTime from "dayjs/plugin/relativeTime";
import { config } from "dotenv";
import express from "express";
import cron from "node-cron";
import { Octokit } from "octokit";
import { assigned, markIrrelevant, resolve, snooze, unsnooze } from "./lib/actions";
import { handleSlackerCommand } from "./lib/commands";
import prisma from "./lib/db";
import { getMaintainers, joinChannels, syncParticipants } from "./lib/utils";
import { snoozeSubmit } from "./lib/views";
import routes from "./routes";
dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);
config();

const app = express();
app.use(expressConnectMiddleware({ routes }));

app.get("/", async (_, res) => {
  res.send("Hello World!");
});

app.get("/auth", async (req, res) => {
  const id = req.query.id;

  if (!id) return res.json({ error: "No user id provided for the slack user" });

  res.redirect(
    `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&redirect_uri=${process.env.DEPLOY_URL}/auth/callback?id=${id}`
  );
});

app.get("/auth/callback", async (req, res) => {
  const { code, id } = req.query;

  if (!code) return res.json({ error: "No code provided" });
  if (!id) return res.json({ error: "No slackId provided" });

  const auth = createOAuthUserAuth({
    clientId: process.env.GITHUB_CLIENT_ID as string,
    clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
    code: code as string,
    scopes: ["email"],
  });

  const { token } = await auth();
  const octokit = new Octokit({ auth: token });
  const user = await octokit.rest.users.getAuthenticated();
  let email = user.data.email;

  if (!email) {
    const { user } = await slack.client.users.info({ user: id as string });
    email = user?.profile?.email || "";

    if (!email) return res.json({ error: "No email found for this user" });
  }

  // find many users with either the same email / username / slackId
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { email },
        { email: user.data.login },
        { githubUsername: user.data.login },
        { slackId: id.toString().toUpperCase() },
      ],
    },
  });

  if (users.length > 0) {
    // all these users need to be merged into one
    // save them into one user, connect all the relations to that one user and delete the rest.
    const userId = users[0].id;

    await prisma.slackMessage.updateMany({
      where: { authorId: { in: users.map((u) => u.id) } },
      data: { authorId: userId },
    });

    await prisma.githubItem.updateMany({
      where: { authorId: { in: users.map((u) => u.id) } },
      data: { authorId: userId },
    });

    await prisma.participant.updateMany({
      where: { userId: { in: users.map((u) => u.id) } },
      data: { userId: userId },
    });

    await prisma.actionItem.updateMany({
      where: { snoozedById: { in: users.map((u) => u.id) } },
      data: { snoozedById: userId },
    });

    await prisma.actionItem.updateMany({
      where: { assigneeId: { in: users.map((u) => u.id) } },
      data: { assigneeId: userId },
    });

    await prisma.user.deleteMany({
      where: { id: { in: users.map((u) => u.id).filter((i) => i !== userId) } },
    });

    // update the user
    await prisma.user.update({
      where: { id: userId },
      data: {
        email,
        githubUsername: user.data.login,
        githubToken: token,
        slackId: id.toString().toUpperCase(),
      },
    });
  } else {
    // create a new user
    await prisma.user.create({
      data: {
        email,
        githubUsername: user.data.login,
        githubToken: token,
        slackId: id.toString().toUpperCase(),
      },
    });
  }

  return res.json({ message: "OAuth successful, hacker! Go ahead and start using slacker!" });
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

const ALLOWED_BOTS = ["B03QGF0H9FU", "B03701P4QN8", "B05SHCXE1UY"];
slack.event("message", async ({ event, client, logger, message }) => {
  try {
    if (message.subtype === "message_deleted") {
      await prisma.slackMessage.deleteMany({
        where: { ts: message.deleted_ts, channel: { slackId: event.channel } },
      });
    }

    // B03QGF0H9FU = Airtable bot
    if (message.subtype || (message.bot_id && !ALLOWED_BOTS.includes(message.bot_id))) return;

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
      const slackMessage = await prisma.slackMessage.update({
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
        include: { actionItem: true },
      });

      await syncParticipants(
        Array.from(new Set(parent.reply_users)) || [],
        slackMessage.actionItem!.id
      );
    } else {
      // create new action item:
      const maintainers = getMaintainers({ channelId: event.channel });
      if (maintainers.find((maintainer) => maintainer?.slack === parent.user)) return;

      // find user by slack id
      const user = await prisma.user.findFirst({ where: { slackId: parent.user as string } });
      let author: User;

      if (!user)
        author = await prisma.user.create({ data: { email, slackId: parent.user as string } });
      else author = user;

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

      await syncParticipants(
        Array.from(new Set(parent.reply_users)) || [],
        slackMessage.actionItem!.id
      );
    }
  } catch (err) {
    logger.error(err);
  }
});

slack.command("/slacker", handleSlackerCommand);
slack.action("resolve", resolve);
slack.action("snooze", snooze);
slack.action("unsnooze", unsnooze);
slack.action("irrelevant", markIrrelevant);
slack.action("assigned", assigned);
slack.view("snooze_submit", snoozeSubmit);

cron.schedule("0 * * * *", async () => {
  const items = await prisma.actionItem
    .findMany({
      where: {
        assigneeId: { not: null },
        assignedOn: { not: null },
        status: ActionStatus.open,
      },
      include: { assignee: true },
    })
    .then((res) =>
      res.filter((item) => item.snoozedUntil === null || dayjs(item.snoozedUntil).isBefore(dayjs()))
    );

  for await (const item of items) {
    const assignedOn = dayjs(item.snoozedUntil || item.assignedOn);
    let deadline = assignedOn;

    let count = 0;
    while (count < 2) {
      deadline = deadline.add(1, "day");
      if (deadline.day() !== 0 && deadline.day() !== 6) count++;
    }

    if (dayjs().isBefore(deadline)) continue;
    await prisma.actionItem.update({ where: { id: item.id }, data: { assigneeId: null } });

    await slack.client.chat.postMessage({
      channel: item.assignee?.slackId ?? "",
      text: `:warning: Hey, we unassigned ${item.id} from you because you didn't resolve it in time. Feel free to pick it up again!`,
    });
  }
});

(async () => {
  try {
    await slack.start(process.env.PORT || 5000);
    await joinChannels();
    console.log(`Server running on http://localhost:5000`);
  } catch (err) {
    console.error(err);
  }
})();
