import {
  Middleware,
  SlackViewAction,
  SlackViewMiddlewareArgs,
} from "@slack/bolt";
import { StringIndexed } from "@slack/bolt/dist/types/helpers";
import prisma from "../lib/db";
import metrics from "../lib/metrics";

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
