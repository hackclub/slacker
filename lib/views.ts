import {
  Block,
  KnownBlock,
  Middleware,
  SlackViewAction,
  SlackViewMiddlewareArgs,
} from "@slack/bolt";
import { StringIndexed } from "@slack/bolt/dist/types/helpers";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import relativeTime from "dayjs/plugin/relativeTime";
import prisma from "./db";
import { indexDocument } from "./elastic";
import { getGithubItem } from "./octokit";
import { logActivity, syncGithubParticipants, syncParticipants } from "./utils";
import metrics from "./metrics";
dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);

export const snoozeSubmit: Middleware<
  SlackViewMiddlewareArgs<SlackViewAction>,
  StringIndexed
> = async ({ ack, body, client, logger }) => {
  await ack();
  const { user, view } = body;
  const { actionId, channelId, messageId } = JSON.parse(view.private_metadata);

  try {
    const reason = view.state.values.reason["reason-action"].value;

    const action = await prisma.actionItem.findFirst({
      where: { id: actionId },
      include: {
        slackMessage: { include: { channel: true } },
        githubItem: { include: { repository: true } },
      },
    });

    if (!action) return;

    const { selected_date_time } = view.state.values.datetime["datetimepicker-action"];
    const snoozedUntil = dayjs(selected_date_time, "X").toDate();
    const dbUser = await prisma.user.findFirst({ where: { slackId: user.id } });

    await prisma.actionItem.update({
      where: { id: actionId },
      data: {
        snoozedUntil,
        snoozeCount: { increment: 1 },
        snoozedById: dbUser?.id,
        reason: reason ?? "",
      },
    });

    await client.chat.postEphemeral({
      channel: channelId,
      user: user.id,
      text: `:white_check_mark: Action item (id=${actionId}) snoozed until ${dayjs(
        snoozedUntil
      ).format("MMM DD, YYYY hh:mm A")} by <@${user.id}> (Snooze count: ${action.snoozeCount + 1})`,
    });

    const { messages } = await client.conversations.history({
      channel: channelId,
      latest: messageId,
      limit: 1,
      inclusive: true,
    });

    const blocks = messages?.[0].blocks || [];
    const idx = blocks.findIndex((block: any) => block.text && block.text.text.includes(actionId));
    const newBlocks = blocks.filter((_, i) => i !== idx && i !== idx + 1) as (Block | KnownBlock)[];

    await client.chat.update({
      ts: messageId,
      channel: channelId,
      text: `Message updated: ${messageId}`,
      blocks: newBlocks,
    });

    await indexDocument(actionId);
    await logActivity(client, user.id, action.id, "snoozed");
    metrics.increment("slack.snooze.submit", 1);
  } catch (err) {
    metrics.increment("errors.slack.snooze", 1);
    await client.chat.postEphemeral({
      channel: channelId,
      user: user.id,
      text: `:x: Failed to snooze action item (id=${actionId}) ${err.message}`,
    });
    logger.error(err);
  }
};

export const irrelevantSubmit: Middleware<
  SlackViewMiddlewareArgs<SlackViewAction>,
  StringIndexed
