import { ActionItem, Channel, GithubItem, Repository, SlackMessage, User } from "@prisma/client";
import dayjs from "dayjs";
import metrics from "./metrics";
import { getMaintainers, getProjectName } from "./utils";

export const slackItem = ({
  item,
  showActions = true,
  followUp,
}: {
  item: ActionItem & {
    assignee: User | null | undefined;
    githubItems: (GithubItem & { repository: Repository })[];
    slackMessages: (SlackMessage & { channel: Channel; author: User })[];
  };
  showActions?: boolean;
  followUp?: { id: string; duration: number };
}) => {
  const diff = dayjs().diff(dayjs(item.lastReplyOn), "day");
  const project = getProjectName({ channelId: item.slackMessages[0].channel?.slackId });

  const assigneeText = item.assignee
    ? `Assigned to: ${
        item.assignee.slackId ? `<@${item.assignee.slackId}>` : item.assignee.githubUsername
      }`
    : "Unassigned";

  const maintainers = getMaintainers({ channelId: item.slackMessages[0].channel?.slackId });
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

  const text = item.slackMessages
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((m) => `<@${m.author?.slackId}>: ${m.text}`)
    .join("\n");

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `${
        followUp?.id
          ? `:information_source: Follow up (${followUp.duration} days) :information_source:`
          : ""
      }\n*Project:* ${project}\n*Action Id:* ${
        followUp?.id ? followUp.id : item.id
      }\n*Query:* ${text.slice(0, 2000)}${text.length > 2000 ? "..." : ""}\n\nOpened by <@${
        item.slackMessages[0].author?.slackId
      }> on ${dayjs(item.slackMessages[0].createdAt).format("MMM DD, YYYY")} at ${dayjs(
        item.slackMessages[0].createdAt
      ).format("hh:mm A")}${
        item.lastReplyOn
          ? `\n*Last reply:* ${dayjs(item.lastReplyOn).fromNow()} ${diff > 10 ? ":panik:" : ""}`
          : "\n:panik: *No replies yet*"
      } | ${assigneeText}\n<https://hackclub.slack.com/archives/${
        item.slackMessages[0].channel?.slackId
      }/p${item.slackMessages[0].ts.replace(".", "")}|View on Slack>`,
    },
    accessory: showActions
      ? {
          type: "button",
          text: { type: "plain_text", emoji: true, text: "Resolve" },
          style: "primary",
          value: followUp?.id ? followUp.id : item.id,
          action_id: "resolve",
        }
      : {
          type: "static_select",
          placeholder: { type: "plain_text", text: "Assign to", emoji: true },
          options: maintainers
            .filter((m) => !!m)
            .map((maintainer) => ({
              text: { type: "plain_text", text: maintainer!.id, emoji: true },
              value: `${followUp?.id ? followUp.id : item.id}-${maintainer?.id}`,
            }))
            .concat(
              followUp?.id
                ? []
                : {
                    text: { type: "plain_text", text: "none", emoji: true },
                    value: `${item.id}-unassigned`,
                  }
            )
            .concat(
              ...(item.assignee && !isMaintainer
                ? [
                    {
                      text: {
                        type: "plain_text",
                        text: `<@${currentAssignee?.slack}> (volunteer)`,
                        emoji: true,
                      },
                      value: `${followUp?.id ? followUp.id : item.id}-${currentAssignee?.id}`,
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
                value: `${followUp?.id ? followUp.id : item.id}-${currentAssignee.id}`,
              }
            : followUp?.id
            ? undefined
            : {
                text: { type: "plain_text", text: "none", emoji: true },
                value: `${item.id}-unassigned`,
              },
          action_id: "assigned",
        },
  };
};

export const githubItem = ({
  item,
  showActions = true,
  followUp,
}: {
  item: ActionItem & {
    assignee: User | null | undefined;
    githubItems: (GithubItem & { repository: Repository; author: User })[];
    slackMessages: (SlackMessage & { channel: Channel; author: User })[];
  };
  showActions?: boolean;
  followUp?: { id: string; duration: number };
}) => {
  const diff = dayjs().diff(dayjs(item.lastReplyOn), "day");
  const url = `<https://github.com/${item.githubItems[0].repository?.owner}/${item.githubItems[0].repository?.name}/issues/${item.githubItems[0].number}|View on GitHub>`;
  const text = item.githubItems[0].title ? `*Issue:* ${item.githubItems[0].title}` : url;
  const project = getProjectName({ repoUrl: item.githubItems[0].repository?.url });

  const assigneeText = item.assignee
    ? `Assigned to ${
        item.assignee.slackId ? `<@${item.assignee.slackId}>` : item.assignee.githubUsername
      }`
    : "Unassigned";

  const maintainers = getMaintainers({ repoUrl: item.githubItems[0].repository?.url });
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
      text: `${
        followUp?.id
          ? `:information_source: Follow up (${followUp.duration} days) :information_source:`
          : ""
      }\n*Project:* ${project}\n*Action Id:* ${
        followUp?.id ? followUp.id : item.id
      }\n${text}\n\nOpened by ${item.githubItems[0].author?.githubUsername} on ${dayjs(
        item.githubItems[0].createdAt
      ).format("MMM DD, YYYY")} at ${dayjs(item.githubItems[0].createdAt).format("hh:mm A")}${
        item.lastReplyOn
          ? `\n*Last reply:* ${dayjs(item.lastReplyOn).fromNow()} ${diff > 10 ? ":panik:" : ""}`
          : "\n:panik: *No replies yet*"
      } | ${assigneeText}\n${item.githubItems[0].title ? url : ""}`,
    },
    accessory: showActions
      ? {
          type: "button",
          text: { type: "plain_text", emoji: true, text: "Resolve" },
          style: "primary",
          value: followUp?.id ? followUp.id : item.id,
          action_id: "resolve",
        }
      : {
          type: "static_select",
          placeholder: { type: "plain_text", text: "Assign to", emoji: true },
          options: maintainers
            .filter((m) => !!m)
            .map((maintainer) => ({
              text: { type: "plain_text", text: maintainer!.id, emoji: true },
              value: `${followUp?.id ? followUp.id : item.id}-${maintainer?.id}`,
            }))
            .concat(
              followUp?.id
                ? []
                : {
                    text: { type: "plain_text", text: "none", emoji: true },
                    value: `${item.id}-unassigned`,
                  }
            )
            .concat(
              ...(item.assignee && !isMaintainer
                ? [
                    {
                      text: {
                        type: "plain_text",
                        text: `<@${currentAssignee?.slack}> (volunteer)`,
                        emoji: true,
                      },
                      value: `${followUp?.id ? followUp.id : item.id}-${currentAssignee?.id}`,
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
                value: `${followUp?.id ? followUp.id : item.id}-${currentAssignee.id}`,
              }
            : followUp?.id
            ? undefined
            : {
                text: { type: "plain_text", text: "none", emoji: true },
                value: `${item.id}-unassigned`,
              },
          action_id: "assigned",
        },
  };
};

export const buttons = ({
  item,
  showAssignee = false,
  showActions = true,
  followUpId,
}: {
  item: ActionItem & {
    assignee: User | null | undefined;
    githubItems: (GithubItem & { repository: Repository; author: User })[];
    slackMessages: (SlackMessage & { channel: Channel; author: User })[];
  };
  showAssignee?: boolean;
  showActions?: boolean;
  followUpId?: string;
}) => {
  const maintainers = getMaintainers({
    repoUrl: item.githubItems[0]?.repository?.url,
    channelId: item.slackMessages[0]?.channel?.slackId,
  });
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
        ...(showActions
          ? [
              {
                type: "button",
                text: { type: "plain_text", emoji: true, text: "Snooze" },
                value: followUpId ?? item.id,
                action_id: "snooze",
              },
              {
                type: "button",
                text: { type: "plain_text", emoji: true, text: "Follow Up" },
                value: item.id,
                action_id: "followup",
              },
              {
                type: "button",
                text: { type: "plain_text", emoji: true, text: "Close - Irrelevant" },
                value: followUpId ?? item.id,
                action_id: "irrelevant",
              },
            ]
          : []),
        {
          type: "button",
          text: {
            type: "plain_text",
            emoji: true,
            text: `Notes ${item.notes.length > 0 ? "(👀)" : ""}`,
          },
          value: followUpId ?? item.id,
          action_id: "notes",
        },
        ...(showAssignee
          ? [
              {
                type: "static_select",
                placeholder: { type: "plain_text", text: "Assign to", emoji: true },
                options: maintainers
                  .filter((m) => !!m)
                  .map((maintainer) => ({
                    text: { type: "plain_text", text: maintainer!.id, emoji: true },
                    value: `${followUpId ?? item.id}-${maintainer?.id}`,
                  }))
                  .concat(
                    followUpId
                      ? []
                      : {
                          text: { type: "plain_text", text: "none", emoji: true },
                          value: `${item.id}-unassigned`,
                        }
                  )
                  .concat(
                    ...(item.assignee && !isMaintainer
                      ? [
                          {
                            text: {
                              type: "plain_text",
                              text: `<@${currentAssignee?.slack}> (volunteer)`,
                              emoji: true,
                            },
                            value: `${followUpId ?? item.id}-${currentAssignee?.id}`,
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
                      value: `${followUpId ?? item.id}-${currentAssignee.id}`,
                    }
                  : followUpId
                  ? undefined
                  : {
                      text: { type: "plain_text", text: "none", emoji: true },
                      value: `${followUpId ?? item.id}-unassigned`,
                    },
                action_id: "assigned",
              },
            ]
          : []),
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
