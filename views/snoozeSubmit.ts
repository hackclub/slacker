import {
    Block,
    KnownBlock,
    Middleware,
    SlackViewAction,
    SlackViewMiddlewareArgs,
} from "@slack/bolt";
import { StringIndexed } from "@slack/bolt/dist/types/helpers";
import dayjs from "dayjs";
import prisma from "../lib/db";
import { indexDocument } from "../lib/elastic";
import { logActivity } from "../lib/utils";
import metrics from "../lib/metrics";

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

        if (view.title.text === "Snooze") {
            await prisma.actionItem.update({
                where: { id: actionId },
                data: {
                    snoozedUntil,
                    snoozeCount: { increment: 1 },
                    snoozedById: dbUser?.id,
                    reason: reason ?? "",
                },
            });
        } else {
            const alreadyFollowingUp = await prisma.followUp.findFirst({
                where: { parentId: actionId },
                orderBy: { date: "desc" },
            });

            // We only update the current follow up if it's in the future, otherwise we always create a new one
            if (alreadyFollowingUp && alreadyFollowingUp.date > new Date()) {
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
            text: `:white_check_mark: Action item (id=${actionId}) ${view.title.text === "Snooze" ? "snoozed until" : "will be followed up on"
                } *<!date^${dayjs(snoozedUntil).unix()}^{date_short_pretty} at {time}|${dayjs(
                    snoozedUntil
                ).format("MMM DD, YYYY hh:mm A")}>* ${view.title.text === "Snooze"
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
            text: `:x: Failed to ${view.title.text === "Snooze" ? "snooze" : "follow up on"
                } action item (id=${actionId}) ${err.message}`,
        });
        logger.error(err);
    }
};