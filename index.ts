import { expressConnectMiddleware } from "@connectrpc/connect-express";
import { createOAuthUserAuth } from "@octokit/auth-app";
import { createNodeMiddleware } from "@octokit/webhooks";
import { ActionStatus, User } from "@prisma/client";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
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

dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);
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
  logLevel: LogLevel.INFO,
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

      await indexDocument(slackMessage.actionItem!.id);
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
        include: { actionItem: true },
      });

      await syncParticipants(
        Array.from(new Set(parent.reply_users)) || [],
        slackMessage.actionItem!.id
      );

      await indexDocument(slackMessage.actionItem!.id);
    }
  } catch (err) {
    metrics.increment("errors.slack.message", 1);
    logger.error(err);
  }
});

slack.command("/slacker", handleSlackerCommand);
slack.action("resolve", resolve);
slack.action("snooze", snooze);
slack.action("followup", followUp);
slack.action("unsnooze", unsnooze);
slack.action("irrelevant", markIrrelevant);
slack.action("assigned", assigned);
slack.action("notes", notes);
slack.action("prompt-assignee-yes", promptAssigneeYes);
slack.action("prompt-assignee-no", promptAssigneeNo);
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
          githubItem: { select: { repository: true, number: true } },
          slackMessage: { select: { channel: true, ts: true } },
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

      const url = item.githubItem
        ? `${item.githubItem.repository.url}/issues/${item.githubItem.number}`
        : `https://hackclub.slack.com/archives/${
            item.slackMessage?.channel?.slackId
          }/p${item.slackMessage?.ts.replace(".", "")}`;

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
        githubItem: { select: { repository: true, number: true } },
        slackMessage: { select: { channel: true, ts: true } },
      },
    });

    for await (const item of items) {
      const snoozedUntil = dayjs(item.snoozedUntil);
      const now = dayjs();
      const diff = now.diff(snoozedUntil, "hour", true).toFixed(2);

      if (snoozedUntil.isAfter(now) || parseFloat(diff) >= 1) continue;

      const url = item.githubItem
        ? `${item.githubItem.repository.url}/issues/${item.githubItem.number}`
        : `https://hackclub.slack.com/archives/${
            item.slackMessage?.channel?.slackId
          }/p${item.slackMessage?.ts.replace(".", "")}`;

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
        actionItem: {
          include: {
            assignee: true,
            githubItem: { select: { repository: true, number: true } },
            slackMessage: { select: { channel: true, ts: true } },
          },
        },
        user: true,
      },
    });

    for await (const f of followUps) {
      const followUpOn = dayjs(f.date);
      const now = dayjs();
      const diff = now.diff(followUpOn, "hour", true).toFixed(2);

      if (followUpOn.isAfter(now) || parseFloat(diff) >= 1) continue;

      const url = f.actionItem.githubItem
        ? `${f.actionItem.githubItem.repository.url}/issues/${f.actionItem.githubItem.number}`
        : `https://hackclub.slack.com/archives/${
            f.actionItem.slackMessage?.channel?.slackId
          }/p${f.actionItem.slackMessage?.ts.replace(".", "")}`;

      await slack.client.chat.postMessage({
        channel: f.user?.slackId ?? "",
        text: `:wave: Hey, you asked us to follow up on <${url}|${f.actionItem.id}>. Take a look into it again if needed!`,
      });

      if (f.actionItem.assigneeId !== f.user?.id)
        await slack.client.chat.postMessage({
          channel: f.actionItem.assignee?.slackId ?? "",
          text: `:wave: Hey, you asked us to follow up on <${url}|${f.actionItem.id}>. Take a look into it again if needed!`,
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
                      slackMessage: {
                        channel: { slackId: { in: channels?.map((c) => c.id) } },
                      },
                    }
                  : {},
                repos
                  ? { githubItem: { repository: { url: { in: repos.map((r) => r.uri) } } } }
                  : {},
              ],
            },
            include: { slackMessage: true, githubItem: true, assignee: true },
          });

          const open = items.filter(
            (item) =>
              item.status === ActionStatus.open &&
              (item.snoozedUntil === null || dayjs(item.snoozedUntil).isBefore(dayjs()))
          );
          const openMessages = open.filter((item) => item.slackMessageId);
          const openPRs = open.filter((item) => item.githubItem?.type === "pull_request");
          const openIssues = open.filter((item) => item.githubItem?.type === "issue");

          const closed = items.filter(
            (item) =>
              item.status === ActionStatus.closed &&
              dayjs(item.resolvedAt).isAfter(dayjs().subtract(6, "days"))
          );
          const closedMessages = closed.filter((item) => item.slackMessageId);
          const closedPRs = closed.filter((item) => item.githubItem?.type === "pull_request");
          const closedIssues = closed.filter((item) => item.githubItem?.type === "issue");

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
      where: { githubItem: { state: "open" } },
      select: { githubItem: { include: { repository: true } } },
    });

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.githubItem) continue;

      const project = getProjectName({ repoUrl: item.githubItem?.repository.url });
      if (!project) continue;

      const config = getYamlFile(`${project}.yaml`);
      if (!config.clawback) continue;

      const ghItem = await getGithubItem(
        item.githubItem.repository.owner,
        item.githubItem.repository.name,
        item.githubItem.nodeId
      );

      if (ghItem.node.assignees.nodes.length < 1) continue;
      const assignedOn = dayjs(
        item.githubItem.lastAssignedOn || ghItem.node.assignees.nodes[0].createdAt
      );
      let deadline = assignedOn;

      let count = 0;

      while (count < 5) {
        deadline = deadline.add(1, "day");
        if (deadline.day() !== 0 && deadline.day() !== 6) count++;
      }

      if (dayjs().isBefore(deadline)) continue;

      // it's been over the deadline since it was assigned. now we either have to prompt them to confirm or unassign them.
      if (
        item.githubItem.lastPromptedOn &&
        dayjs(item.githubItem.lastPromptedOn).isAfter(deadline)
      ) {
        // they have been prompted, unassign them after two days
        const unassignDeadline = dayjs(deadline).add(2, "day");
        if (dayjs().isBefore(unassignDeadline)) continue;

        const assignee = await prisma.user.findFirst({
          where: { githubUsername: ghItem.node.assignees.nodes[0].login },
        });

        const octokit = new Octokit({
          auth:
            "Bearer " +
            (await getOctokitToken(
              item.githubItem.repository.owner,
              item.githubItem.repository.name
            )),
        });

        await octokit.rest.issues.removeAssignees({
          owner: item.githubItem.repository.owner,
          repo: item.githubItem.repository.name,
          issue_number: item.githubItem.number,
          assignees: [ghItem.node.assignees.nodes[0].login],
        });

        await slack.client.chat.postMessage({
          channel: assignee?.slackId ?? "",
          text: `:warning: Hey, we unassigned #${item.githubItem.number} *<${item.githubItem.repository.url}/issues/${item.githubItem.number}|${item.githubItem.title}>* from you because you didn't resolve it in time. Feel free to pick it up again!`,
        });
      } else {
        // prompt them to confirm
        const assignee = await prisma.user.findFirst({
          where: { githubUsername: ghItem.node.assignees.nodes[0].login },
        });

        await slack.client.chat.postMessage({
          channel: assignee?.slackId ?? "",
          text: `:wave: Hey, we noticed that you've been assigned #${item.githubItem.number} *<${item.githubItem.repository.url}/issues/${item.githubItem.number}|${item.githubItem.title}>* for a while now. Are you still working on it?`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:wave: Hey, we noticed that you've been assigned #${item.githubItem.number} *<${item.githubItem.repository.url}/issues/${item.githubItem.number}|${item.githubItem.title}>* for a while now. Are you still working on it?`,
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
                  value: item.githubItem.nodeId,
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "No, I'm not working on it anymore" },
                  style: "danger",
                  action_id: "prompt-assignee-no",
                  value: `${item.githubItem.nodeId}-${ghItem.node.assignees.nodes[0].login}`,
                },
              ],
            },
          ],
        });

        await prisma.githubItem.update({
          where: { id: item.githubItem.id },
          data: { lastPromptedOn: new Date() },
        });
      }
    }
  } catch (err) {
    console.log("🚨🚨 Error in stale assigned issues cron job 🚨🚨");
    console.error(err);
  }
});

const backFill = async () => {
  const actionItems = await prisma.actionItem.findMany({});

  for await (const item of actionItems) {
    console.log(`Backfilling ${actionItems.indexOf(item) + 1}/${actionItems.length}`);
    await indexDocument(item.id);
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
