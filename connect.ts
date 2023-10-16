import { ConnectRouter } from "@connectrpc/connect";
import { ElizaService } from "./gen/eliza_connect";
import { readFileSync } from "fs";
import yaml from "js-yaml";
import { Config } from "./lib/types";

export default (router: ConnectRouter) =>
  router.service(ElizaService, {
    async syncSlackMessages(req, ctx) {
      const input = req.project;
      const config = yaml.load(readFileSync(`./config/${input}.yaml`, "utf-8")) as Config;

      // 1. iterate over all slack channels
      // 2. get all recent messages (100-200)
      // 3. remove messages that are by THIS user
      // 4. separate out the messages not responded yet in a separate array
      // 5. calculate the average response time for each message (when the message was replied to, in threads)
      // 6. make sure to exclude all the bot messages when calculating the average response time

      const channels = config.result.data["slack-channels"];

      return { response: "ok" };
    },
  });
