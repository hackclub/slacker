import { ActionItem, Channel, GithubItem, Repository, SlackMessage, User } from "@prisma/client";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import relativeTime from "dayjs/plugin/relativeTime";
import { getMaintainers, getProjectName } from "./utils";
import metrics from "./metrics";
dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);

export const slackItem = ({
  item,
  showActions = true,
}: {
  item: ActionItem & {
    assignee: User | null | undefined;
    githubItems: (GithubItem & { repository: Repository })[];
    slackMessages: (SlackMessage & { channel: Channel; author: User })[];
  };
  showActions?: boolean;
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

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Project:* ${project}\n*Action Id:* ${item.id}\n*Query:* ${item.slackMessages
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((m) => `<@${m.author?.slackId}>: ${m.text}`)
        .join("\n")}\n\nOpened by <@${item.slackMessages[0].author?.slackId}> on ${dayjs(
        item.slackMessages[0].createdAt
      ).format("MMM DD, YYYY")} at ${dayjs(item.slackMessages[0].createdAt).format("hh:mm A")}${
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
            .concat({
              text: { type: "plain_text", text: "none", emoji: true },
              value: `${item.id}-unassigned`,
            })
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
}: {
  item: ActionItem & {
    assignee: User | null | undefined;
    githubItems: (GithubItem & { repository: Repository; author: User })[];
    slackMessages: (SlackMessage & { channel: Channel; author: User })[];
  };
  showActions?: boolean;
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
      text: `*Project:* ${project}\n*Action Id:* ${item.id}\n${text}\n\nOpened by ${
        item.githubItems[0].author?.githubUsername
      } on ${dayjs(item.githubItems[0].createdAt).format("MMM DD, YYYY")} at ${dayjs(
        item.githubItems[0].createdAt
      ).format("hh:mm A")}${
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
            .concat({
              text: { type: "plain_text", text: "none", emoji: true },
              value: `${item.id}-unassigned`,
            })
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
}: {
  item: ActionItem & {
    assignee: User | null | undefined;
    githubItems: (GithubItem & { repository: Repository; author: User })[];
    slackMessages: (SlackMessage & { channel: Channel; author: User })[];
  };
  showAssignee?: boolean;
  showActions?: boolean;
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
                value: item.id,
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
                value: item.id,
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
          value: item.id,
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
                    value: `${item.id}-${maintainer?.id}`,
                  }))
                  .concat({
                    text: { type: "plain_text", text: "none", emoji: true },
                    value: `${item.id}-unassigned`,
                  })
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
                  : {
                      text: { type: "plain_text", text: "none", emoji: true },
                      value: `${item.id}-unassigned`,
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
