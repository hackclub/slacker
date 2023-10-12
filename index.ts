import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { createContext } from "./context";
import { appRouter } from "./routers/app";
import { App, FileInstallationStore, LogLevel } from "@slack/bolt";
import { FileStateStore } from "@slack/oauth";
import { FastifyReceiver } from "@seratch_/bolt-fastify";
import { config } from "dotenv";

config();
const server = Fastify({ maxParamLength: 5000 });

server.get("/", async (_, res) => {
  res.redirect(
    "https://slack.com/oauth/v2/authorize?client_id=2210535565.6032352837652&user_scope=users:read,users:read.email,channels:history&redirect_uri=https://slacker.underpass.clb.li/trpc/main.loginWithSlack"
  );
});

const receiver = new FastifyReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET as string,
  clientId: process.env.SLACK_CLIENT_ID as string,
  clientSecret: process.env.SLACK_CLIENT_SECRET as string,
  scopes: ["commands", "chat:write", "app_mentions:read"],
  installationStore: new FileInstallationStore(),
  installerOptions: {
    directInstall: true,
    stateStore: new FileStateStore({}),
  }, // @ts-ignore
  fastify: server,
});

export const app = new App({ logLevel: LogLevel.DEBUG, receiver });

server.register(fastifyTRPCPlugin, {
  prefix: "/trpc",
  trpcOptions: { router: appRouter, createContext },
});

(async () => {
  try {
    await app.start(5000);
    console.log(`Server running on http://localhost:5000`);
  } catch (err) {
    server.log.error(err);
  }
})();
