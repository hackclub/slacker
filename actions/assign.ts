import { Block, KnownBlock } from "@slack/bolt";
import { ActionHandler } from ".";
import { slack } from "..";
import prisma from "../lib/db";
import { indexDocument } from "../lib/elastic";
import metrics from "../lib/metrics";
import { logActivity, MAINTAINERS } from "../lib/utils";

export const assign: ActionHandler = async ({ ack, body, client, logger }) => {
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
