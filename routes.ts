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

          for (const repo of repos) {
            const owner = repo.uri.split("/")[3];
            const name = repo.uri.split("/")[4];

            const dbRepo = await prisma.repository.upsert({
              where: { url: repo.uri },
              create: { name, owner, url: repo.uri },
              update: { name, owner },
            });

            const items = await listGithubItems(owner, name);

            for (const item of items) {
              const maintainers = await getMaintainers({ repoUrl: repo.uri });
              if (maintainers.find((maintainer) => maintainer?.github === item.author.login))
                return {};

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

              const githubItem = await prisma.githubItem.upsert({
                where: { nodeId: item.id },
                create: {
                  author: { connect: { id: author.id } },
                  repository: { connect: { id: dbRepo.id } },
                  nodeId: item.id,
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
                },
                update: {
                  state: "open",
                  updatedAt: item.updatedAt,
                  actionItem: {
                    update: {
                      status: "open",
                      totalReplies: item.comments.totalCount,
                      firstReplyOn: item.comments.nodes[0]?.createdAt,
                      lastReplyOn: item.comments.nodes[item.comments.nodes.length - 1]?.createdAt,
                      resolvedAt: null,
                      participants: { deleteMany: {} },
                    },
                  },
                },
                include: { actionItem: true },
              });

              const logins = item.participants.nodes.map((node) => node.login);
              await syncGithubParticipants(logins, githubItem.actionItem!.id);
            }

            const dbItems = await prisma.githubItem.findMany({
              where: { repositoryId: dbRepo.id, state: GithubState.open },
            });
            const ids = dbItems.map((item) => item.nodeId);
            const openIds = items.map((item) => item.id);
            const closedIds = ids.filter((id) => !openIds.includes(id));

            // close the action items that are closed on github
            for (const id of closedIds) {
              const res = await getGithubItem(owner, name, id);

              const githubItem = await prisma.githubItem.update({
                where: { nodeId: id },
                data: {
                  state: "closed",
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
          }
        }

        return { response: "ok" };
      } catch (err) {
        return { response: err.message };
      }
    },
  });
