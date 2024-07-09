import {
    Block,
    KnownBlock,
    Middleware,
    SlackViewAction,
    SlackViewMiddlewareArgs,
} from "@slack/bolt";
import { StringIndexed } from "@slack/bolt/dist/types/helpers";
import prisma from "../lib/db";
import { indexDocument } from "../lib/elastic";
import { getGithubItem } from "../lib/octokit";
import { logActivity, syncGithubParticipants } from "../lib/utils";
import metrics from "../lib/metrics";

export const resolveSubmit: Middleware<
    SlackViewMiddlewareArgs<SlackViewAction>,
    StringIndexed
> = async ({ ack, body, client, logger }) => {
    await ack();

    const { user, view } = body;
    const { actionId, channelId, messageId } = JSON.parse(view.private_metadata);

    const reason = view.state.values.reason["reason-action"].value;

    const action = await prisma.actionItem.findUnique({
        where: { id: actionId },
        include: {
            slackMessages: { include: { channel: true } },
            githubItems: { include: { repository: true } },
            parentItems: {
                include: {
                    parent: {
                        include: {
                            slackMessages: { include: { channel: true } },
                            githubItems: { include: { repository: true } },
                        },
                    },
                },
                orderBy: { date: "desc" },
                take: 1,
            },
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

        const blocks = messages?.[0]?.blocks || [];
        const idx = blocks.findIndex((block: any) => block.text && block.text.text.includes(actionId));
        const text = isFollowUp
            ? action.parentItems[0].parent.slackMessages?.[0]?.text ||
            action.parentItems[0].parent.githubItems?.[0]?.title
            : action.slackMessages?.[0]?.text || action.githubItems?.[0]?.title;

        const newBlocks = blocks
            .map((b, i) =>
                i === idx
                    ? {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `:white_check_mark: *Resolved* ${text ? "(" + text.slice(0, 50) + ")..." : ""
                                }`,
                        },
                        accessory: {
                            type: "button",
                            text: { type: "plain_text", emoji: true, text: "Follow Up" },
                            value: isFollowUp ? action.parentItems[0].parentId : action.id,
                            action_id: "followup",
                        },
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