import { User } from "@prisma/client";
import { Middleware, SlackEventMiddlewareArgs } from "@slack/bolt";
import dayjs from "dayjs";
import prisma from "../lib/db";
import { indexDocument } from "../lib/elastic";
import metrics from "../lib/metrics";
import { checkNeedsNotifying, getProjectName, getYamlFile, syncParticipants } from "../lib/utils";
import {
  checkMessageConditions,
  createGroupedMessage,
  createNewMessage,
  ParentMessage,
  updateExistingMessage,
} from "./helpers";

type MessageEvent = Middleware<SlackEventMiddlewareArgs<"message">>;

export const messageEvent: MessageEvent = async ({ message, client, logger }) => {
  try {
    const { channel, parent } = await checkMessageConditions(message);
    if (!channel || !parent) return;

    const parentInDb = await prisma.slackMessage.findFirst({
      where: { ts: parent.ts, channel: { slackId: message.channel } },
      include: {
        actionItem: {
          include: {
            participants: { select: { user: true } },
            slackMessages: { select: { replies: true } },
          },
        },
      },
    });

    const threadReplies = await client.conversations
      .replies({ channel: message.channel, ts: parent.ts as string, limit: 100 })
      .then((res) => res.messages?.slice(1) || []);

    const email = await client.users
      .info({ user: parent.user as string })
      .then((res) => res.user?.profile?.email || "");

    if (parentInDb) {
      return await updateExistingMessage(parentInDb, parent, threadReplies);
    } else {
      const user = await prisma.user.findFirst({ where: { slackId: parent.user as string } });
      let author: User;

      if (!user)
        author = await prisma.user.create({ data: { email, slackId: parent.user as string } });
      else author = user;

      const project = getProjectName({ channelId: message.channel });
      const details = getYamlFile(`${project}.yaml`);
      const grouping = details.channels?.find((c) => c.id === message.channel)?.grouping || {
        minutes: 0,
      };

      const recentSlackMessage = await prisma.slackMessage.findFirst({
        where: {
          channel: { slackId: message.channel },
          createdAt: { gte: dayjs().subtract(grouping.minutes, "minute").toDate() },
          actionItem: { status: "open", assigneeId: null },
        },
        include: { actionItem: { select: { id: true } } },
        orderBy: { createdAt: "desc" },
      });

      let slackMessage: ParentMessage | undefined;
      const createProps = { recentSlackMessage, parent, threadReplies, message, author };

      if (recentSlackMessage && grouping.minutes > 0) {
        slackMessage = await createGroupedMessage(createProps);
      } else {
        slackMessage = await createNewMessage(createProps);
      }

      if (slackMessage) {
        const participants = Array.from(
          new Set(
            (parent.reply_users || []).concat(
              slackMessage.actionItem.participants
                .map((p) => p.user.slackId)
                .filter((p) => p) as string[]
            )
          )
        );

        await syncParticipants(participants, slackMessage.actionItem.id);
        await indexDocument(slackMessage.actionItem.id);
        await checkNeedsNotifying(slackMessage.actionItem.id);
      }
    }
  } catch (err) {
    metrics.increment("errors.slack.message", 1);
    logger.error(err);
  }
};