> = async ({ ack, body, client, logger }) => {
  await ack();
  const { user, view } = body;
  const { actionId, channelId, messageId } = JSON.parse(view.private_metadata);

  try {
    const reason = view.state.values.reason["reason-action"].value;

    const action = await prisma.actionItem.findFirst({
      where: { id: actionId },
      include: {
        slackMessage: { include: { channel: true } },
        githubItem: { include: { repository: true } },
      },
    });

    if (!action) return;

    if (action.githubItem !== null) {
      const res = await getGithubItem(
        action.githubItem.repository.owner,
        action.githubItem.repository.name,
        action.githubItem.nodeId
      );

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
              resolvedAt: new Date(),
              participants: { deleteMany: {} },
              flag: "irrelevant",
              reason: reason ?? "",
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
              reason: reason ?? "",
            },
          },
        },
        include: { actionItem: { include: { participants: true } } },
      });

      await syncParticipants(Array.from(new Set(parent.reply_users)) || [], action.id);
    }

    const { messages } = await client.conversations.history({
      channel: channelId,
      latest: messageId,
      limit: 1,
      inclusive: true,
    });

    const blocks = messages?.[0].blocks || [];
    const idx = blocks.findIndex((block: any) => block.text && block.text.text.includes(actionId));
    const newBlocks = blocks.filter((_, i) => i !== idx && i !== idx + 1) as (Block | KnownBlock)[];

    await client.chat.update({
      ts: messageId,
      channel: channelId,
      text: `Message updated: ${messageId}`,
      blocks: newBlocks,
    });

    await indexDocument(actionId);
    await logActivity(client, user.id, action.id, "irrelevant");
    metrics.increment("slack.irrelevant.submit", 1);
  } catch (err) {
    metrics.increment("errors.slack.irrelevant", 1);
    await client.chat.postEphemeral({
      channel: channelId,
      user: user.id,
      text: `:x: Failed to mark action item (id=${actionId}) as irrelevant ${err.message}`,
    });
    logger.error(err);
  }
};

export const resolveSubmit: Middleware<
  SlackViewMiddlewareArgs<SlackViewAction>,
  StringIndexed
> = async ({ ack, body, client, logger }) => {
  await ack();

  const { user, view } = body;
  const { actionId, channelId, messageId } = JSON.parse(view.private_metadata);

  const reason = view.state.values.reason["reason-action"].value;

  const action = await prisma.actionItem.findFirst({
    where: { id: actionId },
    include: {
      slackMessage: { include: { channel: true } },
      githubItem: { include: { repository: true } },
    },
  });

  if (!action) return;

  try {
    if (action.githubItem !== null) {
      const res = await getGithubItem(
        action.githubItem.repository.owner,
        action.githubItem.repository.name,
        action.githubItem.nodeId
      );

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
              resolvedAt: new Date(),
              participants: { deleteMany: {} },
              reason: reason ?? "",
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
              reason: reason ?? "",
            },
          },
        },
        include: { actionItem: { include: { participants: true } } },
      });

      await syncParticipants(Array.from(new Set(parent.reply_users)) || [], action.id);
    }

    const { messages } = await client.conversations.history({
      channel: channelId,
      latest: messageId,
      limit: 1,
      inclusive: true,
    });

    const blocks = messages?.[0].blocks || [];
    const idx = blocks.findIndex((block: any) => block.text && block.text.text.includes(actionId));
    const newBlocks = blocks.filter((_, i) => i !== idx && i !== idx + 1) as (Block | KnownBlock)[];

    await client.chat.update({
      ts: messageId,
      channel: channelId,
      text: `Message updated: ${messageId}`,
      blocks: newBlocks,
    });

    await indexDocument(action.id, { timesResolved: 1 });
    await logActivity(client, user.id, action.id, "resolved");
    metrics.increment("slack.resolve.submit", 1);
  } catch (err) {
    metrics.increment("errors.slack.resolve", 1);
    await client.chat.postEphemeral({
      channel: channelId,
      user: user.id,
      text: `:x: Failed to resolve action item (id=${actionId}) ${err.message}`,
    });
    logger.error(err);
  }
};

export const notesSubmit: Middleware<
  SlackViewMiddlewareArgs<SlackViewAction>,
  StringIndexed
> = async ({ ack, body, logger }) => {
  await ack();

  try {
    const { view } = body;
    const { actionId } = JSON.parse(view.private_metadata);
    const notes = view.state.values.notes["notes-action"].value;
    await prisma.actionItem.update({ where: { id: actionId }, data: { notes: notes ?? "" } });
    metrics.increment("slack.notes.submit", 1);
  } catch (err) {
    metrics.increment("errors.slack.notes", 1);
    logger.error(err);
  }
};
