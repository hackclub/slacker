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
import { Config, SingleIssueOrPullData } from "./lib/types";
import { getMaintainers, syncGithubParticipants, syncParticipants } from "./lib/utils";
import routes from "./routes";
import { createOAuthUserAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { getOctokitToken } from "./lib/octokit";
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
    `https://github.com/login/oauth/authorize?client_id=${
      process.env.GITHUB_CLIENT_ID
    }&redirect_uri=${"https://slacker.underpass.clb.li/auth/callback?id=" + id}"}`
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

  if (!user.data.email) return res.json({ error: "No email found" });

  await prisma.user.deleteMany({
    where: { AND: [{ githubUsername: user.data.login }, { slackId: { equals: null } }] },
  });

  await prisma.user.updateMany({
    where: { OR: [{ email: user.data.email }, { slackId: id as string }] },
    data: { githubUsername: user.data.login, githubToken: token },
  });

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

      await syncParticipants(parent.reply_users || [], slackMessage.actionItem!.id);
    }
  } catch (err) {
    logger.error(err);
  }
});

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

    const data = await prisma.actionItem
      .findMany({
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
          text: {
            type: "mrkdwn",
            text: `:white_check_mark: Here are your action items:`,
          },
        },
        {
          type: "divider",
        },
        ...data
          .slice(0, 15)
          .map((item) => {
            const arr: any[] = [];
            const diff = dayjs().diff(dayjs(item.lastReplyOn), "day");

            if (item.slackMessage !== null) {
              arr.push({
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `Query: *${item.slackMessage?.text}*\n\nOpened by <@${
                    item.slackMessage?.author?.slackId
                  }> on ${dayjs(item.slackMessage?.createdAt).format("MMM DD, YYYY")} at ${dayjs(
                    item.slackMessage?.createdAt
                  ).format("hh:mm A")}${
                    item.lastReplyOn
                      ? `\n*Last reply:* ${dayjs(item.lastReplyOn).fromNow()} ${
                          diff > 10 ? ":panik:" : ""
                        }`
                      : "\n:panik: *No replies yet*"
                  }\n<https://hackclub.slack.com/archives/${
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
                  value: item.id,
                  action_id: "resolve",
                },
              });
            }

            if (item.githubItem !== null) {
              const text =
                (item.githubItem?.type === "issue" ? "Issue: " : "Pull Request: ") +
                `https://github.com/${item.githubItem?.repository?.owner}/${item.githubItem?.repository?.name}/issues/${item.githubItem?.number}`;

              arr.push({
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `${text}\n\nOpened by ${item.githubItem?.author?.githubUsername} on ${dayjs(
                    item.githubItem?.createdAt
                  ).format("MMM DD, YYYY")} at ${dayjs(item.githubItem?.createdAt).format(
                    "hh:mm A"
                  )}${
                    item.lastReplyOn
                      ? `\n*Last reply:* ${dayjs(item.lastReplyOn).fromNow()} ${
                          diff > 10 ? ":panik:" : ""
                        }`
                      : "\n:panik: *No replies yet*"
                  }`,
                },
                accessory: {
                  type: "button",
                  text: { type: "plain_text", emoji: true, text: "Resolve" },
                  style: "primary",
                  value: item.id,
                  action_id: "resolve",
                },
              });
            }

            // Buttons
            arr.push({
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", emoji: true, text: "Snooze" },
                  style: "danger",
                  value: item.id,
                  action_id: "snooze",
                },
                {
                  type: "button",
                  text: { type: "plain_text", emoji: true, text: "Close - Irrelevant" },
                  value: item.id,
                  action_id: "irrelevant",
                },
              ],
            });

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
                  : `In order to get github items, please <https://slacker.underpass.clb.li/auth?id=${user_id}|authenticate> slacker to access your github account.`
              }`,
            },
          ],
        },
      ],
    });
  } catch (err) {
    logger.error(err);
  }
});

slack.action("resolve", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const { user, channel, actions } = body as any;
    const actionId = actions[0].value;

    const action = await prisma.actionItem.findFirst({
      where: { id: actionId },
      include: {
        slackMessage: { include: { channel: true } },
        githubItem: { include: { repository: true } },
      },
    });

    if (!action) return;

    if (action.githubItem !== null) {
      const token = await getOctokitToken(
        action.githubItem.repository.owner,
        action.githubItem.repository.name
      );
      const octokit = new Octokit({ auth: "Bearer " + token });

      const query = `
        query ($id: String!) {
          node(id: $id) {
            ... on Issue {
              closedAt
              assignees(first: 100) {
                nodes {
                  login
                }
              }
              participants(first: 100) {
                nodes {
                  login
                }
              }
              comments(first: 100) {
                totalCount
                nodes {
                  author {
                    login
                  }
                  createdAt
                }
              }
            }
            ... on PullRequest {
              closedAt
              assignees(first: 100) {
                nodes {
                  login
                }
              }
              participants(first: 100) {
                nodes {
                  login
                }
              }
              comments(first: 100) {
                totalCount
                nodes {
                  author {
                    login
                  }
                  createdAt
                }
              }
            }
          }
        }
      `;

      const res = (await octokit.graphql(query, {
        id: action.githubItem.nodeId,
      })) as SingleIssueOrPullData;

      await prisma.githubItem.update({
        where: { nodeId: action.githubItem.nodeId },
        data: {
          state: "closed",
          actionItem: {
            update: {
              status: "closed",
              totalReplies: res.node.comments.totalCount,
              firstReplyOn: res.node.comments.nodes[0]?.createdAt,
              lastReplyOn: res.node.comments.nodes[res.node.comments.nodes.length - 1]?.createdAt,
              resolvedAt: res.node.closedAt,
              participants: { deleteMany: {} },
            },
          },
        },
        include: { actionItem: { include: { participants: true } } },
      });

      const logins = res.node.participants.nodes.map((node) => node.login);
      await syncGithubParticipants(logins, action.id);
    } else if (action.slackMessage !== null) {
      const parent = await client.conversations
        .history({
          channel: action.slackMessage.channel.slackId,
          latest: action.slackMessage.ts,
          limit: 1,
          inclusive: true,
        })
        .then((res) => res.messages?.[0]);

      if (!parent) return;

      const threadReplies = await client.conversations
        .replies({
          channel: action.slackMessage.channel.slackId,
          ts: parent.ts as string,
          limit: 100,
        })
        .then((res) => res.messages?.slice(1));

      await prisma.slackMessage.update({
        where: { id: action.slackMessage.id },
        data: {
          actionItem: {
            update: {
              status: "closed",
              lastReplyOn: parent.latest_reply
                ? dayjs(parent.latest_reply.split(".")[0], "X").toDate()
                : undefined,
              firstReplyOn: threadReplies?.[0]?.ts
                ? dayjs(threadReplies[0].ts.split(".")[0], "X").toDate()
                : undefined,
              totalReplies: parent.reply_count || 0,
              resolvedAt: new Date(),
              participants: { deleteMany: {} },
            },
          },
        },
        include: { actionItem: { include: { participants: true } } },
      });

      await syncParticipants(parent.reply_users || [], action.id);
    }

    await client.chat.postEphemeral({
      channel: channel?.id as string,
      user: user.id,
      text: `:white_check_mark: Action item (id=${actionId}) resolved by <@${user.id}>`,
    });
  } catch (err) {
    logger.error(err);
  }
});

slack.action("snooze", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const { actions, channel } = body as any;
    const actionId = actions[0].value;

    const action = await prisma.actionItem.findFirst({
      where: { id: actionId },
      include: {
        slackMessage: { include: { channel: true } },
        githubItem: { include: { repository: true } },
      },
    });

    if (!action) return;

    await client.views.open({
      trigger_id: (body as any).trigger_id as string,
      view: {
        type: "modal",
        callback_id: "snooze_submit",
        private_metadata: JSON.stringify({ actionId, channelId: channel?.id as string }),
        title: {
          type: "plain_text",
          text: "Snooze",
        },
        submit: {
          type: "plain_text",
          text: "Snooze",
        },
        blocks: [
          {
            type: "input",
            block_id: "datetime",
            element: {
              type: "datetimepicker",
              action_id: "datetimepicker-action",
              initial_date_time: Math.floor(dayjs().add(1, "day").valueOf() / 1000),
              focus_on_load: true,
            },
            label: {
              type: "plain_text",
              text: "Snooze until",
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `:bangbang: Snooze wisely. If you keep snoozing an item repeatedly, you'll be called out for slackin'.`,
              },
            ],
          },
        ],
      },
    });
  } catch (err) {
    logger.error(err);
  }
});

slack.view("snooze_submit", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const { user, view } = body;
    const { actionId, channelId } = JSON.parse(view.private_metadata);

    const action = await prisma.actionItem.findFirst({
      where: { id: actionId },
      include: {
        slackMessage: { include: { channel: true } },
        githubItem: { include: { repository: true } },
      },
    });

    if (!action) return;

    const { selected_date_time } = view.state.values.datetime["datetimepicker-action"];
    const snoozedUntil = dayjs(selected_date_time).toDate();
    const dbUser = await prisma.user.findFirst({ where: { slackId: user.id } });

    await prisma.actionItem.update({
      where: { id: actionId },
      data: { snoozedUntil, snoozeCount: { increment: 1 }, snoozedById: dbUser?.id },
    });

    await client.chat.postEphemeral({
      channel: channelId,
      user: user.id,
      text: `:white_check_mark: Action item (id=${actionId}) snoozed until ${dayjs(
        snoozedUntil
      ).format("MMM DD, YYYY hh:mm A")} by <@${user.id}> (Snooze count: ${action.snoozeCount + 1})`,
    });
  } catch (err) {
    logger.error(err);
  }
});

slack.action("irrelevant", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const { user, channel, actions } = body as any;
    const actionId = actions[0].value;

    const action = await prisma.actionItem.findFirst({
      where: { id: actionId },
      include: {
        slackMessage: { include: { channel: true } },
        githubItem: { include: { repository: true } },
      },
    });

    if (!action) return;

    if (action.githubItem !== null) {
      const token = await getOctokitToken(
        action.githubItem.repository.owner,
        action.githubItem.repository.name
      );
      const octokit = new Octokit({ auth: "Bearer " + token });

      const query = `
        query ($id: String!) {
          node(id: $id) {
            ... on Issue {
              closedAt
              assignees(first: 100) {
                nodes {
                  login
                }
              }
              participants(first: 100) {
                nodes {
                  login
                }
              }
              comments(first: 100) {
                totalCount
                nodes {
                  author {
                    login
                  }
                  createdAt
                }
              }
            }
            ... on PullRequest {
              closedAt
              assignees(first: 100) {
                nodes {
                  login
                }
              }
              participants(first: 100) {
                nodes {
                  login
                }
              }
              comments(first: 100) {
                totalCount
                nodes {
                  author {
                    login
                  }
                  createdAt
                }
              }
            }
          }
        }
      `;

      const res = (await octokit.graphql(query, {
        id: action.githubItem.nodeId,
      })) as SingleIssueOrPullData;

      await prisma.githubItem.update({
        where: { nodeId: action.githubItem.nodeId },
        data: {
          state: "closed",
          actionItem: {
            update: {
              status: "closed",
              totalReplies: res.node.comments.totalCount,
              firstReplyOn: res.node.comments.nodes[0]?.createdAt,
              lastReplyOn: res.node.comments.nodes[res.node.comments.nodes.length - 1]?.createdAt,
              resolvedAt: res.node.closedAt,
              participants: { deleteMany: {} },
              flag: "irrelevant",
            },
          },
        },
        include: { actionItem: { include: { participants: true } } },
      });

      const logins = res.node.participants.nodes.map((node) => node.login);
      await syncGithubParticipants(logins, action.id);
    } else if (action.slackMessage !== null) {
      const parent = await client.conversations
        .history({
          channel: action.slackMessage.channel.slackId,
          latest: action.slackMessage.ts,
          limit: 1,
          inclusive: true,
        })
        .then((res) => res.messages?.[0]);

      if (!parent) return;

      const threadReplies = await client.conversations
        .replies({
          channel: action.slackMessage.channel.slackId,
          ts: parent.ts as string,
          limit: 100,
        })
        .then((res) => res.messages?.slice(1));

      await prisma.slackMessage.update({
        where: { id: action.slackMessage.id },
        data: {
          actionItem: {
            update: {
              status: "closed",
              lastReplyOn: parent.latest_reply
                ? dayjs(parent.latest_reply.split(".")[0], "X").toDate()
                : undefined,
              firstReplyOn: threadReplies?.[0]?.ts
                ? dayjs(threadReplies[0].ts.split(".")[0], "X").toDate()
                : undefined,
              totalReplies: parent.reply_count || 0,
              resolvedAt: new Date(),
              participants: { deleteMany: {} },
              flag: "irrelevant",
            },
          },
        },
        include: { actionItem: { include: { participants: true } } },
      });

      await syncParticipants(parent.reply_users || [], action.id);
    }

    await client.chat.postEphemeral({
      channel: channel?.id as string,
      user: user.id,
      text: `:white_check_mark: Action item (id=${actionId}) closed as irrelevant by <@${user.id}>`,
    });
  } catch (err) {
    logger.error(err);
  }
});

(async () => {
  try {
    await slack.start(process.env.PORT || 5000);
    // slack.client.conversations.history({ channel: "D0618PEUGAZ" }).then((r) => {
    //   r.messages?.forEach(
    //     async (m) => await slack.client.chat.delete({ channel: "D0618PEUGAZ", ts: m.ts })
    //   );
    // });
    // await joinChannels();
    console.log(`Server running on http://localhost:5000`);
  } catch (err) {
    console.error(err);
  }
})();
