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
import { logActivity, syncGithubParticipants } from "./utils";
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
    const reason = view.state.values.reason?.["reason-action"]?.value;
    const action = await prisma.actionItem.findFirstOrThrow({ where: { id: actionId } });
    const { selected_date_time } = view.state.values.datetime["datetimepicker-action"];
    const snoozedUntil = dayjs(selected_date_time, "X").toDate();
    const dbUser = await prisma.user.findFirst({ where: { slackId: user.id } });

    if (!dbUser) return;

    if (view.title.text === "Snooze")
      await prisma.actionItem.update({
        where: { id: actionId },
        data: {
          snoozedUntil,
          snoozeCount: { increment: 1 },
          snoozedById: dbUser?.id,
          reason: reason ?? "",
        },
      });
    else {
      const alreadyFollowingUp = await prisma.followUp.findFirst({ where: { parentId: actionId } });

      if (alreadyFollowingUp) {
        await prisma.followUp.update({
          where: {
            parentId_nextItemId: { parentId: actionId, nextItemId: alreadyFollowingUp.nextItemId },
          },
          data: {
            date: snoozedUntil,
            nextItem: {
              create: {
                status: "followUp",
                totalReplies: 0,
                snoozedUntil: snoozedUntil,
                snoozedById: dbUser?.id,
                assigneeId: action.assigneeId,
                notes: reason ?? "",
              },
              update: {
                status: "followUp",
                totalReplies: 0,
                snoozedUntil: snoozedUntil,
                snoozedById: dbUser?.id,
                assigneeId: action.assigneeId,
                notes: reason ?? "",
              },
            },
          },
        });
      } else {
        await prisma.followUp.create({
          data: {
            parent: { connect: { id: actionId } },
            date: snoozedUntil,
            nextItem: {
              create: {
                status: "followUp",
                totalReplies: 0,
                snoozedUntil: snoozedUntil,
                snoozedById: dbUser?.id,
                assigneeId: action.assigneeId,
                notes: reason ?? "",
              },
            },
          },
        });
      }
    }

    await client.chat.postEphemeral({
      channel: channelId,
      user: user.id,
      text: `:white_check_mark: Action item (id=${actionId}) ${
        view.title.text === "Snooze" ? "snoozed until" : "will be followed up on"
      } ${dayjs(snoozedUntil).format("MMM DD, YYYY hh:mm A")} ${
        view.title.text === "Snooze"
          ? `by <@${user.id}> (Snooze count: ${action.snoozeCount + 1})`
          : ""
      }`,
    });

    if (view.title.text !== "Snooze") return;

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
      text: `:x: Failed to ${
        view.title.text === "Snooze" ? "snooze" : "follow up on"
      } action item (id=${actionId}) ${err.message}`,
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
        slackMessages: { include: { channel: true } },
        githubItems: { include: { repository: true } },
      },
    });

    if (!action) return;

    if (action.githubItems.length > 0) {
      // * Github items are always singular for now
      const res = await getGithubItem(
        action.githubItems[0].repository.owner,
        action.githubItems[0].repository.name,
        action.githubItems[0].nodeId
      );

      await prisma.githubItem.update({
        where: { nodeId: action.githubItems[0].nodeId },
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
    } else {
      await prisma.actionItem.update({
        where: { id: action.id },
        data: {
          status: "closed",
          resolvedAt: new Date(),
          flag: "irrelevant",
          reason: reason ?? "",
        },
      });
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
      slackMessages: { include: { channel: true } },
      githubItems: { include: { repository: true } },
      parentItems: true,
    },
  });

  if (!action) return;

  try {
    if (action.githubItems.length > 0) {
      // * Github items are always singular for now
      const res = await getGithubItem(
        action.githubItems[0].repository.owner,
        action.githubItems[0].repository.name,
        action.githubItems[0].nodeId
      );

      await prisma.githubItem.update({
        where: { nodeId: action.githubItems[0].nodeId },
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
    } else {
      await prisma.actionItem.update({
        where: { id: action.id },
        data: { status: "closed", resolvedAt: new Date(), reason: reason ?? "" },
      });
    }

    const isFollowUp = action.parentItems.length > 0;

    const { messages } = await client.conversations.history({
      channel: channelId,
      latest: messageId,
      limit: 1,
      inclusive: true,
    });

    const blocks = messages?.[0].blocks || [];
    const idx = blocks.findIndex((block: any) => block.text && block.text.text.includes(actionId));
    const newBlocks = blocks
      .map((b, i) =>
        i === idx
          ? {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", emoji: true, text: "Follow Up" },
                  value: isFollowUp ? action.parentItems[0].parentId : action.id,
                  action_id: "followup",
                },
              ],
            }
          : i === idx + 1
          ? null
          : b
      )
      .filter((b) => b) as (Block | KnownBlock)[];

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
