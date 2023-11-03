import dayjs from "dayjs";
import prisma from "./db";
import { StringIndexed } from "@slack/bolt/dist/types/helpers";
import { Middleware, SlackViewAction, SlackViewMiddlewareArgs } from "@slack/bolt";
import customParseFormat from "dayjs/plugin/customParseFormat";
import relativeTime from "dayjs/plugin/relativeTime";
import { logActivity } from "./utils";
dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);

export const snoozeSubmit: Middleware<
  SlackViewMiddlewareArgs<SlackViewAction>,
  StringIndexed
> = async ({ ack, body, client, logger }) => {
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
    const snoozedUntil = dayjs(selected_date_time, "X").toDate();
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

    await logActivity(client, user.id, action.id, "snoozed");
  } catch (err) {
    logger.error(err);
  }
};
