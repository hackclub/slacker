import dayjs from "dayjs";
import { MAINTAINERS, logActivity, syncGithubParticipants, syncParticipants } from "./utils";
import prisma from "./db";
import { StringIndexed } from "@slack/bolt/dist/types/helpers";
import { Block, KnownBlock, Middleware, SlackAction, SlackActionMiddlewareArgs } from "@slack/bolt";
import { getGithubItem } from "./octokit";
import metrics from "./metrics";
import { indexDocument } from "./elastic";

export const markIrrelevant: Middleware<
  SlackActionMiddlewareArgs<SlackAction>,
  StringIndexed
> = async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const { user, channel, actions, message } = body as any;
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

      await syncParticipants(Array.from(new Set(parent.reply_users)) || [], action.id);
    }

    await indexDocument(action.id, { timesResolved: 1 });

    await client.chat.postEphemeral({
      channel: channel.id,
      user: user.id,
      text: `:white_check_mark: Action item (id=${actionId}) closed as irrelevant by <@${user.id}>`,
    });

    const blocks = message.blocks as (Block | KnownBlock)[];
    const idx = blocks.findIndex((block: any) => block.text && block.text.text.includes(actionId));
    const newBlocks = blocks.filter((_, i) => i !== idx && i !== idx + 1);

    await client.chat.update({
      ts: message.ts,
      channel: channel.id,
      text: `Message updated: ${message.ts}`,
      blocks: newBlocks,
    });

    await logActivity(client, user.id, action.id, "irrelevant");
  } catch (err) {
    metrics.increment("errors.slack.mark_irrelevant", 1);
    logger.error(err);
  }
};

export const snooze: Middleware<SlackActionMiddlewareArgs<SlackAction>, StringIndexed> = async ({
  ack,
  body,
  client,
  logger,
}) => {
  await ack();

  try {
    const { actions, channel, message } = body as any;
    const actionId = actions[0].value;

    const action = await prisma.actionItem.findFirst({
      where: { id: actionId },
      include: {
        slackMessage: { include: { channel: true } },
        githubItem: { include: { repository: true } },
      },
    });

    if (!action) return;

    let nextBusinessDay = dayjs().add(1, "day");
    if (nextBusinessDay.day() === 0) nextBusinessDay = nextBusinessDay.add(1, "day");
    else if (nextBusinessDay.day() === 6) nextBusinessDay = nextBusinessDay.add(2, "day");

    const initial_date_time = Math.floor(
      nextBusinessDay.hour(12).minute(0).second(0).millisecond(0).valueOf() / 1000
    );

    await client.views.open({
      trigger_id: (body as any).trigger_id as string,
      view: {
        type: "modal",
        callback_id: "snooze_submit",
        private_metadata: JSON.stringify({
          actionId,
          channelId: channel?.id as string,
          messageId: message.ts,
        }),
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
              initial_date_time,
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
    metrics.increment("errors.slack.snooze", 1);
    logger.error(err);
  }
};

export const notes: Middleware<SlackActionMiddlewareArgs<SlackAction>, StringIndexed> = async ({
  ack,
  body,
  client,
  logger,
}) => {
  await ack();

  try {
    const { actions } = body as any;
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
        callback_id: "notes_submit",
        private_metadata: JSON.stringify({ actionId }),
        title: {
          type: "plain_text",
          text: "Notes",
        },
        submit: {
          type: "plain_text",
          text: "Submit",
        },
        blocks: [
          {
            type: "input",
            block_id: "notes",
            optional: true,
            element: {
              type: "plain_text_input",
              action_id: "notes-action",
              multiline: true,
              initial_value: action.notes,
            },
            label: {
              type: "plain_text",
              text: "Add notes for this action item",
            },
          },
        ],
      },
    });
  } catch (err) {
    metrics.increment("errors.slack.notes", 1);
    logger.error(err);
  }
};

export const resolve: Middleware<SlackActionMiddlewareArgs<SlackAction>, StringIndexed> = async ({
  ack,
  body,
  client,
  logger,
}) => {
  await ack();

  try {
    const { user, channel, actions, message } = body as any;
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

      await syncParticipants(Array.from(new Set(parent.reply_users)) || [], action.id);
    }

    await indexDocument(action.id, { timesResolved: 1 });

    await client.chat.postEphemeral({
      channel: channel?.id as string,
      user: user.id,
      text: `:white_check_mark: Action item (id=${actionId}) resolved by <@${user.id}>`,
    });

    const blocks = message.blocks as (Block | KnownBlock)[];
    const idx = blocks.findIndex((block: any) => block.text && block.text.text.includes(actionId));
    const newBlocks = blocks.filter((_, i) => i !== idx && i !== idx + 1);

    await client.chat.update({
      ts: message.ts,
      channel: channel.id,
      text: `Message updated: ${message.ts}`,
      blocks: newBlocks,
    });

    await logActivity(client, user.id, action.id, "resolved");
  } catch (err) {
    metrics.increment("errors.slack.resolve", 1);
    logger.error(err);
  }
};

export const unsnooze: Middleware<SlackActionMiddlewareArgs<SlackAction>, StringIndexed> = async ({
  ack,
  body,
  client,
  logger,
}) => {
  await ack();

  try {
    const { user, channel, actions } = body as any;
    const actionId = actions[0].value;

    await prisma.actionItem.update({
      where: { id: actionId },
      data: { snoozedUntil: null, snoozeCount: { decrement: 1 }, snoozedById: null },
    });

    await indexDocument(actionId);

    await client.chat.postEphemeral({
      channel: channel?.id as string,
      user: user.id,
      text: `:white_check_mark: Action item (id=${actionId}) unsnoozed by <@${user.id}>`,
    });

    await logActivity(client, user.id, actionId, "unsnoozed");
  } catch (err) {
    metrics.increment("errors.slack.unsnooze", 1);
    logger.error(err);
  }
};

export const assigned: Middleware<SlackActionMiddlewareArgs<SlackAction>, StringIndexed> = async ({
  ack,
  body,
  client,
  logger,
}) => {
  await ack();

  try {
    const { user, channel, actions } = body as any;
    const [actionId, assigneeId] = actions[0].selected_option.value.split("-");

    const maintainer = MAINTAINERS.find((m) => m.id === assigneeId);
    let userOnDb = await prisma.user.findFirst({
      where: {
        OR: [
          { slackId: maintainer?.slack },
          { githubUsername: maintainer?.github },
          { id: assigneeId },
        ],
      },
    });

    if (!userOnDb && maintainer) {
      const userInfo = await client.users.info({ user: maintainer.slack as string });
      userOnDb = await prisma.user.create({
        data: {
          slackId: maintainer.slack,
          githubUsername: maintainer.github,
          email: userInfo.user?.profile?.email,
        },
      });
    }

    if (!userOnDb) return;

    await prisma.actionItem.update({
      where: { id: actionId },
      data: { assigneeId: userOnDb.id, assignedOn: new Date() },
    });

    await indexDocument(actionId, { timesAssigned: 1 });

    await client.chat.postEphemeral({
      channel: channel?.id as string,
      user: user.id,
      text: `:white_check_mark: Action item (id=${actionId}) assigned to <@${maintainer?.slack}>`,
    });

    await logActivity(client, user.id, actionId, "assigned", maintainer?.slack);
  } catch (err) {
    metrics.increment("errors.slack.assigned", 1);
    logger.error(err);
  }
};
