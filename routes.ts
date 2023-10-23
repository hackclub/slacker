import { ConnectRouter } from "@connectrpc/connect";
import { readFileSync } from "fs";
import yaml from "js-yaml";
import { ElizaService } from "./gen/eliza_connect";
import app from "./lib/octokit";
import { Config } from "./lib/types";

// 1. no need to account backlog for slack messages. use webhooks.
// 2. use sync func here: account for backlog for github issues and open prs - store timestamp of last synced
// 5. snoozing functionality and snooze count, snoozed until - only through admins

export default (router: ConnectRouter) =>
  router.service(ElizaService, {
    async syncGithubItems(req, ctx) {
      try {
        const input = req.project;
        const { repos } = yaml.load(readFileSync(`./config/${input}.yaml`, "utf-8")) as Config;

        for (const repo of repos) {
          const owner = repo.uri.split("/")[-2];
          const name = repo.uri.split("/")[-1];

          const issues = await app.octokit.rest.issues.listForRepo({
            owner: owner,
            repo: name,
            state: "open",
          });

          const prs = await app.octokit.rest.pulls.list({
            owner: owner,
            repo: name,
            state: "open",
          });

          const items = [...issues.data, ...prs.data];

          for (const item of items) {
            // create a db item for each issue and pr
            // if action item already exists, update it
            // ...
          }
        }

        return { response: "ok" };
      } catch (err) {
        return { response: err.message };
      }
    },
  });
