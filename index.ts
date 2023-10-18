import { expressConnectMiddleware } from "@connectrpc/connect-express";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import { config } from "dotenv";
import express from "express";
import routes from "./routes";

config();

const app = express();
app.use(expressConnectMiddleware({ routes }));

app.get("/", async (_, res) => {
  res.send("Hello World!");
});

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET as string,
  app,
});

export const slack = new App({
  logLevel: LogLevel.DEBUG,
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

(async () => {
  try {
    await slack.start(5000);
    console.log(`Server running on http://localhost:5000`);
  } catch (err) {
    console.error(err);
  }
})();
