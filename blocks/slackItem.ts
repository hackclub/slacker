import { ActionItem, Channel, GithubItem, Repository, SlackMessage, User } from "@prisma/client";
import dayjs from "dayjs";
import { getMaintainers, getProjectName } from "../lib/utils";

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