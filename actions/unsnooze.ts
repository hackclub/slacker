import { ActionHandler } from ".";
import prisma from "../lib/db";
import { indexDocument } from "../lib/elastic";
import metrics from "../lib/metrics";
import { logActivity } from "../lib/utils";

export const unsnooze: ActionHandler = async ({ ack, body, client, logger }) => {
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
