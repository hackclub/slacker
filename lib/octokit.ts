import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { GithubData, SingleIssueOrPullData } from "./types";

const appId = process.env.GITHUB_APP_ID || "";
const base64 = process.env.GITHUB_PRIVATE_KEY || "";
const privateKey = Buffer.from(base64, "base64").toString("utf-8");

export const getOctokitToken = async (owner: string, repo: string) => {
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

export const listGithubItems = async (owner: string, name: string) => {
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
  const query = `
    query ($id: ID!) {
      node(id: $id) {
        ... on Issue {
          id
          number
          title
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
