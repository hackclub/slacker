import { Block, KnownBlock, Middleware, SlackAction, SlackActionMiddlewareArgs } from "@slack/bolt";
import { StringIndexed } from "@slack/bolt/dist/types/helpers";
import dayjs from "dayjs";
import { Octokit } from "octokit";
import { handleSlackerCommand } from "./commands";
import prisma from "./db";
import { indexDocument } from "./elastic";
import metrics from "./metrics";
import { getOctokitToken } from "./octokit";
import { MAINTAINERS, logActivity } from "./utils";
import { slack } from "..";

export const markIrrelevant: Middleware<
  SlackActionMiddlewareArgs<SlackAction>,
  StringIndexed
> = async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const { actions, channel, message } = body as any;
    const actionId = actions[0].value;
    const action = await prisma.actionItem.findFirst({ where: { id: actionId } });
    if (!action) return;

    await client.views.open({
      trigger_id: (body as any).trigger_id as string,
      view: {
        type: "modal",
        callback_id: "irrelevant_submit",
        private_metadata: JSON.stringify({
          actionId,
          channelId: channel?.id as string,
          messageId: message.ts,
        }),
        title: {
          type: "plain_text",
          text: "Mark as Irrelevant",
        },
        submit: {
          type: "plain_text",
          text: "Submit",
        },
        blocks: [
          {
            type: "input",
            block_id: "reason",
            element: {
              type: "plain_text_input",
              action_id: "reason-action",
              multiline: true,
            },
            label: {
              type: "plain_text",
              text: "Why is this irrelevant?",
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `:bangbang: Marking an item as irrelevant will close it and remove it from the list.`,
              },
            ],
          },
        ],
      },
    });
    metrics.increment("slack.mark_irrelevant.open", 1);
  } catch (err) {
    metrics.increment("errors.slack.mark_irrelevant", 1);
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
    const { actions, channel, message } = body as any;
    const actionId = actions[0].value;
    const action = await prisma.actionItem.findFirst({ where: { id: actionId } });
    if (!action) return;

    await client.views.open({
      trigger_id: (body as any).trigger_id as string,
      view: {
        type: "modal",
        callback_id: "resolve_submit",
        private_metadata: JSON.stringify({
          actionId,
          channelId: channel?.id as string,
          messageId: message.ts,
        }),
        title: {
          type: "plain_text",
          text: "Resolve Action Item",
        },
        submit: {
          type: "plain_text",
          text: "Submit",
        },
        blocks: [
          {
            type: "input",
            block_id: "reason",
            element: {
              type: "plain_text_input",
              action_id: "reason-action",
              multiline: true,
            },
            label: {
              type: "plain_text",
              text: "Why is this resolved?",
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `:bangbang: Resolving an item will close it and remove it from the list.`,
              },
            ],
          },
        ],
      },
    });

    metrics.increment("slack.resolve.open", 1);
  } catch (err) {
    metrics.increment("errors.slack.resolve", 1);
    logger.error(err);
  }
};

export const followUp: Middleware<SlackActionMiddlewareArgs<SlackAction>, StringIndexed> = async (
  args
) => {
  await args.ack();
  await snooze(args);
};

