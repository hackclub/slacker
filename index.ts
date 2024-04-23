import { expressConnectMiddleware } from "@connectrpc/connect-express";
import { createNodeMiddleware } from "@octokit/webhooks";
import { ActionItem, ActionStatus, SlackMessage, User } from "@prisma/client";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import minMax from "dayjs/plugin/minMax";
import relativeTime from "dayjs/plugin/relativeTime";
import { config } from "dotenv";
import express from "express";
import cron from "node-cron";
import responseTime from "response-time";
import { authHandler } from "./api/auth";
import { callbackHandler } from "./api/auth/callback";
import { indexHandler } from "./api/index";
import { followUpCron } from "./cron/followUp";
import { reportCron } from "./cron/report";
import { reviewCron } from "./cron/review";
import { unassignCron } from "./cron/unassign";
import { unsnoozeCron } from "./cron/unsnooze";
import {
  assigned,
  followUp,
  gimmeAgain,
  markIrrelevant,
  notes,
  promptAssigneeNo,
  promptAssigneeYes,
  resolve,
  snooze,
  unsnooze,
} from "./lib/actions";
import { handleSlackerCommand } from "./lib/commands";
import prisma from "./lib/db";
import { indexDocument } from "./lib/elastic";
import metrics from "./lib/metrics";
import { webhooks } from "./lib/octokit";
import {
  checkDuplicateResources,
  checkNeedsNotifying,
  getMaintainers,
  getProjectName,
  getYamlFile,
  joinChannels,
  syncParticipants,
} from "./lib/utils";
import { irrelevantSubmit, notesSubmit, resolveSubmit, snoozeSubmit } from "./lib/views";
import routes from "./routes";

dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);
dayjs.extend(minMax);
config();

const app = express();
app.use(expressConnectMiddleware({ routes }));
app.use(createNodeMiddleware(webhooks));
app.use(
  responseTime((req, res, time) => {
    const stat = (req.method + "/" + req.url?.split("/")[1])
      .toLowerCase()
      .replace(/[:.]/g, "")
      .replace(/\//g, "_");
    const httpCode = res.statusCode;
    const timingStatKey = `http.response.${stat}`;
    const codeStatKey = `http.response.${stat}.${httpCode}`;
    metrics.timing(timingStatKey, time);
    metrics.increment(codeStatKey, 1);
  })
);

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET as string,
  app,
});

