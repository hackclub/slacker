import { ActionStatus, GithubItemType } from "@prisma/client";
import { Middleware, SlackCommandMiddlewareArgs } from "@slack/bolt";
import { StringIndexed } from "@slack/bolt/dist/types/helpers";
import { closestMatch } from "closest-match";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import relativeTime from "dayjs/plugin/relativeTime";
import { readdirSync } from "fs";
import { Octokit } from "octokit";
import { buttons, githubItem, slackItem, unauthorizedError } from "./blocks";
import prisma from "./db";
import { indexDocument } from "./elastic";
import metrics from "./metrics";
import { MAINTAINERS, getMaintainers, getProjectDetails, getYamlFile, logActivity } from "./utils";
import { assignIssueToVolunteer } from "./octokit";
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
    let user = await prisma.user.findFirst({ where: { slackId: user_id } });

    if (!user) {
      const userInfo = await client.users.info({ user: user_id });
      user = await prisma.user.create({
        data: { slackId: user_id, email: userInfo.user?.profile?.email },
      });
    }

    const args = text.split(" ");

    if (args[0]) {
      metrics.increment(`command.${args[0]}.executed`, 1);
    }
    metrics.increment("command.all.executed");

    const startMetrics = performance.now();

    if (!args[0] || args[0] === "help") {
      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `:wave: Hi there! I'm Slacker, your friendly neighborhood action item manager. Here's what I can do:
        \n• *List all projects:* \`/slacker whatsupfr\`
        \n• *List projects:* \`/slacker whatsup\`
        \n• *Get project resources:* \`/slacker resources [project]\`
        \n• *List action items:* \`/slacker list [project] [filter]\`
        \n• *Assign an action item:* \`/slacker assign [id] [assignee]\`
        \n• *Get an action item assigned to you:* \`/slacker gimme [project] [filter]\`
        \n• *List your action items:* \`/slacker me [project] [filter]\`
        \n• *Get GitHub items assigned to you:* \`/slacker gh [project] [filter]\`
        \n• *Review pulls on GitHub:* \`/slacker review [project]\`
        \n• *Reopen action item:* \`/slacker reopen [id]\`
        \n• *List snoozed items:* \`/slacker snoozed [project]\`
        \n• *Get a project report:* \`/slacker report [project]\`
        \n• *Opt out of status report notifications:* \`/slacker optout\`
        \n• *Opt in to status report notifications:* \`/slacker optin\`
        \n• *Help:* \`/slacker help\``,
      });
    } else if (args[0] === "list") {
      const project = args[1]?.trim() || "all";
      const filter = args[2]?.trim() || "";
      const files = readdirSync("./config");

      if (project !== "all" && !files.includes(`${project}.yaml`)) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Project not found. Please check your command and try again.`,
        });
        return;
      }

      const { maintainers, channels, repositories, sections } = await getProjectDetails(
        project,
        user_id,
        user?.githubUsername
      );

      if (
        filter &&
        !["", "all", "github", "slack", "issues", "pulls", ...sections.map((s) => s.name)].includes(
          filter.trim()
        )
      ) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Invalid filter. Please check your command and try again. Available options: "all", "github", "slack", "issues", "pulls", ${sections.map(
            (s, i) => (i === sections.length - 1 ? "" : " ") + `"${s.name}"`
          )}.`,
        });
        return;
      }

      if (!maintainers.find((m) => m.slack === user_id)) {
        if (!user) {
          return await unauthorizedError({ client, user_id, channel_id });
        } else if (!user.githubUsername) {
          return await unauthorizedError({ client, user_id, channel_id });
        } else if (!maintainers.find((m) => m.github === user?.githubUsername)) {
          return await unauthorizedError({ client, user_id, channel_id });
        }
      }

      const data = await prisma.actionItem
        .findMany({
          where: {
            OR: [
              ...(isfilteringSlack(sections, filter)
                ? [
                    {
                      slackMessages: {
                        some: { channel: { slackId: { in: channels.map((c) => c.id) } } },
                      },
                    },
                  ]
                : []),
              ...(isfilteringGithub(sections, filter)
                ? [
                    {
                      githubItems: {
                        some: {
                          repository: { url: { in: repositories.map((r) => r.uri) } },
                          ...(filter === "issues" ? { type: GithubItemType.issue } : {}),
                          ...(filter === "pulls" ? { type: GithubItemType.pull_request } : {}),
                        },
                      },
                    },
                  ]
                : []),
            ],
            status: { not: ActionStatus.closed },
          },
          include: {
            githubItems: { include: { author: true, repository: true } },
            slackMessages: { include: { author: true, channel: true } },
            participants: { include: { user: true } },
            assignee: true,
          },
          orderBy: { createdAt: "asc" },
        })
        .then((res) => {
          return (res || [])
            .filter((i) => i.snoozedUntil === null || dayjs().isAfter(dayjs(i.snoozedUntil)))
            .filter((i) => filterBySection(i, isfilteringSections(sections, filter)));
        });

      await client.chat.postMessage({
        channel: user_id,
        unfurl_links: false,
        text: `:white_check_mark: Here are your action items:`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `:white_check_mark: Here are your action items:` },
          },
          { type: "divider" },
          ...data
            .slice(0, 15)
            .map((item) => {
              const arr: any[] = [];

              if (item.slackMessages.length > 0) arr.push(slackItem({ item, showActions: false }));
              if (item.githubItems.length > 0) arr.push(githubItem({ item, showActions: false }));
              arr.push(...buttons({ item, showActions: false, showAssignee: false }));

              return arr;
            })
            .flat(),
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
    } else if (args[0] === "reopen") {
      const item = await prisma.actionItem.findFirst({ where: { id: args[1] } });

      if (!item) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Action item not found. Please check your command and try again.`,
        });
        return;
      }

      if (item.status === ActionStatus.closed) {
        await prisma.actionItem.update({
          where: { id: item.id },
          data: { status: ActionStatus.open, flag: null, resolvedAt: null },
        });

        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:white_check_mark: Action item reopened.`,
        });

        await indexDocument(item.id, { timesReopened: 1 });
        await logActivity(client, user_id, item.id, "reopened");
      } else {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Action item is already open.`,
        });
      }
    } else if (args[0] === "whatsup") {
      const files = readdirSync("./config");
      const text = `:white_check_mark: Here are your projects:\n\n
        ${files
          .map((file) => {
            const config = getYamlFile(file);

            const maintainers = config.maintainers.map((id) =>
              MAINTAINERS.find((user) => user.id === id)
            );

            if (
              maintainers.find(
                (maintainer) =>
                  maintainer?.slack === user_id || maintainer?.github === user?.githubUsername
              )
            )
              return `\n• *${file.split(".")[0]}* - ${config.description}`;
          })
          .join("")}`;

      await client.chat.postEphemeral({ user: user_id, channel: channel_id, text });
    } else if (args[0] === "whatsupfr") {
      const files = readdirSync("./config");
      const text = `:white_check_mark: Here are all the projects on slacker:\n\n
        ${files
          .map((file) => {
            const config = getYamlFile(file);
            return `\n• *${file.split(".")[0]}* - ${config.description}`;
          })
          .join("")}`;

      await client.chat.postEphemeral({ user: user_id, channel: channel_id, text });
    } else if (args[0] === "resources") {
      const project = args[1]?.trim();

      if (!project) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Project not found. Please check your command and try again.`,
        });
        return;
      }

      const text = `:white_check_mark: Here are the resources for *${project}*: \n\n
        ${getYamlFile(`${project}.yaml`)
          .resources?.map((r) => `\n• *${r.name}* - ${r.uri}`)
          .join("")}`;

      await client.chat.postEphemeral({ user: user_id, channel: channel_id, text });
    } else if (args[0] === "snoozed") {
      const project = args[1]?.trim() || "all";
      const files = readdirSync("./config");

      if (project !== "all" && !files.includes(`${project}.yaml`)) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Project not found. Please check your command and try again.`,
        });
        return;
      }

      const { maintainers, channels, repositories } = await getProjectDetails(
        project,
        user_id,
        user?.githubUsername
      );

      if (!maintainers.find((m) => m.slack === user_id)) {
        if (!user) {
          return await unauthorizedError({ client, user_id, channel_id });
        } else if (!user.githubUsername) {
          return await unauthorizedError({ client, user_id, channel_id });
        } else if (!maintainers.find((m) => m.github === user?.githubUsername)) {
          return await unauthorizedError({ client, user_id, channel_id });
        }
      }

      const data = await prisma.actionItem.findMany({
        where: {
          snoozedUntil: { not: null, lte: dayjs().toDate() },
          OR: [
            {
              slackMessages: { some: { channel: { slackId: { in: channels.map((c) => c.id) } } } },
            },
            ...(maintainers.find((m) => m.github === user?.githubUsername)
              ? [
                  {
                    githubItems: {
                      some: { repository: { url: { in: repositories.map((r) => r.uri) } } },
                    },
                  },
                ]
              : []),
          ],
          status: { not: ActionStatus.closed },
        },
        include: {
          githubItems: { include: { author: true, repository: true } },
          slackMessages: { include: { author: true, channel: true } },
          participants: { include: { user: true } },
        },
      });

      await client.chat.postMessage({
        channel: user_id,
        unfurl_links: false,
        text: `:white_check_mark: Here are your snoozed action items:`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:white_check_mark: Here are your snoozed action items:`,
            },
          },
          { type: "divider" },
          ...data
            .map((item) => {
              const arr: any[] = [];

              if (item.slackMessages.length > 0)
                arr.push({
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `${item.id}: https://hackclub.slack.com/archives/${
                      item.slackMessages[0].channel?.slackId
                    }/p${item.slackMessages[0].ts.replace(".", "")}`,
                  },
                  accessory: {
                    type: "button",
                    text: { type: "plain_text", emoji: true, text: "Unsnooze" },
                    style: "primary",
                    value: item.id,
                    action_id: "unsnooze",
                  },
                });

              if (item.githubItems.length > 0)
                arr.push({
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `${item.id}: https://github.com/${item.githubItems[0].repository?.owner}/${item.githubItems[0].repository?.name}/issues/${item.githubItems[0].number}`,
                  },
                  accessory: {
                    type: "button",
                    text: { type: "plain_text", emoji: true, text: "Unsnooze" },
                    style: "primary",
                    value: item.id,
                    action_id: "unsnooze",
                  },
                });

              return arr;
            })
            .flat(),
        ],
      });
    } else if (args[0] === "report") {
      const project = args[1]?.trim();

      if (!project) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Project not found. Please check your command and try again.`,
        });
        return;
      }

      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `🚧 Work in progress. Please check back later.`,
      });
    } else if (args[0] === "assign") {
      const id = args[1]?.trim();
      const assignee = args[2]?.trim();

      if (!id || !assignee) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: No ID or assignee provided. Please check your command and try again.`,
        });
        return;
      }

      const item = await prisma.actionItem.findFirst({
        where: { id, status: ActionStatus.open },
        include: {
          githubItems: { include: { repository: true } },
          slackMessages: { include: { channel: true } },
        },
      });

      if (!item) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Action item not found or already closed. Please check your command and try again.`,
        });
        return;
      }

      const maintainers = getMaintainers({
        channelId: item.slackMessages[0].channel?.slackId,
        repoUrl: item.githubItems[0].repository?.url,
      });

      if (!maintainers.find((m) => m?.id === assignee)) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Assignee is not a top-level maintainer. Please check your command and try again.\n*Top-level maintainers:* ${maintainers
            .map((m) => `<@${m?.id}>`)
            .join(", ")}`,
        });
        return;
      }

      const maintainer = maintainers.find((m) => m?.id === assignee);
      let user = await prisma.user.findFirst({
        where: { OR: [{ slackId: maintainer?.slack }, { githubUsername: maintainer?.github }] },
      });

      if (!user) {
        const userInfo = await client.users.info({ user: maintainer?.slack as string });
        user = await prisma.user.create({
          data: {
            slackId: maintainer?.slack,
            githubUsername: maintainer?.github,
            email: userInfo.user?.profile?.email,
          },
        });
      }

      await prisma.actionItem.update({
        where: { id },
        data: { assignee: { connect: { id: user?.id } }, assignedOn: new Date() },
      });

      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `:white_check_mark: Action item assigned to <@${maintainer?.slack}>.`,
      });

      await indexDocument(id, { timesAssigned: 1 });
      await logActivity(client, user_id, id, "assigned", maintainer?.slack);
    } else if (args[0] === "me") {
      const project = args[1]?.trim() || "all";
      const filter = args[2]?.trim() || "";
      const files = readdirSync("./config");

      if (project !== "all" && !files.includes(`${project}.yaml`)) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Project not found. Please check your command and try again.`,
        });
        return;
      }

      const { channels, repositories, sections } = await getProjectDetails(
        project,
        undefined,
        undefined,
        false
      );

      if (
        filter &&
        !["", "all", "github", "slack", "issues", "pulls", ...sections.map((s) => s.name)].includes(
          filter.trim()
        )
      ) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Invalid filter. Please check your command and try again. Available options: "all", "github", "slack", "issues", "pulls", ${sections.map(
            (s, i) => (i === sections.length - 1 ? "" : " ") + `"${s.name}"`
          )}.`,
        });
        return;
      }

      const maintainer = MAINTAINERS.find((m) => m.slack === user_id) || {
        github: user?.githubUsername || "",
        slack: user_id,
        id: user?.id,
      };

      const items = await prisma.actionItem
        .findMany({
          where: {
            OR: [
              ...(isfilteringSlack(sections, filter)
                ? [
                    {
                      slackMessages: {
                        some: { channel: { slackId: { in: channels.map((c) => c.id) } } },
                      },
                    },
                  ]
                : []),
              ...(isfilteringGithub(sections, filter)
                ? [
                    {
                      githubItems: {
                        some: {
                          repository: { url: { in: repositories.map((r) => r.uri) } },
                          ...(filter === "issues" ? { type: GithubItemType.issue } : {}),
                          ...(filter === "pulls" ? { type: GithubItemType.pull_request } : {}),
                        },
                      },
                    },
                  ]
                : []),
            ],
            assignee: { OR: [{ slackId: user_id }, { githubUsername: maintainer?.github }] },
            status: { not: ActionStatus.closed },
            resolvedAt: null,
          },
          include: {
            githubItems: { include: { repository: true, author: true } },
            slackMessages: { include: { channel: true, author: true } },
            assignee: true,
          },
        })
        .then((res) =>
          (res || [])
            .filter((i) => i.snoozedUntil === null || dayjs().isAfter(dayjs(i.snoozedUntil)))
            .filter((i) => filterBySection(i, isfilteringSections(sections, filter)))
        );

      if (items.length > 0) {
        const arr: any[] = [];

        items.forEach((item) => {
          if (item.slackMessages.length > 0) arr.push(slackItem({ item }));
          if (item.githubItems.length > 0) arr.push(githubItem({ item }));
          arr.push(...buttons({ item, showAssignee: true, showActions: true }));
        });

        await client.chat.postMessage({
          channel: user_id,
          unfurl_links: false,
          text: `:white_check_mark: Here are the action items assigned to you:`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:white_check_mark: Here are the action item assigned to you:`,
              },
            },
            { type: "divider" },
            ...arr.flat(),
          ],
        });
      } else {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:white_check_mark: You have no action items assigned to you. Use \`/slacker gimme\` to get an action item.`,
        });
      }
    } else if (args[0] === "gimme") {
      const project = args[1]?.trim() || "all";
      const filter = args[2]?.trim() || "";
      const files = readdirSync("./config");

      if (project !== "all" && !files.includes(`${project}.yaml`)) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Project not found. Please check your command and try again.`,
        });
        return;
      }

      const { maintainers, channels, repositories, sections } = await getProjectDetails(
        project,
        user_id,
        user?.githubUsername
      );

      if (
        filter &&
        !["", "all", "github", "slack", "issues", "pulls", ...sections.map((s) => s.name)].includes(
          filter.trim()
        )
      ) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Invalid filter. Please check your command and try again. Available options: "all", "github", "slack", "issues", "pulls", ${sections.map(
            (s, i) => (i === sections.length - 1 ? "" : " ") + `"${s.name}"`
          )}.`,
        });
        return;
      }

      let isVolunteer = !maintainers.find((m) => m.slack === user_id) && project !== "all";

      if (!user) {
        return await unauthorizedError({ client, user_id, channel_id });
      } else if (project === "all" && !maintainers.find((m) => m.slack === user_id)) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: You're not a manager for any projects. If you're looking to volunteer, make sure to specify a project.`,
        });
        return;
      } else if (!user.githubUsername) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Login with github to get assigned to a task. <${process.env.DEPLOY_URL}/auth?id=${user_id}|authenticate>`,
        });
        return;
      }

      if (isVolunteer) {
        const data = await prisma.actionItem
          .findMany({
            where: {
              githubItems: {
                some: {
                  repository: { url: { in: repositories.map((r) => r.uri) } },
                  type: "issue",
                  labelsOnItems: { some: { label: { name: "good first issue" } } },
                  state: "open",
                  volunteer: { is: null },
                },
              },
            },
            orderBy: { totalReplies: "asc" },
            include: {
              githubItems: { include: { author: true, repository: true } },
              slackMessages: { include: { author: true, channel: true } },
              participants: { select: { user: true } },
              assignee: true,
            },
          })
          .then((res) =>
            (res || []).filter(
              (i) => i.snoozedUntil === null || dayjs().isAfter(dayjs(i.snoozedUntil))
            )
          );
        await assignIssueToVolunteer(data, user, client, user_id, channel_id);
        return;
      }

      const data = await prisma.actionItem
        .findMany({
          where: {
            OR: [
              ...(isfilteringSlack(sections, filter)
                ? [
                    {
                      slackMessages: {
                        some: { channel: { slackId: { in: channels.map((c) => c.id) } } },
                      },
                    },
                  ]
                : []),
              ...(isfilteringGithub(sections, filter) &&
              !!maintainers.find((m) => m.github === user?.githubUsername)
                ? [
                    {
                      githubItems: {
                        some: {
                          repository: { url: { in: repositories.map((r) => r.uri) } },
                          ...(filter === "issues" ? { type: GithubItemType.issue } : {}),
                          ...(filter === "pulls" ? { type: GithubItemType.pull_request } : {}),
                        },
                      },
                    },
                  ]
                : []),
            ],
            status: { not: ActionStatus.closed },
            assignee: { is: null },
          },
          orderBy: { totalReplies: "asc" },
          include: {
            githubItems: { include: { author: true, repository: true } },
            slackMessages: { include: { author: true, channel: true } },
            participants: { select: { user: true } },
            assignee: true,
          },
        })
        .then((res) =>
          (res || [])
            .filter((i) => i.snoozedUntil === null || dayjs().isAfter(dayjs(i.snoozedUntil)))
            .filter((i) => filterBySection(i, isfilteringSections(sections, filter)))
        );

      if (data.length < 1) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:white_check_mark: No action items available. Please check back later.`,
        });
        return;
      }

      const id = data[0].id;

      const item = await prisma.actionItem.update({
        where: { id },
        data: { assignee: { connect: { id: user?.id } }, assignedOn: new Date() },
        include: {
          githubItems: { include: { author: true, repository: true } },
          slackMessages: { include: { author: true, channel: true } },
          participants: { include: { user: true } },
          assignee: true,
        },
      });

      const arr: any[] = [];
      if (item.slackMessages.length > 0) arr.push(slackItem({ item }));
      if (item.githubItems.length > 0) arr.push(githubItem({ item }));
      arr.push(...buttons({ item, showAssignee: true, showActions: true }));

      await client.chat.postMessage({
        channel: user_id,
        unfurl_links: false,
        text: `:white_check_mark: Here is the action item assigned to you:`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:white_check_mark: Here is the action item assigned to you:`,
            },
          },
          { type: "divider" },
          ...arr.flat(),
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Gimme another", emoji: true },
                value: text,
                action_id: "gimme_again",
              },
            ],
          },
          {
            type: "context",
            elements: [{ type: "plain_text", text: `/slacker ${text}`, emoji: true }],
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `*Remaining items in queue:* ${data.length} | ${
                  user?.githubUsername
                    ? ""
                    : `In order to get github items, please <${process.env.DEPLOY_URL}/auth?id=${user_id}|authenticate> slacker to access your github account.`
                }`,
              },
            ],
          },
        ],
      });

      await indexDocument(item.id, { timesAssigned: 1 });
    } else if (args[0] === "optout") {
      await prisma.user.update({ where: { id: user.id }, data: { optOut: true } });

      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `:white_check_mark: You have opted out of the status report notifications.`,
      });
    } else if (args[0] === "optin") {
      await prisma.user.update({ where: { id: user.id }, data: { optOut: false } });

      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `:white_check_mark: You have opted in to the status report notifications.`,
      });
    } else if (args[0] === "gh") {
      const project = args[1]?.trim() || "all";
      const filter = args[2]?.trim() || "";
      const files = readdirSync("./config");

      if (project !== "all" && !files.includes(`${project}.yaml`)) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Project not found. Please check your command and try again.`,
        });
        return;
      }

      if (filter && !["", "all", "issues", "pulls"].includes(filter.trim())) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Invalid filter. Please check your command and try again. Available options: "all", "issues", "pulls".`,
        });
        return;
      }

      const maintainer = MAINTAINERS.find((m) => m.slack === user_id) || {
        github: user?.githubUsername || "",
        slack: user_id,
        id: user?.id,
      };

      if (!maintainer || !maintainer.github) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Not logged in with GitHub. Please <${process.env.DEPLOY_URL}/auth?id=${user_id}|authenticate> slacker to access your GitHub account.`,
        });
        return;
      }

      const { repositories } = await getProjectDetails(project, user_id, user?.githubUsername);
      const octokit = new Octokit();
      const q = `${repositories
        .map((r) => "repo:" + r.uri.split("/")[3] + "/" + r.uri.split("/")[4])
        .join(" ")} state:open assignee:${maintainer.github} ${
        filter === "issues" ? "is:issue" : ""
      } ${filter === "pulls" ? "is:pr" : ""}`;

      const { data } = await octokit.rest.search.issuesAndPullRequests({ q });
      await client.chat.postMessage({
        channel: user_id,
        unfurl_links: false,
        text: `:white_check_mark: Here are your GitHub items:`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `:white_check_mark: Here are your GitHub items:` },
          },
          { type: "divider" },
          ...data.items
            .slice(0, 15)
            .map((item) => {
              const arr: any[] = [];

              arr.push({
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*#${item.number}* ${item.title} - ${item.html_url}\nOpened by ${
                    item.user?.login
                  } ${dayjs(item.created_at).fromNow()}`,
                },
              });

              return arr;
            })
            .flat(),
        ],
      });
    } else if (args[0] === "review") {
      const project = args[1]?.trim() || "all";
      const files = readdirSync("./config");

      if (project !== "all" && !files.includes(`${project}.yaml`)) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Project not found. Please check your command and try again.`,
        });
        return;
      }

      const maintainer = MAINTAINERS.find((m) => m.slack === user_id) || {
        github: user?.githubUsername || "",
        slack: user_id,
        id: user?.id,
      };

      if (!maintainer || !maintainer.github) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Not logged in with GitHub. Please <${process.env.DEPLOY_URL}/auth?id=${user_id}|authenticate> slacker to access your GitHub account.`,
        });
        return;
      }

      const { repositories } = await getProjectDetails(project, user_id, user?.githubUsername);
      const octokit = new Octokit();
      const q = `${repositories
        .map((r) => "repo:" + r.uri.split("/")[3] + "/" + r.uri.split("/")[4])
        .join(" ")} state:open type:pr review-requested:${
        maintainer.github
      } user-review-requested:${maintainer.github}`;

      const { data } = await octokit.rest.search.issuesAndPullRequests({ q });
      await client.chat.postMessage({
        channel: user_id,
        unfurl_links: false,
        text: `:white_check_mark: Here are the pull requests needing your review:`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:white_check_mark: Here are the pull requests needing your review:`,
            },
          },
          { type: "divider" },
          ...data.items
            .slice(0, 15)
            .map((item) => {
              const arr: any[] = [];

              arr.push({
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*#${item.number}* ${item.title} - ${item.html_url}\nOpened by ${
                    item.user?.login
                  } ${dayjs(item.created_at).fromNow()}`,
                },
              });

              return arr;
            })
            .flat(),
        ],
      });
    } else if (args[0] === "cleanup") {
      const project = args[1]?.trim();
      const files = readdirSync("./config");

      if (!project || !files.includes(`${project}.yaml`)) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: Project not found. Please check your command and try again.`,
        });
        return;
      }

      if (
        MAINTAINERS.find((m) => m.slack === user_id)?.id !== "faisal" &&
        MAINTAINERS.find((m) => m.slack === user_id)?.id !== "graham"
      ) {
        await client.chat.postEphemeral({
          user: user_id,
          channel: channel_id,
          text: `:warning: You're not authorized to run this command.`,
        });
        return;
      }

      const { channels } = await getProjectDetails(project);
      const res = await prisma.$transaction(async (tx) => {
        const messages = await tx.slackMessage.findMany({
          where: {
            channel: { slackId: { in: channels.map((c) => c.id) } },
            actionItem: { status: ActionStatus.open },
          },
          select: { id: true },
        });

        await tx.slackMessage.deleteMany({ where: { id: { in: messages.map((m) => m.id) } } });

        const items = await tx.actionItem.findMany({
          where: {
            status: ActionStatus.open,
            slackMessages: { some: { id: { in: messages.map((m) => m.id) } } },
          },
          select: { id: true, _count: { select: { slackMessages: true, githubItems: true } } },
        });

        const res = await tx.actionItem.deleteMany({
          where: {
            id: {
              in: items
                .filter((i) => i._count.slackMessages === 0 && i._count.githubItems !== 0)
                .map((i) => i.id),
            },
          },
        });

        return res;
      });

      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `:white_check_mark: Cleanup complete. ${res.count} action items deleted.`,
      });
    } else {
      const closest = closestMatch(args[0], [
        "list",
        "reopen",
        "whatsup",
        "whatsupfr",
        "snoozed",
        "get",
        "report",
        "assign",
        "me",
        "gimme",
        "help",
      ]);

      await client.chat.postEphemeral({
        user: user_id,
        channel: channel_id,
        text: `:nerd_face: :point_up: errrmm acktwually, i think you mean \`/slacker ${closest}\``,
      });
    }

    if (args[0]) {
      metrics.timing(`command.${args[0]}`, performance.now() - startMetrics);
    }
  } catch (err) {
    metrics.increment(`command.all.error`, 1);
    logger.error(err);
  }
};

const filterBySection = (i, filteringSections: { name: string; pattern: string } | undefined) => {
  if (filteringSections) {
    const regex = new RegExp(filteringSections.pattern);
    return (
      regex.test(i.githubItem?.title || "") ||
      regex.test(i.githubItem?.body || "") ||
      regex.test(i.slackMessage?.text || "")
    );
  }

  return true;
};

const isfilteringSlack = (
  sections: {
    name: string;
    pattern: string;
  }[],
  filter: string
) => !filter || ["", "all", "slack", ...sections.map((s) => s.name)].includes(filter.trim());

const isfilteringGithub = (
  sections: {
    name: string;
    pattern: string;
  }[],
  filter: string
) =>
  !filter ||
  ["", "all", "github", "issues", "pulls", ...sections.map((s) => s.name)].includes(filter.trim());

const isfilteringSections = (
  sections: {
    name: string;
    pattern: string;
  }[],
  filter: string
) => sections.find((s) => s.name === filter.trim());
