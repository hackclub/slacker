import { expressConnectMiddleware } from "@connectrpc/connect-express";
import { createOAuthUserAuth } from "@octokit/auth-app";
import { createNodeMiddleware } from "@octokit/webhooks";
import { ActionItem, ActionStatus, SlackMessage, User } from "@prisma/client";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import minMax from "dayjs/plugin/minMax";
import relativeTime from "dayjs/plugin/relativeTime";
import { config } from "dotenv";
import express from "express";
import { readdirSync } from "fs";
import cron from "node-cron";
import { Octokit } from "octokit";
import responseTime from "response-time";
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
import { elastic, indexDocument } from "./lib/elastic";
import metrics from "./lib/metrics";
import { getGithubItem, getOctokitToken, webhooks } from "./lib/octokit";
import {
  MAINTAINERS,
  getMaintainers,
  getProjectDetails,
  getProjectName,
  getYamlFile,
  joinChannels,
  syncParticipants,
} from "./lib/utils";
import { irrelevantSubmit, notesSubmit, resolveSubmit, snoozeSubmit } from "./lib/views";
import routes from "./routes";
import { buttons, githubItem, slackItem } from "./lib/blocks";

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
  const maintainer = MAINTAINERS.find((m) => m.slack === id);

  if (maintainer && user.data.login !== maintainer.github)
    return res.json({
      error: `We see that you're trying to authenticate as ${user.data.login}, but you're registered as ${maintainer.github} in the config. Please authenticate as ${maintainer.github} instead.`,
    });

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
  logLevel: LogLevel.DEBUG,
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// Airtable, Toriel, Pizza Bot
const ALLOWED_BOTS = ["B03QGF0H9FU", "B03701P4QN8", "B05SHCXE1UY"];
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
    }
  } catch (err) {
    metrics.increment("errors.slack.message", 1);
    logger.error(err);
  }
});

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

cron.schedule("0 * * * *", async () => {
  console.log("⏳⏳ Running unassign cron job ⏳⏳");

  try {
    const items = await prisma.actionItem
      .findMany({
        where: {
          assigneeId: { not: null },
          assignedOn: { not: null },
          status: ActionStatus.open,
        },
        include: {
          assignee: true,
          githubItems: { select: { repository: true, number: true } },
          slackMessages: { select: { channel: true, ts: true } },
        },
      })
      .then((res) =>
        res.filter(
          (item) => item.snoozedUntil === null || dayjs(item.snoozedUntil).isBefore(dayjs())
        )
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

      const url =
        item.githubItems.length > 0
          ? `${item.githubItems.at(-1)?.repository.url}/issues/${item.githubItems.at(-1)?.number}`
          : `https://hackclub.slack.com/archives/${
              item.slackMessages.at(-1)?.channel?.slackId
            }/p${item.slackMessages.at(-1)?.ts.replace(".", "")}`;

      await slack.client.chat.postMessage({
        channel: item.assignee?.slackId ?? "",
        text: `:warning: Hey, we unassigned <${url}|${item.id}> from you because you didn't resolve it in time. Feel free to pick it up again!`,
      });

      await indexDocument(item.id);
    }
  } catch (err) {
    console.log("🚨🚨 Error in unassign cron job 🚨🚨");
    console.error(err);
  }
});

cron.schedule("0 * * * *", async () => {
  console.log("⏳⏳ Running unsnooze cron job ⏳⏳");
  try {
    const items = await prisma.actionItem.findMany({
      where: { snoozedUntil: { not: null }, status: ActionStatus.open },
      include: {
        snoozedBy: true,
        assignee: true,
        githubItems: { select: { repository: true, number: true } },
        slackMessages: { select: { channel: true, ts: true } },
      },
    });

    for await (const item of items) {
      const snoozedUntil = dayjs(item.snoozedUntil);
      const now = dayjs();
      const diff = now.diff(snoozedUntil, "hour", true).toFixed(2);

      if (snoozedUntil.isAfter(now) || parseFloat(diff) >= 1) continue;

      const url =
        item.githubItems.length > 0
          ? `${item.githubItems.at(-1)?.repository.url}/issues/${item.githubItems.at(-1)?.number}`
          : `https://hackclub.slack.com/archives/${
              item.slackMessages.at(-1)?.channel?.slackId
            }/p${item.slackMessages.at(-1)?.ts.replace(".", "")}`;

      await slack.client.chat.postMessage({
        channel: item.snoozedBy?.slackId ?? "",
        text: `:wave: Hey, we unsnoozed <${url}|${item.id}> for you. Feel free to pick it up again!`,
      });
    }
  } catch (err) {
    console.log("🚨🚨 Error in unsnooze cron job 🚨🚨");
    console.error(err);
  }
});

