import { ActionItem, Channel, GithubItem, Repository, SlackMessage, User } from "@prisma/client";
import { getMaintainers} from "../lib/utils";

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