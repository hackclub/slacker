import { ConnectRouter } from "@connectrpc/connect";
import { GithubItemType, GithubState } from "@prisma/client";
import { readFileSync, readdirSync } from "fs";
import yaml from "js-yaml";
import { ElizaService } from "./gen/eliza_connect";
import prisma from "./lib/db";
import { getOctokitToken } from "./lib/octokit";
import { Config, GithubData, SingleIssueOrPullData } from "./lib/types";
import { getMaintainers, syncGithubParticipants } from "./lib/utils";
import { Octokit } from "octokit";

// TODO: snoozing functionality and snooze count, snoozed until - only through admins

export default (router: ConnectRouter) =>
  router.service(ElizaService, {
    async syncGithubItems(req) {
      try {
        const files = readdirSync("./config");

        for await (const file of files) {
          const { repos } = yaml.load(readFileSync(`./config/${file}`, "utf-8")) as Config;

          for (const repo of repos) {
            const owner = repo.uri.split("/")[3];
            const name = repo.uri.split("/")[4];

            const dbRepo = await prisma.repository.upsert({
              where: { url: repo.uri },
              create: { name, owner, url: repo.uri },
              update: { name, owner },
            });

            const query = `
            query ($owner: String!, $name: String!) {
              repository(owner: $owner, name: $name) {
                issues(first: 100, states: OPEN) {
                  nodes {
                    id
                    number
                    title
                    createdAt
                    updatedAt
                    author {
                      login
                    }
                    participants (first: 100) {
                      nodes {
                        login
                      }
                    }
                    comments(first: 100) {
                      totalCount
                      nodes {
                        author {
                          login
                        }
                        createdAt
                      }
                    }
                  }
                }

                pullRequests(first: 100, states: OPEN) {
                  nodes {
                    id
                    number
                    title
                    createdAt
                    updatedAt
                    author {
                      login
                    }
                    participants (first: 100) {
                      nodes {
                        login
                      }
                    }
                    comments(first: 100) {
                      nodes {
                        author {
                          login
                        }
                        createdAt
                      }
                    }
                  }
                }
              }
            }
          `;

            const token = await getOctokitToken(owner, name);
            const octokit = new Octokit({ auth: "Bearer " + token });

            const res = (await octokit.graphql(query, { owner, name })) as GithubData;

            const items = [...res.repository.issues.nodes, ...res.repository.pullRequests.nodes];

            for (const item of items) {
              const maintainers = await getMaintainers({ repoUrl: repo.uri });
              if (maintainers.includes(item.author.login)) continue;

              const author = await prisma.user.upsert({
                where: { email: item.author.login },
                create: { email: item.author.login, githubUsername: item.author.login },
                update: { githubUsername: item.author.login },
              });

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
              await syncGithubParticipants(logins, githubItem.actionItem?.id ?? -1);
            }

            const dbItems = await prisma.githubItem.findMany({
              where: { repositoryId: dbRepo.id, state: GithubState.open },
            });
            const ids = dbItems.map((item) => item.nodeId);
            const openIds = items.map((item) => item.id);
            const closedIds = ids.filter((id) => !openIds.includes(id));

            for (const id of closedIds) {
              const query = `
              query ($id: String!) {
                node(id: $id) {
                  ... on Issue {
                    closedAt
                    assignees(first: 100) {
                      nodes {
                        login
                      }
                    }
                    participants(first: 100) {
                      nodes {
                        login
                      }
                    }
                    comments(first: 100) {
                      totalCount
                      nodes {
                        author {
                          login
                        }
                        createdAt
                      }
                    }
                  }
                  ... on PullRequest {
                    closedAt
                    assignees(first: 100) {
                      nodes {
                        login
                      }
                    }
                    participants(first: 100) {
                      nodes {
                        login
                      }
                    }
                    comments(first: 100) {
                      totalCount
                      nodes {
                        author {
                          login
                        }
                        createdAt
                      }
                    }
                  }
                }
              }
          `;

              const res = (await octokit.graphql(query, { id })) as SingleIssueOrPullData;

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
              await syncGithubParticipants(logins, githubItem.actionItem?.id ?? -1);
            }
          }
        }

        return { response: "ok" };
      } catch (err) {
        return { response: err.message };
      }
    },
  });