cron.schedule("0 * * * *", async () => {
  console.log("⏳⏳ Running follow up cron job ⏳⏳");
  try {
    const followUps = await prisma.followUp.findMany({
      include: {
        parent: {
          include: {
            githubItems: { include: { author: true, repository: true } },
            slackMessages: { include: { author: true, channel: true } },
            participants: { include: { user: true } },
            assignee: true,
          },
        },
        nextItem: { include: { assignee: true } },
      },
    });

    for await (const followUp of followUps) {
      const now = dayjs();
      const followUpOn = dayjs(followUp.date);
      const diff = parseFloat(now.diff(followUpOn, "hour", true).toFixed(2));

      if (followUpOn.isAfter(now) || diff >= 1) continue;

      const url =
        followUp.parent.githubItems.length > 0
          ? `${followUp.parent.githubItems.at(-1)?.repository.url}/issues/${
              followUp.parent.githubItems.at(-1)?.number
            }`
          : `https://hackclub.slack.com/archives/${
              followUp.parent.slackMessages.at(-1)?.channel?.slackId
            }/p${followUp.parent.slackMessages.at(-1)?.ts.replace(".", "")}`;

      await prisma.followUp.update({
        where: {
          parentId_nextItemId: { parentId: followUp.parentId, nextItemId: followUp.nextItemId },
        },
        data: { nextItem: { update: { status: "open" } } },
      });

      const followUpDuration = dayjs(followUp.date).diff(
        followUp.parent.resolvedAt ?? followUp.createdAt,
        "day"
      );

      await slack.client.chat.postMessage({
        channel: followUp.nextItem.assignee?.slackId ?? "",
        text: `:wave: Hey, you asked us to follow up with you about <${url}|${followUp.parent.id}>. Take a look at it again!`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:wave: Hey, you asked us to follow up with you about <${url}|${followUp.parent.id}>. Take a look at it again!`,
            },
          },
          ...(followUp.parent.githubItems.length > 0
            ? [
                githubItem({
                  item: followUp.parent,
                  followUp: { id: followUp.nextItemId, duration: followUpDuration },
                }),
              ]
            : followUp.parent.slackMessages.length > 0
            ? [
                slackItem({
                  item: followUp.parent,
                  followUp: { id: followUp.nextItemId, duration: followUpDuration },
                }),
              ]
            : []),
          ...buttons({
            item: followUp.parent,
            showAssignee: true,
            showActions: true,
            followUpId: followUp.nextItemId,
          }),
        ],
      });
    }
  } catch (err) {
    console.log("🚨🚨 Error in follow up cron job 🚨🚨");
    console.error(err);
  }
});

cron.schedule(
  "0 12 * * FRI",
  async () => {
    console.log("⏳⏳ Running status report cron job ⏳⏳");
    try {
      for await (const maintainer of MAINTAINERS) {
        const files = readdirSync("./config");
        let text = `:wave: Hey ${maintainer.id}, here's your weekly status report!`;
        const user = await prisma.user.findFirst({
          where: { OR: [{ slackId: maintainer.slack }, { githubUsername: maintainer.github }] },
        });

        if (!user || user.optOut) continue;

        for await (const file of files) {
          const { maintainers, channels, repos } = getYamlFile(file);
          if (!maintainers.includes(maintainer.id)) continue;

          const items = await prisma.actionItem.findMany({
            where: {
              OR: [
                channels
                  ? {
                      slackMessages: {
                        some: {
                          channel: { slackId: { in: channels?.map((c) => c.id) } },
                        },
                      },
                    }
                  : {},
                repos
                  ? {
                      githubItems: {
                        some: { repository: { url: { in: repos.map((r) => r.uri) } } },
                      },
                    }
                  : {},
              ],
            },
            include: { slackMessages: true, githubItems: true, assignee: true },
          });

          const open = items.filter(
            (item) =>
              item.status === ActionStatus.open &&
              (item.snoozedUntil === null || dayjs(item.snoozedUntil).isBefore(dayjs()))
          );
          const openMessages = open.filter((item) => item.slackMessages.length > 0);
          const openPRs = open.filter(
            (item) => item.githubItems.filter((i) => i.type === "pull_request").length > 0
          );
          const openIssues = open.filter(
            (item) => item.githubItems.filter((i) => i.type === "issue").length > 0
          );

          const closed = items.filter(
            (item) =>
              item.status === ActionStatus.closed &&
              dayjs(item.resolvedAt).isAfter(dayjs().subtract(6, "days"))
          );
          const closedMessages = closed.filter((item) => item.slackMessages.length > 0);
          const closedPRs = closed.filter(
            (item) => item.githubItems.filter((i) => i.type === "pull_request").length > 0
          );
          const closedIssues = closed.filter(
            (item) => item.githubItems.filter((i) => i.type === "issue").length > 0
          );

          const assigned = open.filter((item) => item.assigneeId !== null);
          const contributors = Array.from(
            new Set(
              assigned.map(
                (item) =>
                  MAINTAINERS.find(
                    (m) =>
                      m.slack === item.assignee?.slackId ||
                      m.github === item.assignee?.githubUsername
                  )?.id ||
                  item.assignee?.githubUsername ||
                  item.assignee?.slackId ||
                  item.assignee?.email ||
                  ""
              )
            )
          );

          text += `\n\nProject: *${file.replace(".yml", "")}*`;
          text += `\nOpen action items: ${open.length} (${openMessages.length} slack messages, ${openPRs.length} pull requests, ${openIssues.length} issues)`;
          text += `\nTriaged this week: ${closed.length} (${closedMessages.length} slack messages, ${closedPRs.length} pull requests, ${closedIssues.length} issues)`;
          text += `\nTotal contributors: ${contributors.length} ${
            contributors.length > 0 ? `(${contributors.join(", ")})` : ""
          }`;
        }

        text += `\n\nYou can opt out of these daily status reports by running \`/slacker opt-out\`.`;
        await slack.client.chat.postMessage({ channel: maintainer.slack, text });
      }
    } catch (err) {
      console.log("🚨🚨 Error in status report cron job 🚨🚨");
      console.error(err);
    }
  },
  { timezone: "America/New_York" }
);

cron.schedule(
  "0 12 * * FRI",
  async () => {
    console.log("⏳⏳ Running review requests report cron job ⏳⏳");
    try {
      for await (const maintainer of MAINTAINERS) {
        let text = `:wave: Hey ${maintainer.id}!`;

        const { repositories } = await getProjectDetails(
          "all",
          maintainer.slack,
          maintainer.github
        );

        if (repositories.length === 0) continue;

        const octokit = new Octokit();
        const q = `${repositories
          .map((r) => "repo:" + r.uri.split("/")[3] + "/" + r.uri.split("/")[4])
          .join(" ")} state:open type:pr review-requested:${
          maintainer.github
        } user-review-requested:${maintainer.github}`;

        const { data } = await octokit.rest.search.issuesAndPullRequests({ q });
        if (data.total_count === 0) continue;

        text += `\nYou have ${data.total_count} pull requests that need your review:\n`;
        data.items.forEach((item) => {
          text += `\n• ${item.title} (${item.html_url})`;
        });

        await slack.client.chat.postMessage({ channel: maintainer.slack, text });
      }
    } catch (err) {
      console.log("🚨🚨 Error in review requests report cron job 🚨🚨");
      console.error(err);
    }
  },
  { timezone: "America/New_York" }
);

cron.schedule("0 12 * * *", async () => {
  console.log("⏳⏳ Running stale assigned issues cron job ⏳⏳");

  try {
    const items = await prisma.actionItem.findMany({
      where: { githubItems: { some: { state: "open" } } },
      select: { githubItems: { include: { repository: true } } },
    });

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.githubItems.length < 1) continue;

      const gh = item.githubItems.at(-1);
      if (!gh) continue;

      const project = getProjectName({ repoUrl: gh.repository.url });
      if (!project) continue;

      const config = getYamlFile(`${project}.yaml`);
      if (!config.clawback) continue;

      const ghItem = await getGithubItem(gh.repository.owner, gh.repository.name, gh.nodeId);

      if (ghItem.node.assignees.nodes.length < 1) continue;
      const assignedOn = dayjs(
        gh.lastAssignedOn || ghItem.node.timelineItems.edges[0]?.node.createdAt
      );
      let deadline = assignedOn;

      let count = 0;

      while (count < 5) {
        deadline = deadline.add(1, "day");
        if (deadline.day() !== 0 && deadline.day() !== 6) count++;
      }

      if (dayjs().isBefore(deadline)) continue;

      // it's been over the deadline since it was assigned. now we either have to prompt them to confirm or unassign them.
      if (gh.lastPromptedOn && dayjs(gh.lastPromptedOn).isAfter(deadline)) {
        // they have been prompted, unassign them after two days
        const unassignDeadline = dayjs(deadline).add(2, "day");
        if (dayjs().isBefore(unassignDeadline)) continue;

        const assignee = await prisma.user.findFirst({
          where: { githubUsername: ghItem.node.assignees.nodes[0].login },
        });

        const octokit = new Octokit({
          auth: "Bearer " + (await getOctokitToken(gh.repository.owner, gh.repository.name)),
        });

        await octokit.rest.issues.removeAssignees({
          owner: gh.repository.owner,
          repo: gh.repository.name,
          issue_number: gh.number,
          assignees: [ghItem.node.assignees.nodes[0].login],
        });

        await slack.client.chat.postMessage({
          channel: assignee?.slackId ?? "",
          text: `:warning: Hey, we unassigned #${gh.number} *<${gh.repository.url}/issues/${gh.number}|${gh.title}>* from you because you didn't resolve it in time. Feel free to pick it up again!`,
        });

        metrics.increment("gh.clawback.unassign", 1);
      } else {
        // prompt them to confirm
        const assignee = await prisma.user.findFirst({
          where: { githubUsername: ghItem.node.assignees.nodes[0].login },
        });

        await slack.client.chat.postMessage({
          channel: assignee?.slackId ?? "",
          text: `:wave: Hey, we noticed that you've been assigned #${gh.number} *<${gh.repository.url}/issues/${gh.number}|${gh.title}>* for a while now. Are you still working on it?`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:wave: Hey, we noticed that you've been assigned #${gh.number} *<${gh.repository.url}/issues/${gh.number}|${gh.title}>* for a while now. Are you still working on it?`,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Yes, I'm still working on it" },
                  style: "primary",
                  action_id: "prompt-assignee-yes",
                  value: gh.nodeId,
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "No, I'm not working on it anymore" },
                  style: "danger",
                  action_id: "prompt-assignee-no",
                  value: `${gh.nodeId}-${ghItem.node.assignees.nodes[0].login}`,
                },
              ],
            },
          ],
        });

        await prisma.githubItem.update({
          where: { id: gh.id },
          data: { lastPromptedOn: new Date() },
        });

        metrics.increment("gh.clawback.prompt", 1);
      }
    }
  } catch (err) {
    console.log("🚨🚨 Error in stale assigned issues cron job 🚨🚨");
    console.error(err);
  }
});

const backFill = async () => {
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

const checkDuplicateResources = async () => {
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
