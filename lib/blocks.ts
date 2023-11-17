import { ActionItem, Channel, GithubItem, Repository, SlackMessage, User } from "@prisma/client";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import relativeTime from "dayjs/plugin/relativeTime";
import { getMaintainers, getProject } from "./utils";
import metrics from "./metrics";
dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);

export const slackItem = ({
  item,
  showActions = true,
}: {
  item: ActionItem & {
    assignee: User | null | undefined;
    githubItem: (GithubItem & { repository: Repository }) | null | undefined;
    slackMessage: (SlackMessage & { channel: Channel; author: User }) | null | undefined;
  };
  showActions?: boolean;
}) => {
  const diff = dayjs().diff(dayjs(item.lastReplyOn), "day");
  const project = getProject({ channelId: item.slackMessage?.channel?.slackId });

  const assigneeText = item.assignee
    ? `Assigned to: ${
        item.assignee.slackId ? `<@${item.assignee.slackId}>` : item.assignee.githubUsername
      }`
    : "Unassigned";

  const maintainers = getMaintainers({ channelId: item.slackMessage?.channel?.slackId });
  const isMaintainer = maintainers.find(
    (maintainer) =>
      maintainer?.slack === item.assignee?.slackId ||
      maintainer?.github === item.assignee?.githubUsername
  );

  const currentAssignee =
    item.assignee && isMaintainer
      ? isMaintainer
      : item.assignee
      ? {
          id: item.assignee?.id,
          slack: item.assignee?.slackId,
          github: item.assignee?.githubUsername,
        }
      : undefined;

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Project:* ${project}\n*Action Id:* ${item.id}\n*Query:* ${
        item.slackMessage?.text
      }\n\nOpened by <@${item.slackMessage?.author?.slackId}> on ${dayjs(
        item.slackMessage?.createdAt
      ).format("MMM DD, YYYY")} at ${dayjs(item.slackMessage?.createdAt).format("hh:mm A")}${
        item.lastReplyOn
          ? `\n*Last reply:* ${dayjs(item.lastReplyOn).fromNow()} ${diff > 10 ? ":panik:" : ""}`
          : "\n:panik: *No replies yet*"
      } | ${assigneeText}\n<https://hackclub.slack.com/archives/${
        item.slackMessage?.channel?.slackId
      }/p${item.slackMessage?.ts.replace(".", "")}|View on Slack>`,
    },
    accessory: showActions
      ? {
          type: "button",
          text: { type: "plain_text", emoji: true, text: "Resolve" },
          style: "primary",
          value: item.id,
          action_id: "resolve",
        }
      : {
          type: "static_select",
          placeholder: { type: "plain_text", text: "Assign to", emoji: true },
          options: maintainers
            .filter((m) => !!m)
            .map((maintainer) => ({
              text: { type: "plain_text", text: maintainer!.id, emoji: true },
              value: `${item.id}-${maintainer?.id}`,
            }))
            .concat(
              ...(item.assignee && !isMaintainer
                ? [
                    {
                      text: {
                        type: "plain_text",
                        text: `<@${currentAssignee?.slack}> (volunteer)`,
                        emoji: true,
                      },
                      value: `${item.id}-${currentAssignee?.id}`,
                    },
                  ]
                : [])
            ),
          initial_option: currentAssignee
            ? {
                text: {
                  type: "plain_text",
                  text: isMaintainer
                    ? currentAssignee.id
                    : `<@${currentAssignee.slack}> (volunteer)`,
                  emoji: true,
                },
                value: `${item.id}-${currentAssignee.id}`,
              }
            : undefined,
          action_id: "assigned",
        },
  };
};

export const githubItem = ({
  item,
  showActions = true,
}: {
  item: ActionItem & {
    assignee: User | null | undefined;
    githubItem: (GithubItem & { repository: Repository; author: User }) | null | undefined;
    slackMessage: (SlackMessage & { channel: Channel; author: User }) | null | undefined;
  };
  showActions?: boolean;
}) => {
  const diff = dayjs().diff(dayjs(item.lastReplyOn), "day");
  const url = `<https://github.com/${item.githubItem?.repository?.owner}/${item.githubItem?.repository?.name}/issues/${item.githubItem?.number}|View on GitHub>`;
  const text = item.githubItem?.title ? `*Issue:* ${item.githubItem?.title}` : url;
  const project = getProject({ repoUrl: item.githubItem?.repository?.url });

  const assigneeText = item.assignee
    ? `Assigned to ${
        item.assignee.slackId ? `<@${item.assignee.slackId}>` : item.assignee.githubUsername
      }`
    : "Unassigned";

  const maintainers = getMaintainers({ repoUrl: item.githubItem?.repository?.url });
  const isMaintainer = maintainers.find(
    (maintainer) =>
      maintainer?.slack === item.assignee?.slackId ||
      maintainer?.github === item.assignee?.githubUsername
  );

  const currentAssignee =
    item.assignee && isMaintainer
      ? isMaintainer
      : item.assignee
      ? {
          id: item.assignee?.id,
          slack: item.assignee?.slackId,
          github: item.assignee?.githubUsername,
        }
      : undefined;

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Project:* ${project}*Action Id:* ${item.id}\n${text}\n\nOpened by ${
        item.githubItem?.author?.githubUsername
      } on ${dayjs(item.githubItem?.createdAt).format("MMM DD, YYYY")} at ${dayjs(
        item.githubItem?.createdAt
      ).format("hh:mm A")}${
        item.lastReplyOn
          ? `\n*Last reply:* ${dayjs(item.lastReplyOn).fromNow()} ${diff > 10 ? ":panik:" : ""}`
          : "\n:panik: *No replies yet*"
      } | ${assigneeText}\n${item.githubItem?.title ? url : ""}`,
    },
    accessory: showActions
      ? {
          type: "button",
          text: { type: "plain_text", emoji: true, text: "Resolve" },
          style: "primary",
          value: item.id,
          action_id: "resolve",
        }
      : {
          type: "static_select",
          placeholder: { type: "plain_text", text: "Assign to", emoji: true },
          options: maintainers
            .filter((m) => !!m)
            .map((maintainer) => ({
              text: { type: "plain_text", text: maintainer!.id, emoji: true },
              value: `${item.id}-${maintainer?.id}`,
            }))
            .concat(
              ...(item.assignee && !isMaintainer
                ? [
                    {
                      text: {
                        type: "plain_text",
                        text: `<@${currentAssignee?.slack}> (volunteer)`,
                        emoji: true,
                      },
                      value: `${item.id}-${currentAssignee?.id}`,
                    },
                  ]
                : [])
            ),
          initial_option: currentAssignee
            ? {
                text: {
                  type: "plain_text",
                  text: isMaintainer
                    ? currentAssignee.id
                    : `<@${currentAssignee.slack}> (volunteer)`,
                  emoji: true,
                },
                value: `${item.id}-${currentAssignee.id}`,
              }
            : undefined,
          action_id: "assigned",
        },
  };
};

export const buttons = ({ item, showAssignee = false }) => {
  const maintainers = getMaintainers({ repoUrl: item.githubItem?.repository?.url });
  const isMaintainer = maintainers.find(
    (maintainer) =>
      maintainer?.slack === item.assignee?.slackId ||
      maintainer?.github === item.assignee?.githubUsername
  );

  const currentAssignee =
    item.assignee && isMaintainer
      ? isMaintainer
      : item.assignee
      ? {
          id: item.assignee?.id,
          slack: item.assignee?.slackId,
          github: item.assignee?.githubUsername,
        }
      : undefined;

  return [
    {
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
        showAssignee && {
          type: "static_select",
          placeholder: { type: "plain_text", text: "Assign to", emoji: true },
          options: maintainers
            .filter((m) => !!m)
            .map((maintainer) => ({
              text: { type: "plain_text", text: maintainer!.id, emoji: true },
              value: `${item.id}-${maintainer?.id}`,
            }))
            .concat(
              ...(item.assignee && !isMaintainer
                ? [
                    {
                      text: {
                        type: "plain_text",
                        text: `<@${currentAssignee?.slack}> (volunteer)`,
                        emoji: true,
                      },
                      value: `${item.id}-${currentAssignee?.id}`,
                    },
                  ]
                : [])
            ),
          initial_option: currentAssignee
            ? {
                text: {
                  type: "plain_text",
                  text: isMaintainer
                    ? currentAssignee.id
                    : `<@${currentAssignee.slack}> (volunteer)`,
                  emoji: true,
                },
                value: `${item.id}-${currentAssignee.id}`,
              }
            : undefined,
          action_id: "assigned",
        },
      ],
    },
    { type: "divider" },
  ];
};

export const unauthorizedError = async ({ client, user_id, channel_id }) => {
  metrics.increment("errors.unauthorized", 1);
  await client.chat.postEphemeral({
    user: user_id,
    channel: channel_id,
    text: `:warning: You're not a manager for this project. Make sure you're listed inside the config/[project].yaml file.`,
  });
};
