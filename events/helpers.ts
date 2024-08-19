import { ActionItem, SlackMessage, User } from "@prisma/client";
import { KnownEventFromType } from "@slack/bolt";
import type { Message } from "@slack/web-api/dist/response/ConversationsHistoryResponse";
import dayjs from "dayjs";
import { slack } from "..";
import prisma from "../lib/db";
import { indexDocument } from "../lib/elastic";
import { getMaintainers, syncParticipants } from "../lib/utils";

export interface ParentMessage extends SlackMessage {
  actionItem: ActionItem & {
    participants: { user: User }[];
    slackMessages: { replies: number }[];
  };
}

const ALLOWED_BOTS = ["B03QGF0H9FU", "B03701P4QN8", "B05SHCXE1UY", "B02F604SCGP", "B07FX3F8BFD", "B07HM2ZHJTA"];

export const checkMessageConditions = async (message: KnownEventFromType<"message">) => {
  const invalid = { channel: null, parent: null };

  if (message.subtype === "message_deleted") {
    await prisma.slackMessage.deleteMany({
      where: { ts: message.deleted_ts, channel: { slackId: message.channel } },
    });

    return invalid;
  }

  if (message.subtype || (message.bot_id && !ALLOWED_BOTS.includes(message.bot_id))) return invalid;
  if ((message.text?.length || 0) <= 4) return invalid;
  if (message.text?.startsWith(":") && message.text?.endsWith(":") && !message.text.includes(" "))
    return invalid;

  const channel = await prisma.channel.findFirst({ where: { slackId: message.channel } });
  if (!channel) return invalid;

  const parent = await slack.client.conversations
    .history({ channel: message.channel, latest: message.thread_ts, limit: 1, inclusive: true })
    .then((res) => res.messages?.[0]);

  if (!parent) return invalid;

  return { channel, parent };
};

export const updateExistingMessage = async (
  parentInDb: ParentMessage,
  parent: Message,
  threadReplies: Message[]
) => {
  const firstReplyOn =
    threadReplies?.[0]?.ts && parentInDb.actionItem.firstReplyOn
      ? dayjs.min([
          dayjs(threadReplies[0].ts.split(".")[0], "X"),
          dayjs(parentInDb.actionItem.firstReplyOn),
        ])
      : parentInDb.actionItem.firstReplyOn
      ? dayjs(parentInDb.actionItem.firstReplyOn)
      : threadReplies?.[0]?.ts
      ? dayjs(threadReplies[0].ts.split(".")[0], "X")
      : undefined;

  const lastReplyOn =
    parent.latest_reply && parentInDb.actionItem.lastReplyOn
      ? dayjs.max([
          dayjs(parent.latest_reply.split(".")[0], "X"),
          dayjs(parentInDb.actionItem.lastReplyOn),
        ])
      : parent.latest_reply && !parentInDb.actionItem.lastReplyOn
      ? dayjs(parent.latest_reply.split(".")[0], "X")
      : parentInDb.actionItem.lastReplyOn && !parent.latest_reply
      ? dayjs(parentInDb.actionItem.lastReplyOn)
      : undefined;

  await prisma.actionItem.update({
    where: { id: parentInDb.actionItem.id },
    data: {
      firstReplyOn: firstReplyOn?.toDate(),
      lastReplyOn: lastReplyOn?.toDate(),
      totalReplies: parentInDb.actionItem.slackMessages.reduce((acc, cur) => acc + cur.replies, 0),
      participants: { deleteMany: {} },
      slackMessages: {
        update: {
          where: { id: parentInDb.id },
          data: { text: parent.text || "", replies: parent.reply_count },
        },
      },
    },
  });

  const participants = Array.from(
    new Set(
      parent.reply_users?.concat(
        parentInDb.actionItem.participants.map((p) => p.user.slackId).filter((p) => p) as string[]
      ) || []
    )
  );

  await syncParticipants(participants, parentInDb.actionItem.id);
  await indexDocument(parentInDb.actionItem.id);
};

interface CreateMessageProps {
  recentSlackMessage: (SlackMessage & { actionItem: { id: string } }) | null;
  parent: Message;
  threadReplies: Message[];
  message: KnownEventFromType<"message">;
  author: User;
}

export const createGroupedMessage = async (props: CreateMessageProps) => {
  const { recentSlackMessage, parent, threadReplies, message, author } = props;

  const slackMessage = await prisma.slackMessage.create({
    data: {
      text: parent.text || "",
      ts: parent.ts || "",
      replies: parent.reply_count,
      createdAt: dayjs(parent.ts?.split(".")[0], "X").toDate(),
      actionItem: { connect: { id: recentSlackMessage?.actionItem.id } },
      channel: { connect: { slackId: message.channel } },
      author: { connect: { id: author.id } },
    },
    include: {
      actionItem: {
        include: {
          participants: { select: { user: true } },
          slackMessages: { select: { replies: true } },
        },
      },
    },
  });

  const firstReplyOn =
    threadReplies?.[0]?.ts && slackMessage.actionItem.firstReplyOn
      ? dayjs.min([
          dayjs(threadReplies[0].ts.split(".")[0], "X"),
          dayjs(slackMessage.actionItem.firstReplyOn),
        ])
      : slackMessage.actionItem.firstReplyOn
      ? dayjs(slackMessage.actionItem.firstReplyOn)
      : threadReplies?.[0]?.ts
      ? dayjs(threadReplies[0].ts.split(".")[0], "X")
      : undefined;

  const lastReplyOn =
    parent.latest_reply && slackMessage.actionItem.lastReplyOn
      ? dayjs.max([
          dayjs(parent.latest_reply.split(".")[0], "X"),
          dayjs(slackMessage.actionItem.lastReplyOn),
        ])
      : parent.latest_reply && !slackMessage.actionItem.lastReplyOn
      ? dayjs(parent.latest_reply.split(".")[0], "X")
      : slackMessage.actionItem.lastReplyOn && !parent.latest_reply
      ? dayjs(slackMessage.actionItem.lastReplyOn)
      : undefined;

  await prisma.actionItem.update({
    where: { id: recentSlackMessage?.actionItem.id },
    data: {
      firstReplyOn: firstReplyOn?.toDate(),
      lastReplyOn: lastReplyOn?.toDate(),
      totalReplies: slackMessage.actionItem.slackMessages.reduce(
        (acc, cur) => acc + cur.replies,
        0
      ),
    },
  });

  return slackMessage;
};

export const createNewMessage = async (props: CreateMessageProps) => {
  const { parent, threadReplies, message, author } = props;

  const maintainers = getMaintainers({ channelId: message.channel });
  if (maintainers.find((maintainer) => maintainer.slack === parent.user)) return;

  return await prisma.slackMessage.create({
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
          status: "open",
        },
      },
      channel: { connect: { slackId: message.channel } },
      author: { connect: { id: author.id } },
    },
    include: {
      actionItem: {
        include: {
          participants: { select: { user: true } },
          slackMessages: { select: { replies: true } },
        },
      },
    },
  });
};
