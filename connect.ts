import { ConnectRouter } from "@connectrpc/connect";
import { ElizaService } from "./gen/eliza_connect";
import { readFileSync, writeFileSync } from "fs";
import yaml from "js-yaml";
import { Config } from "./lib/types";
import { slack } from ".";
import { ConversationsHistoryResponse } from "@slack/web-api";

export default (router: ConnectRouter) =>
  router.service(ElizaService, {
    async syncSlackMessages(req, ctx) {
      try {
        // const input = req.project;
        // const config = yaml.load(readFileSync(`./config/${input}.yaml`, "utf-8")) as Config;
        // const channels = config["slack-channels"];

        // for (let i = 0; i < channels.length; i++) {
        //   const channel = channels[i];

        //   await slack.client.conversations.join({ channel: channel.id });
        //   const messages = await slack.client.conversations.history({
        //     channel: channel.id,
        //     limit: 500,
        //   });
        // }

        // testing with two files right now:
        const sprigJson = JSON.parse(
          readFileSync(`sprig.json`, "utf-8")
        ) as ConversationsHistoryResponse;

        const sprigPlatformJson = JSON.parse(
          readFileSync(`sprig-platform.json`, "utf-8")
        ) as ConversationsHistoryResponse;

        for (let i = 0; i < sprigJson.messages!.length; i++) {
          const message = sprigJson.messages![i];

          if (message.bot_id || message.app_id) continue;
          if (message.subtype) continue;

          console.log(message.text);
        }

        return { response: "ok" };
      } catch (err) {
        console.error(err);
        return { response: "An error occurred: " + err.message };
      }
    },
  });
