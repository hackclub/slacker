import { expressConnectMiddleware } from "@connectrpc/connect-express";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import { config } from "dotenv";
import express from "express";
import routes from "./connect";

config();

const app = express();
app.use(expressConnectMiddleware({ routes }));

app.get("/", async (_, res) => {
  res.redirect(
    "https://slack.com/oauth/v2/authorize?client_id=2210535565.6032352837652&user_scope=users:read,users:read.email,channels:history&redirect_uri=https://slacker.underpass.clb.li/trpc/main.loginWithSlack"
  );
});

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET as string,
  app: app,
});

export const slack = new App({
  logLevel: LogLevel.DEBUG,
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

(async () => {
  try {
    await slack.start(3000);
    console.log(`Server running on http://localhost:3000`);
  } catch (err) {
    console.error(err);
  }
})();
