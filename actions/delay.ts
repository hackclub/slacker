import dayjs from "dayjs";
import { ActionHandler } from ".";
import prisma from "../lib/db";
import metrics from "../lib/metrics";

export const followUp: ActionHandler = async (args) => {
  await args.ack();
  await snooze(args);
};

export const snooze: ActionHandler = async ({ ack, body, client, logger }) => {
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
