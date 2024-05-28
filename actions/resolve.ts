import { ActionHandler } from ".";
import prisma from "../lib/db";
import metrics from "../lib/metrics";

export const resolve: ActionHandler = async ({ ack, body, client, logger }) => {
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
        title: { type: "plain_text", text: "Resolve Action Item" },
        submit: { type: "plain_text", text: "Submit" },
        blocks: [
          {
            type: "input",
            block_id: "reason",
            element: { type: "plain_text_input", action_id: "reason-action", multiline: true },
            label: { type: "plain_text", text: "Why is this resolved?" },
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
