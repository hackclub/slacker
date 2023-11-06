import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import relativeTime from "dayjs/plugin/relativeTime";
dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);

export const slackItem = ({ item }) => {
  const diff = dayjs().diff(dayjs(item.lastReplyOn), "day");

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Action Id:* ${item.id}\n*Query:* ${item.slackMessage?.text}\n\nOpened by <@${
        item.slackMessage?.author?.slackId
      }> on ${dayjs(item.slackMessage?.createdAt).format("MMM DD, YYYY")} at ${dayjs(
        item.slackMessage?.createdAt
      ).format("hh:mm A")}${
        item.lastReplyOn
          ? `\n*Last reply:* ${dayjs(item.lastReplyOn).fromNow()} ${diff > 10 ? ":panik:" : ""}`
          : "\n:panik: *No replies yet*"
      }\n<https://hackclub.slack.com/archives/${
        item.slackMessage?.channel?.slackId
      }/p${item.slackMessage?.ts.replace(".", "")}|View on Slack>`,
    },
    accessory: {
      type: "button",
      text: { type: "plain_text", emoji: true, text: "Resolve" },
      style: "primary",
      value: item.id,
      action_id: "resolve",
    },
  };
};

export const githubItem = ({ item }) => {
  const diff = dayjs().diff(dayjs(item.lastReplyOn), "day");
  const text =
    (item.githubItem?.type === "issue" ? "*Issue:* " : "*Pull Request:* ") +
    `https://github.com/${item.githubItem?.repository?.owner}/${item.githubItem?.repository?.name}/issues/${item.githubItem?.number}`;

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Action Id:* ${item.id}\n${text}\n\nOpened by ${
        item.githubItem?.author?.githubUsername
      } on ${dayjs(item.githubItem?.createdAt).format("MMM DD, YYYY")} at ${dayjs(
        item.githubItem?.createdAt
      ).format("hh:mm A")}${
        item.lastReplyOn
          ? `\n*Last reply:* ${dayjs(item.lastReplyOn).fromNow()} ${diff > 10 ? ":panik:" : ""}`
          : "\n:panik: *No replies yet*"
      }`,
    },
    accessory: {
      type: "button",
      text: { type: "plain_text", emoji: true, text: "Resolve" },
      style: "primary",
      value: item.id,
      action_id: "resolve",
    },
  };
};

export const buttons = ({ item }) => ({
  type: "actions",
  elements: [
    {
      type: "button",
      text: { type: "plain_text", emoji: true, text: "Snooze" },
      value: item.id,
      action_id: "snooze",
    },
    {
      type: "button",
      text: { type: "plain_text", emoji: true, text: "Close - Irrelevant" },
      value: item.id,
      action_id: "irrelevant",
    },
  ],
});

export const unauthorizedError = async ({ client, user_id, channel_id }) => {
  await client.chat.postEphemeral({
    user: user_id,
    channel: channel_id,
    text: `:warning: You're not a manager for this project. Make sure you're listed inside the config/[project].yaml file. Also, consider <${process.env.DEPLOY_URL}/auth?id=${user_id}|logging in with github>`,
  });
};