export const snooze: Middleware<SlackActionMiddlewareArgs<SlackAction>, StringIndexed> = async ({
  ack,
  body,
  client,
  logger,
}) => {
  const { actions, channel, message } = body as any;

  try {
    const actionId = actions[0].value;
    actions[0].action_id === "snooze" && (await ack());
    const action = await prisma.actionItem.findFirst({ where: { id: actionId } });
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
          text: actions[0].action_id === "snooze" ? "Snooze" : "Follow Up",
        },
        submit: {
          type: "plain_text",
          text: actions[0].action_id === "snooze" ? "Snooze" : "Follow Up",
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
              text: actions[0].action_id === "snooze" ? "Snooze until" : "Follow up on",
            },
          },
          {
            type: "input",
            block_id: "reason",
            element: {
              type: "plain_text_input",
              action_id: "reason-action",
              multiline: true,
            },
            label: {
              type: "plain_text",
              text: "Why?",
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text:
                  actions[0].action_id === "snooze"
                    ? `:bangbang: Snooze wisely. If you keep snoozing an item repeatedly, you'll be called out for slackin'.`
                    : `You can only follow up on an item once. If you need to follow up again, you can do so once the first follow up has been completed.`,
              },
            ],
          },
        ],
      },
    });

    actions[0].action_id === "snooze"
      ? metrics.increment("slack.snooze.open", 1)
      : metrics.increment("slack.follow_up.open", 1);
  } catch (err) {
    actions[0].action_id === "snooze"
      ? metrics.increment("errors.slack.snooze", 1)
      : metrics.increment("errors.slack.follow_up", 1);
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
    const action = await prisma.actionItem.findFirst({ where: { id: actionId } });
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

    metrics.increment("slack.notes.open", 1);
  } catch (err) {
    metrics.increment("errors.slack.notes", 1);
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

    await client.chat.postEphemeral({
      channel: channel?.id as string,
      user: user.id,
      text: `:white_check_mark: Action item (id=${actionId}) unsnoozed by <@${user.id}>`,
    });

    await indexDocument(actionId);
    await logActivity(client, user.id, actionId, "unsnoozed");
    metrics.increment("slack.unsnooze", 1);
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
    const { user, channel, actions, message } = body as any;
    const [actionId, assigneeId] = actions[0].selected_option.value.split("-");

    if (assigneeId === "unassigned") {
      await prisma.actionItem.update({
        where: { id: actionId },
        data: { assigneeId: null, assignedOn: null },
      });

      await client.chat.postEphemeral({
        channel: channel?.id as string,
        user: user.id,
        text: `:white_check_mark: Action item (id=${actionId}) unassigned.`,
      });

      await removeResolveButton(channel?.id as string, message.ts, actionId);
      await indexDocument(actionId);
      await logActivity(client, user.id, actionId, "unassigned");
      metrics.increment("slack.unassigned", 1);
      return;
    }

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

    await client.chat.postEphemeral({
      channel: channel?.id as string,
      user: user.id,
      text: `:white_check_mark: Action item (id=${actionId}) assigned to <@${maintainer?.slack}>`,
    });

    if (user.id !== maintainer?.slack) {
      await removeResolveButton(channel?.id as string, message.ts, actionId);
    } else {
      await addResolveButton(channel?.id as string, message.ts, actionId);
    }

    await indexDocument(actionId, { timesAssigned: 1 });
    await logActivity(client, user.id, actionId, "assigned", maintainer?.slack);
    metrics.increment("slack.assigned", 1);
  } catch (err) {
    metrics.increment("errors.slack.assigned", 1);
    logger.error(err);
  }
};

export const gimmeAgain: Middleware<
  SlackActionMiddlewareArgs<SlackAction>,
  StringIndexed
> = async ({ ack, body, client, logger, ...args }) => {
  await ack();

  try {
    const { user, channel, actions, message } = body as any;
    const command = actions[0].value as string;

    await handleSlackerCommand({
      ack: async () => {},
      // @ts-expect-error
      command: { channel_id: channel?.id, user_id: user.id, text: command },
      client,
      logger,
      ...args,
    });

    if (!channel?.id) return;

    const { messages } = await client.conversations.history({
      channel: channel.id,
      latest: message.ts,
      limit: 1,
      inclusive: true,
    });

    const blocks = messages?.[0].blocks || [];
    const idx = blocks.findIndex(
      (block: any) => block.elements && block.elements[0].action_id === "gimme_again"
    );
    const newBlocks = blocks.filter((_, i) => i !== idx && i !== idx + 1) as (Block | KnownBlock)[];

    await client.chat.update({
      ts: message.ts,
      channel: channel.id,
      text: `Message updated: ${message.id}`,
      blocks: newBlocks,
    });
  } catch (err) {
    logger.error(err);
  }
};

