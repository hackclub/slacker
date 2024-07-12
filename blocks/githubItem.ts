import { ActionItem, Channel, GithubItem, Repository, SlackMessage, User } from "@prisma/client";
import dayjs from "dayjs";
import { getMaintainers, getProjectName } from "../lib/utils";

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