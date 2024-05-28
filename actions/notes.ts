import { Block } from "@slack/bolt";
import { ActionHandler } from ".";
import prisma from "../lib/db";
import metrics from "../lib/metrics";

export const notes: ActionHandler = async ({ ack, body, client, logger }) => {
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
          ...(action.reason.length > 0
            ? [
                {
                  type: "section",
                  text: {
                    type: "plain_text",
                    text: `**Reason:** ${action.reason}`,
                    emoji: true,
                  },
                } as Block,
              ]
            : []),
        ],
      },
    });

    metrics.increment("slack.notes.open", 1);
  } catch (err) {
    metrics.increment("errors.slack.notes", 1);
    logger.error(err);
  }
};
