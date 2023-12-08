import { createAppAuth } from "@octokit/auth-app";
import { Webhooks } from "@octokit/webhooks";
import { GithubItemType, User } from "@prisma/client";
import { Octokit } from "octokit";
import { slack } from "..";
import prisma from "./db";
import { indexDocument } from "./elastic";
import metrics from "./metrics";
import { GithubData, SingleIssueOrPullData } from "./types";
import { MAINTAINERS, getMaintainers, getProject } from "./utils";

const appId = process.env.GITHUB_APP_ID || "";
const base64 = process.env.GITHUB_PRIVATE_KEY || "";
const privateKey = Buffer.from(base64, "base64").toString("utf-8");

export const webhooks = new Webhooks({ secret: process.env.GITHUB_WEBHOOK_SECRET || "" });

webhooks.on("issues.opened", async ({ payload }) => createGithubItem(payload));
webhooks.on("pull_request.opened", async ({ payload }) => createGithubItem(payload));
webhooks.on("pull_request.review_requested", async ({ payload }) => {
  metrics.increment("octokit.pull_request.review_requested");

  const { pull_request, repository } = payload;
  const project = getProject({ repoUrl: repository.html_url });
  if (!project) return;

  for (let i = 0; i < pull_request.requested_reviewers.length; i++) {
    const user =
      MAINTAINERS.find(
        (maintainer) => maintainer.github === (pull_request.requested_reviewers[i] as any)?.login
      )?.slack ||
      (
        await prisma.user.findFirst({
          where: { githubUsername: (pull_request.requested_reviewers[i] as any)?.login },
        })
      )?.slackId;

    if (user) {
      await slack.client.chat.postMessage({
        channel: user,
        text: `You have been requested to review a pull request on ${project} by ${pull_request.user.login}.\n${pull_request.html_url}`,
      });
    } else {
      console.log("No user found for", pull_request.requested_reviewers[i]);
    }
  }
});

export const createGithubItem = async (payload) => {
  metrics.increment("octokit.create.item");
  console.log("🧶🧶 Running github webhook 🧶🧶");
  const { issue, pull_request, repository } = payload;
  const item = issue || pull_request;

  const project = getProject({ repoUrl: repository.html_url });
  if (!project) return;

  const dbRepo = await prisma.repository.upsert({
    where: { url: repository.html_url },
    create: { name: repository.name, owner: repository.owner.login, url: repository.html_url },
    update: { name: repository.name, owner: repository.owner.login },
  });

  const maintainers = getMaintainers({ repoUrl: repository.html_url });
  if (maintainers.find((maintainer) => maintainer?.github === item.user.login)) return;

  // find user by login
  const user = await prisma.user.findFirst({
    where: { githubUsername: item.user.login },
  });
  let author: User;

  if (!user)
    author = await prisma.user.create({
      data: { githubUsername: item.user.login },
    });
  else author = user;

  const actionItem = await prisma.actionItem.findFirst({
    where: { githubItem: { nodeId: item.node_id } },
  });

  const githubItem = await prisma.githubItem.upsert({
    where: { nodeId: item.node_id },
    create: {
      author: { connect: { id: author.id } },
      repository: { connect: { id: dbRepo.id } },
      nodeId: item.node_id,
      title: item.title,
      body: item.body || "",
      number: item.number,
      state: "open",
      type: item.node_id.startsWith("I_") ? GithubItemType.issue : GithubItemType.pull_request,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      actionItem: { create: { status: "open", totalReplies: 0 } },
      labelsOnItems: {
        create: item.labels?.map(({ name }) => ({
          label: { connectOrCreate: { where: { name }, create: { name } } },
        })),
      },
    },
    update: {
      state: "open",
      title: item.title,
      body: item.body || "",
      updatedAt: item.updated_at,
      labelsOnItems: {
        deleteMany: {},
        create: item.labels?.map(({ name }) => ({
          label: { connectOrCreate: { where: { name }, create: { name } } },
        })),
      },
      actionItem: {
        update: {
          status: actionItem?.resolvedAt ? "closed" : "open",
          participants: { deleteMany: {} },
        },
      },
    },
    include: { actionItem: true },
  });

  indexDocument(githubItem.actionItem!.id);
  console.log("🧶🧶 GitHub webhook syncing done 🧶🧶");
};

export const getOctokitToken = async (owner: string, repo: string) => {
  metrics.increment("octokit.get.token");

  if (!owner || !repo) return "";

  const auth = createAppAuth({
    appId,
    privateKey,
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  });

  const appAuth = await auth({ type: "app" });
  const octokit = new Octokit();

  const installation = await octokit.rest.apps.getRepoInstallation({
    owner,
    repo,
    headers: { authorization: "Bearer " + appAuth.token },
  });

  const res = await octokit.rest.apps.createInstallationAccessToken({
    installation_id: installation.data.id,
    headers: { authorization: "Bearer " + appAuth.token },
  });

  return res.data.token;
};

export const getDisplayName = async ({
  owner,
  name,
  slackId,
  github,
}: {
  owner: string;
  name: string;
  slackId?: string;
  github?: string;
}) => {
  metrics.increment("octokit.get.display_name");

  const token = await getOctokitToken(owner, name);
  const octokit = new Octokit({ auth: "Bearer " + token });
  const maintainer = MAINTAINERS.find(
    (maintainer) => maintainer.github === github || maintainer.slack === slackId
  );

  const displayName = maintainer
    ? maintainer.id
    : slackId
    ? await slack.client.users
        .info({ user: slackId })
        .then(
          (res) => res.user?.name || res.user?.real_name || res.user?.profile?.display_name || ""
        )
    : await octokit.rest.users
        .getByUsername({ username: github ?? "" })
        .then((res) => res.data.name || "");

  return displayName;
};

export const listGithubItems = async (owner: string, name: string) => {
  metrics.increment("octokit.get.list_items");
  const query = `
    query ($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        issues(first: 100, states: OPEN) {
          nodes {
            id
            number
            title
            bodyText
            createdAt
            updatedAt
            author {
              login
            }
            labels(first:10) {
              nodes {
                name
              }
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
            bodyText
            createdAt
            updatedAt
            author {
              login
            }
            labels(first:10) {
              nodes {
                name
              }
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
  return items;
};

export const getGithubItem = async (owner: string, name: string, id: string) => {
  metrics.increment("octokit.get.item");

  const query = `
    query ($id: ID!) {
      node(id: $id) {
        ... on Issue {
          id
          number
          title
          bodyText
          closedAt
          assignees(first: 100) {
            nodes {
              login
            }
          }
          labels(first:10) {
            nodes {
              name
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
          id
          number
          title
          bodyText
          closedAt
          assignees(first: 100) {
            nodes {
              login
            }
          }
          labels(first:10) {
            nodes {
              name
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

  const token = await getOctokitToken(owner, name);
  const octokit = new Octokit({ auth: "Bearer " + token });
  const res = (await octokit.graphql(query, { id })) as SingleIssueOrPullData;
  return res;
};