export const promptAssigneeYes: Middleware<
  SlackActionMiddlewareArgs<SlackAction>,
  StringIndexed
> = async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const { user, channel, actions } = body as any;
    const nodeId = actions[0].value;

    const item = await prisma.githubItem.findUnique({ where: { nodeId } });
    if (!item?.lastPromptedOn || dayjs().diff(dayjs(item.lastPromptedOn), "day") >= 2) return;
    await prisma.githubItem.update({ where: { nodeId }, data: { lastAssignedOn: new Date() } });

    await client.chat.postEphemeral({
      channel: channel?.id as string,
      user: user.id,
      text: `:white_check_mark: Github issue marked as still being worked on. We'll check back again in 5 days.`,
    });

    metrics.increment("github.assignee.response.yes", 1);
  } catch (err) {
    metrics.increment("errors.github.assignee.response", 1);
    logger.error(err);
  }
};

export const promptAssigneeNo: Middleware<
  SlackActionMiddlewareArgs<SlackAction>,
  StringIndexed
> = async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const { user, channel, actions } = body as any;
    const [nodeId, login] = actions[0].value.split("-");

    const i = await prisma.githubItem.findUnique({ where: { nodeId } });
    if (!i?.lastPromptedOn || dayjs().diff(dayjs(i.lastPromptedOn), "day") >= 2) return;
    const item = await prisma.githubItem.update({
      where: { nodeId },
      data: { lastAssignedOn: null, lastPromptedOn: null },
      include: { repository: true },
    });

    const octokit = new Octokit({
      auth: "Bearer " + (await getOctokitToken(item.repository.owner, item.repository.name)),
    });

    await octokit.rest.issues.removeAssignees({
      owner: item.repository.owner,
      repo: item.repository.name,
      issue_number: item.number,
      assignees: [login],
    });

    await client.chat.postEphemeral({
      channel: channel?.id as string,
      user: user.id,
      text: `:white_check_mark: Alright, the issue has been unassigned from <@${login}>.`,
    });

    metrics.increment("github.assignee.response.no", 1);
  } catch (err) {
    metrics.increment("errors.github.assignee.response", 1);
    logger.error(err);
  }
};

const removeResolveButton = async (channelId: string, messageId: string, actionId: string) => {
  const { messages } = await slack.client.conversations.history({
    channel: channelId,
    latest: messageId,
    limit: 1,
    inclusive: true,
  });

  const blocks = messages?.[0].blocks || [];
  const idx = blocks.findIndex(
    (block) => block.type === "section" && block.text?.text?.includes(actionId)
  );

  const hasResolveButton = blocks[idx]?.accessory?.action_id === "resolve";
  if (!hasResolveButton) return;

  const newBlocks = blocks.map((block, i) => {
    if (i === idx) return { ...block, accessory: undefined };
    return block;
  }) as (Block | KnownBlock)[];

  await slack.client.chat.update({
    ts: messageId,
    channel: channelId,
    text: `Message updated: ${messageId}`,
    blocks: newBlocks,
  });
};

const addResolveButton = async (channelId: string, messageId: string, actionId: string) => {
  const { messages } = await slack.client.conversations.history({
    channel: channelId,
    latest: messageId,
    limit: 1,
    inclusive: true,
  });

  const blocks = messages?.[0].blocks || [];
  const idx = blocks.findIndex(
    (block) => block.type === "section" && block.text?.text?.includes(actionId)
  );

  const hasAccessories = !!blocks[idx]?.accessory;
  if (hasAccessories) return;

  const newBlocks = blocks.map((block, i) => {
    if (i === idx) {
      return {
        ...block,
        accessory: {
          type: "button",
          text: { type: "plain_text", emoji: true, text: "Resolve" },
          style: "primary",
          value: actionId,
          action_id: "resolve",
        },
      };
    }

    return block;
  }) as (Block | KnownBlock)[];

  await slack.client.chat.update({
    ts: messageId,
    channel: channelId,
    text: `Message updated: ${messageId}`,
    blocks: newBlocks,
  });
};
