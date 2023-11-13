import { ConnectRouter } from "@connectrpc/connect";
import { GithubItemType, GithubState, User } from "@prisma/client";
import { readdirSync } from "fs";
import { ElizaService } from "./gen/eliza_connect";
import prisma from "./lib/db";
import { getGithubItem, listGithubItems } from "./lib/octokit";
import { getMaintainers, getYamlFile, syncGithubParticipants } from "./lib/utils";

export default (router: ConnectRouter) =>
  router.service(ElizaService, {
    async syncGithubItems() {
      try {
        const files = readdirSync("./config");

        for await (const file of files) {
          const { repos } = getYamlFile(file);
          console.log(
            `===================== Syncing repositories for file: ${file} =====================`
          );

          for await (const repo of repos) {
            const owner = repo.uri.split("/")[3];
            const name = repo.uri.split("/")[4];

            console.log(`===================== Repository: ${repo.uri} =====================`);

            const dbRepo = await prisma.repository.upsert({
              where: { url: repo.uri },
              create: { name, owner, url: repo.uri },
              update: { name, owner },
            });

            const items = await listGithubItems(owner, name);

            for await (const item of items) {
              const maintainers = await getMaintainers({ repoUrl: repo.uri });
              if (maintainers.find((maintainer) => maintainer?.github === item.author.login))
                continue;

              // find user by login
              const user = await prisma.user.findFirst({
                where: { githubUsername: item.author.login },
              });
              let author: User;

              if (!user)
                author = await prisma.user.create({
                  data: { githubUsername: item.author.login, email: item.author.login },
                });
              else author = user;

              const actionItem = await prisma.actionItem.findFirst({
                where: { githubItemId: item.id },
              });

              const githubItem = await prisma.githubItem.upsert({
                where: { nodeId: item.id },
                create: {
                  author: { connect: { id: author.id } },
                  repository: { connect: { id: dbRepo.id } },
                  nodeId: item.id,
                  title: item.title,
                  number: item.number,
                  state: "open",
                  type: item.id.startsWith("I_")
                    ? GithubItemType.issue
                    : GithubItemType.pull_request,
                  createdAt: item.createdAt,
                  updatedAt: item.updatedAt,
                  actionItem: {
                    create: {
                      status: "open",
                      totalReplies: item.comments.totalCount ?? 0,
                      firstReplyOn: item.comments.nodes[0]?.createdAt,
                      lastReplyOn: item.comments.nodes[item.comments.nodes.length - 1]?.createdAt,
                    },
                  },
                  labelsOnItems: {
                    create: item.labels.nodes.map(({ name }) => ({
                      label: { connectOrCreate: { where: { name }, create: { name } } },
                    })),
                  },
                },
                update: {
                  state: "open",
                  title: item.title,
                  updatedAt: item.updatedAt,
                  labelsOnItems: {
                    deleteMany: {},
                    create: item.labels.nodes.map(({ name }) => ({
                      label: { connectOrCreate: { where: { name }, create: { name } } },
                    })),
                  },
                  actionItem: {
                    update: {
                      status: actionItem?.resolvedAt ? "closed" : "open",
                      totalReplies: item.comments.totalCount,
                      firstReplyOn: item.comments.nodes[0]?.createdAt,
                      lastReplyOn: item.comments.nodes[item.comments.nodes.length - 1]?.createdAt,
                      participants: { deleteMany: {} },
                    },
                  },
                },
                include: { actionItem: true },
              });

              const logins = item.participants.nodes.map((node) => node.login);
              await syncGithubParticipants(logins, githubItem.actionItem!.id);
            }

            console.log(
              `===================== Syncing closed items for repository: ${repo.uri} =====================`
            );

            const dbItems = await prisma.githubItem.findMany({
              where: { repositoryId: dbRepo.id, state: GithubState.open },
            });
            const ids = dbItems.map((item) => item.nodeId);
            const openIds = items.map((item) => item.id);
            const closedIds = ids.filter((id) => !openIds.includes(id));

            // close the action items that are closed on github
            for await (const id of closedIds) {
              const res = await getGithubItem(owner, name, id);

              const githubItem = await prisma.githubItem.update({
                where: { nodeId: id },
                data: {
                  state: "closed",
                  labelsOnItems: {
                    deleteMany: {},
                    create: res.node.labels.nodes.map(({ name }) => ({
                      label: { connectOrCreate: { where: { name }, create: { name } } },
                    })),
                  },
                  actionItem: {
                    update: {
                      status: "closed",
                      totalReplies: res.node.comments.totalCount,
                      firstReplyOn: res.node.comments.nodes[0]?.createdAt,
                      lastReplyOn:
                        res.node.comments.nodes[res.node.comments.nodes.length - 1]?.createdAt,
                      resolvedAt: res.node.closedAt,
                      participants: { deleteMany: {} },
                    },
                  },
                },
                include: { actionItem: { include: { participants: true } } },
              });

              const logins = res.node.participants.nodes.map((node) => node.login);
              await syncGithubParticipants(logins, githubItem.actionItem!.id);
            }

            console.log(
              `===================== Repository syncing done: ${repo.uri} =====================`
            );
          }
        }

        console.log("===================== Syncing done =====================");

        return { response: "ok" };
      } catch (err) {
        return { response: err.message };
      }
    },
  });