export const slack = new App({
  logLevel: LogLevel.INFO,
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

app.get("/", indexHandler);
app.get("/auth", authHandler);
app.get("/auth/callback", callbackHandler);

slack.command("/slacker", handleSlackerCommand);
slack.command("/slacker-dev", handleSlackerCommand);
slack.action("resolve", resolve);
slack.action("snooze", snooze);
slack.action("followup", followUp);
slack.action("unsnooze", unsnooze);
slack.action("irrelevant", markIrrelevant);
slack.action("assigned", assigned);
slack.action("notes", notes);
slack.action("prompt-assignee-yes", promptAssigneeYes);
slack.action("prompt-assignee-no", promptAssigneeNo);
slack.action("gimme_again", gimmeAgain);
slack.view("snooze_submit", snoozeSubmit);
slack.view("notes_submit", notesSubmit);
slack.view("irrelevant_submit", irrelevantSubmit);
slack.view("resolve_submit", resolveSubmit);

cron.schedule("0 * * * *", unassignCron);
cron.schedule("0 * * * *", unsnoozeCron);
cron.schedule("0 * * * *", followUpCron);
cron.schedule("0 12 * * FRI", reportCron, { timezone: "America/New_York" });
cron.schedule("0 12 * * FRI", reviewCron, { timezone: "America/New_York" });

// Airtable, Toriel, Pizza Bot
const ALLOWED_BOTS = ["B03QGF0H9FU", "B03701P4QN8", "B05SHCXE1UY", "B02F604SCGP"];
slack.event("message", async ({ event, client, logger, message }) => {
  try {
    if (message.subtype === "message_deleted") {
      await prisma.slackMessage.deleteMany({
        where: { ts: message.deleted_ts, channel: { slackId: event.channel } },
      });
    }

    if (message.subtype || (message.bot_id && !ALLOWED_BOTS.includes(message.bot_id))) return;
    if ((message.text?.length || 0) <= 4) return;
    if (message.text?.startsWith(":") && message.text?.endsWith(":") && !message.text.includes(" "))
      return;

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
          actionItem: { update: { participants: { deleteMany: {} } } },
          replies: parent.reply_count,
        },
        include: {
          actionItem: {
            include: { participants: { select: { user: true } }, slackMessages: true },
          },
        },
      });

      const firstReplyOn =
        threadReplies?.[0]?.ts && slackMessage.actionItem!.firstReplyOn
          ? dayjs.min([
              dayjs(threadReplies[0].ts.split(".")[0], "X"),
              dayjs(slackMessage.actionItem!.firstReplyOn),
            ])
          : slackMessage.actionItem!.firstReplyOn
          ? dayjs(slackMessage.actionItem!.firstReplyOn)
          : threadReplies?.[0]?.ts
          ? dayjs(threadReplies[0].ts.split(".")[0], "X")
          : undefined;

      const lastReplyOn =
        parent.latest_reply && slackMessage.actionItem!.lastReplyOn
          ? dayjs.max([
              dayjs(parent.latest_reply.split(".")[0], "X"),
              dayjs(slackMessage.actionItem!.lastReplyOn),
            ])
          : parent.latest_reply && !slackMessage.actionItem!.lastReplyOn
          ? dayjs(parent.latest_reply.split(".")[0], "X")
          : slackMessage.actionItem!.lastReplyOn && !parent.latest_reply
          ? dayjs(slackMessage.actionItem!.lastReplyOn)
          : undefined;

      await prisma.actionItem.update({
        where: { id: slackMessage.actionItem!.id },
        data: {
          firstReplyOn: firstReplyOn?.toDate(),
          lastReplyOn: lastReplyOn?.toDate(),
          totalReplies: slackMessage.actionItem!.slackMessages.reduce(
            (acc, cur) => acc + cur.replies,
            0
          ),
        },
      });

      const participants = Array.from(
        new Set(
          parent.reply_users?.concat(
            slackMessage.actionItem.participants
              .map((p) => p.user.slackId)
              .filter((p) => p) as string[]
          ) || []
        )
      );

      await syncParticipants(participants, slackMessage.actionItem!.id);
      await indexDocument(slackMessage.actionItem!.id);
    } else {
      // create new action item:
      // find user by slack id
      const user = await prisma.user.findFirst({ where: { slackId: parent.user as string } });
      let author: User;

      if (!user)
        author = await prisma.user.create({ data: { email, slackId: parent.user as string } });
      else author = user;

      const project = getProjectName({ channelId: event.channel });
      const details = getYamlFile(`${project}.yaml`);
      const grouping = details.channels?.find((c) => c.id === event.channel)?.grouping;
      const shouldGroup = grouping && typeof grouping?.minutes === "number";

      const recentSlackMessage = grouping?.minutes
        ? await prisma.slackMessage.findFirst({
            where: {
              channel: { slackId: event.channel },
              createdAt: { gte: dayjs().subtract(grouping.minutes, "minute").toDate() },
              actionItem: { status: ActionStatus.open, assigneeId: null },
            },
            include: { actionItem: { select: { id: true } } },
            orderBy: { createdAt: "desc" },
          })
        : null;

      let slackMessage: SlackMessage & {
        actionItem: ActionItem & { participants: { user: User }[]; slackMessages?: SlackMessage[] };
      };

      if (recentSlackMessage && shouldGroup) {
        slackMessage = await prisma.slackMessage.create({
          data: {
            text: parent.text || "",
            ts: parent.ts || "",
            replies: parent.reply_count,
            createdAt: dayjs(parent.ts?.split(".")[0], "X").toDate(),
            actionItem: { connect: { id: recentSlackMessage.actionItem!.id } },
            channel: { connect: { slackId: event.channel } },
            author: { connect: { id: author.id } },
          },
          include: {
            actionItem: {
              include: { participants: { select: { user: true } }, slackMessages: true },
            },
          },
        });

        const firstReplyOn =
          threadReplies?.[0]?.ts && slackMessage.actionItem!.firstReplyOn
            ? dayjs.min([
                dayjs(threadReplies[0].ts.split(".")[0], "X"),
                dayjs(slackMessage.actionItem!.firstReplyOn),
              ])
            : slackMessage.actionItem!.firstReplyOn
            ? dayjs(slackMessage.actionItem!.firstReplyOn)
            : threadReplies?.[0]?.ts
            ? dayjs(threadReplies[0].ts.split(".")[0], "X")
            : undefined;

        const lastReplyOn =
          parent.latest_reply && slackMessage.actionItem!.lastReplyOn
            ? dayjs.max([
                dayjs(parent.latest_reply.split(".")[0], "X"),
                dayjs(slackMessage.actionItem!.lastReplyOn),
              ])
            : parent.latest_reply && !slackMessage.actionItem!.lastReplyOn
            ? dayjs(parent.latest_reply.split(".")[0], "X")
            : slackMessage.actionItem!.lastReplyOn && !parent.latest_reply
            ? dayjs(slackMessage.actionItem!.lastReplyOn)
            : undefined;

        await prisma.actionItem.update({
          where: { id: recentSlackMessage.actionItem!.id },
          data: {
            firstReplyOn: firstReplyOn?.toDate(),
            lastReplyOn: lastReplyOn?.toDate(),
            totalReplies: slackMessage.actionItem!.slackMessages?.reduce(
              (acc, cur) => acc + cur.replies,
              0
            ),
          },
        });
      } else {
        const maintainers = getMaintainers({ channelId: event.channel });
        if (maintainers.find((maintainer) => maintainer?.slack === parent.user)) return;

        slackMessage = await prisma.slackMessage.create({
          data: {
            text: parent.text || "",
            ts: parent.ts || "",
            replies: parent.reply_count,
            createdAt: dayjs(parent.ts?.split(".")[0], "X").toDate(),
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
          include: { actionItem: { include: { participants: { select: { user: true } } } } },
        });
      }

      const participants = Array.from(
        new Set(
          parent.reply_users?.concat(
            slackMessage.actionItem.participants
              .map((p) => p.user.slackId)
              .filter((p) => p) as string[]
          ) || []
        )
      );

      await syncParticipants(participants, slackMessage.actionItem!.id);
      await indexDocument(slackMessage.actionItem!.id);
      await checkNeedsNotifying(slackMessage.actionItem!.id);
    }
  } catch (err) {
    metrics.increment("errors.slack.message", 1);
    logger.error(err);
  }
});

(async () => {
  try {
    metrics.increment("server.start.increment", 1);
    await checkDuplicateResources();
    await slack.start(process.env.PORT || 5000);
    await joinChannels();
    // await backFill();
    console.log(`Server running on http://localhost:5000`);
  } catch (err) {
    metrics.increment("server.start.error", 1);
    console.error(err);
  }
})();
