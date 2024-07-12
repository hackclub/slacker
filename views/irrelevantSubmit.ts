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

export const irrelevantSubmit: Middleware<
    SlackViewMiddlewareArgs<SlackViewAction>,
    StringIndexed
> = async ({ ack, body, client, logger }) => {
    await ack();
    const { user, view } = body;
    const { actionId, channelId, messageId } = JSON.parse(view.private_metadata);

    try {
        const reason = view.state.values.reason["reason-action"].value;

        const action = await prisma.actionItem.findFirst({
            where: { id: actionId },
            include: {
                slackMessages: { include: { channel: true } },
                githubItems: { include: { repository: true } },
            },
        });

        if (!action) return;

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
                            flag: "irrelevant",
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
                data: {
                    status: "closed",
                    resolvedAt: new Date(),
                    flag: "irrelevant",
                    reason: reason ?? "",
                },
            });
        }

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
        await logActivity(client, user.id, action.id, "irrelevant");
        metrics.increment("slack.irrelevant.submit", 1);
    } catch (err) {
        metrics.increment("errors.slack.irrelevant", 1);
        await client.chat.postEphemeral({
            channel: channelId,
            user: user.id,
            text: `:x: Failed to mark action item (id=${actionId}) as irrelevant ${err.message}`,
        });
        logger.error(err);
    }
};