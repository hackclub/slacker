import { Block, KnownBlock } from "@slack/bolt";
import { ActionHandler } from ".";
import { handleSlackerCommand } from "../lib/commands";

export const gimmeAgain: ActionHandler = async ({ ack, body, client, logger, ...args }) => {
  await ack();

  try {
    const { user, channel, actions, message } = body as any;
    const command = actions[0].value as string;

    await handleSlackerCommand({
      ack: async () => {},
      // @ts-expect-error
      command: { channel_id: channel?.id, user_id: user.id, text: command },
      client,
      logger,
      ...args,
    });

    if (!channel?.id) return;

    const { messages } = await client.conversations.history({
      channel: channel.id,
      latest: message.ts,
      limit: 1,
      inclusive: true,
    });

    const blocks = messages?.[0].blocks || [];
    const idx = blocks.findIndex(
      (block: any) => block.elements && block.elements[0].action_id === "gimme_again"
    );
    const newBlocks = blocks.filter((_, i) => i !== idx && i !== idx + 1) as (Block | KnownBlock)[];

    await client.chat.update({
      ts: message.ts,
      channel: channel.id,
      text: `Message updated: ${message.id}`,
      blocks: newBlocks,
    });
  } catch (err) {
    logger.error(err);
  }
};
