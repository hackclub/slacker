import { Octokit } from "octokit";
import { getOctokitToken } from "./octokit";
import { GithubData, SingleIssueOrPullData } from "./types";

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
  return items;
};

export const getGithubItem = async (owner: string, name: string, id: string) => {
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

  const token = await getOctokitToken(owner, name);
  const octokit = new Octokit({ auth: "Bearer " + token });
  const res = (await octokit.graphql(query, { id })) as SingleIssueOrPullData;
  return res;
};
