import metrics from "../lib/metrics";

export const unauthorizedError = async ({ client, user_id, channel_id }) => {
  metrics.increment("errors.unauthorized", 1);
  await client.chat.postEphemeral({
    user: user_id,
    channel: channel_id,
    text: `:warning: You're not a manager for this project. Make sure you're listed inside the config/[project].yaml file.`,
  });
};
