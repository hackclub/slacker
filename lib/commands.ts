import { readFileSync, readdirSync } from "fs";
import prisma from "./db";
import { Config } from "./types";
import yaml from "js-yaml";
import dayjs from "dayjs";
import { ActionStatus } from "@prisma/client";
import { StringIndexed } from "@slack/bolt/dist/types/helpers";
import { Middleware, SlackCommandMiddlewareArgs } from "@slack/bolt";
import customParseFormat from "dayjs/plugin/customParseFormat";
import relativeTime from "dayjs/plugin/relativeTime";
dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);

export const handleSlackerCommand: Middleware<SlackCommandMiddlewareArgs, StringIndexed> = async ({
  command,
  ack,
  client,
  logger,
}) => {
  await ack();

  try {
    const { text, user_id, channel_id } = command;
    let [project, filter] = text.split(" ");
    if (project.trim() === "") project = "all";

    const files = readdirSync("./config");
    if (project !== "all" && !files.includes(`${project}.yaml`)) {
      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `:warning: Project not found. Please check your command and try again.`,
      });
      return;
    }

    if (filter && !["", "all", "github", "slack"].includes(filter.trim())) {
      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `:warning: Invalid filter. Please check your command and try again.`,
      });
      return;
    }

    const user = await prisma.user.findFirst({ where: { slackId: user_id } });

    let channels: Config["slack-channels"] = [];
    let repositories: Config["repos"] = [];
    let managers: Config["slack-managers"] = [];
    let maintainers: Config["maintainers"] = [];

    if (project === "all") {
      files.forEach((file) => {
        const config = yaml.load(readFileSync(`./config/${file}`, "utf-8")) as Config;

        if (
          config.maintainers.includes(user?.githubUsername ?? "") ||
          config["slack-managers"].includes(user_id)
        ) {
          channels = [...(channels || []), ...(config["slack-channels"] || [])];
          repositories = [...repositories, ...config["repos"]];
          managers = [...managers, ...config["slack-managers"]];
          maintainers = [...maintainers, ...config.maintainers];
        }
      });
    } else {
      const config = yaml.load(readFileSync(`./config/${project}.yaml`, "utf-8")) as Config;
      channels = config["slack-channels"] || [];
      repositories = config["repos"];
      managers = config["slack-managers"];
      maintainers = config.maintainers;
    }

    if (!managers.includes(user_id)) {
      // not a slack manager... maybe a github maintainer?
      if (user?.githubUsername && !maintainers.includes(user?.githubUsername ?? "")) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Sorry, you are not a maintainer for this project. Make sure you're listed inside the config/[project].yaml file.`,
        });
        return;
      }
    }

    const data = await prisma.actionItem
      .findMany({
        where: {
          OR: [
            ...(!filter || filter === "all" || filter === "slack"
              ? [{ slackMessage: { channel: { slackId: { in: channels.map((c) => c.id) } } } }]
              : []),
            ...((!filter || filter === "all" || filter === "github") &&
            maintainers.includes(user?.githubUsername ?? "")
              ? [
                  {
                    githubItem: {
                      repository: {
                        owner: { in: repositories.map((r) => r.uri.split("/")[3]) },
                        name: { in: repositories.map((r) => r.uri.split("/")[4]) },
                      },
                    },
                  },
                ]
              : []),
          ],
          status: { not: ActionStatus.closed },
        },
        include: {
          githubItem: { include: { author: true, repository: true } },
          slackMessage: { include: { author: true, channel: true } },
          participants: { include: { user: true } },
        },
      })
      .then((res) =>
        res.filter((i) => i.snoozedUntil === null || dayjs().isAfter(dayjs(i.snoozedUntil)))
      );

    await client.chat.postMessage({
      channel: user_id,
      unfurl_links: false,
      text: `:white_check_mark: Here are your action items:`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:white_check_mark: Here are your action items:`,
          },
        },
        {
          type: "divider",
        },
        ...data
          .slice(0, 15)
          .map((item) => {
            const arr: any[] = [];
            const diff = dayjs().diff(dayjs(item.lastReplyOn), "day");

            if (item.slackMessage !== null) {
              arr.push({
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `Query: *${item.slackMessage?.text}*\n\nOpened by <@${
                    item.slackMessage?.author?.slackId
                  }> on ${dayjs(item.slackMessage?.createdAt).format("MMM DD, YYYY")} at ${dayjs(
                    item.slackMessage?.createdAt
                  ).format("hh:mm A")}${
                    item.lastReplyOn
                      ? `\n*Last reply:* ${dayjs(item.lastReplyOn).fromNow()} ${
                          diff > 10 ? ":panik:" : ""
                        }`
                      : "\n:panik: *No replies yet*"
                  }\n<https://hackclub.slack.com/archives/${
                    item.slackMessage?.channel?.slackId
                  }/p${item.slackMessage?.ts.replace(".", "")}|View on Slack>`,
                },
                accessory: {
                  type: "button",
                  text: {
                    type: "plain_text",
                    emoji: true,
                    text: "Resolve",
                  },
                  style: "primary",
                  value: item.id,
                  action_id: "resolve",
                },
              });
            }

            if (item.githubItem !== null) {
              const text =
                (item.githubItem?.type === "issue" ? "Issue: " : "Pull Request: ") +
                `https://github.com/${item.githubItem?.repository?.owner}/${item.githubItem?.repository?.name}/issues/${item.githubItem?.number}`;

              arr.push({
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `${text}\n\nOpened by ${item.githubItem?.author?.githubUsername} on ${dayjs(
                    item.githubItem?.createdAt
                  ).format("MMM DD, YYYY")} at ${dayjs(item.githubItem?.createdAt).format(
                    "hh:mm A"
                  )}${
                    item.lastReplyOn
                      ? `\n*Last reply:* ${dayjs(item.lastReplyOn).fromNow()} ${
                          diff > 10 ? ":panik:" : ""
                        }`
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
              });
            }

            // Buttons
            arr.push({
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", emoji: true, text: "Snooze" },
                  style: "danger",
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

            return arr;
          })
          .flat(),
        { type: "divider" },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `*Total action items:* ${data.length} | ${
                user?.githubUsername
                  ? `Logged in with github. You're all good.`
                  : `In order to get github items, please <${process.env.DEPLOY_URL}/auth?id=${user_id}|authenticate> slacker to access your github account.`
              }`,
            },
          ],
        },
      ],
    });
  } catch (err) {
    logger.error(err);
  }
};