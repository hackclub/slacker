import { expressConnectMiddleware } from "@connectrpc/connect-express";
import { createNodeMiddleware } from "@octokit/webhooks";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import minMax from "dayjs/plugin/minMax";
import relativeTime from "dayjs/plugin/relativeTime";
import { config } from "dotenv";
import express from "express";
import cron from "node-cron";
import responseTime from "response-time";
import {
  assign,
  followUp,
  gimmeAgain,
  markIrrelevant,
  notes,
  resolve,
  snooze,
  unsnooze,
} from "./actions";
import { authHandler } from "./api/auth";
import { callbackHandler } from "./api/auth/callback";
import { indexHandler } from "./api/index";
import { followUpCron } from "./cron/followUp";
import { reportCron } from "./cron/report";
import { reviewCron } from "./cron/review";
import { unassignCron } from "./cron/unassign";
import { unsnoozeCron } from "./cron/unsnooze";
import { messageEvent } from "./events/message";
import { handleSlackerCommand } from "./lib/commands";
import metrics from "./lib/metrics";
import { webhooks } from "./lib/octokit";
import { checkDuplicateResources, joinChannels } from "./lib/utils";
import { irrelevantSubmit, notesSubmit, resolveSubmit, snoozeSubmit } from "./views/";
import routes from "./routes";

dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);
dayjs.extend(minMax);
config();

const app = express();
app.use(expressConnectMiddleware({ routes }));
app.use(createNodeMiddleware(webhooks));
app.use(
  responseTime((req, res, time) => {
    const stat = (req.method + "/" + req.url?.split("/")[1])
      .toLowerCase()
      .replace(/[:.]/g, "")
      .replace(/\//g, "_");
    const httpCode = res.statusCode;
    const timingStatKey = `http.response.${stat}`;
    const codeStatKey = `http.response.${stat}.${httpCode}`;
    metrics.timing(timingStatKey, time);
    metrics.increment(codeStatKey, 1);
  })
);

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET as string,
  app,
});

export const slack = new App({
  logLevel: LogLevel.INFO,
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

app.get("/", indexHandler);
app.get("/auth", authHandler);
app.get("/auth/callback", callbackHandler);

slack.command("/slacker", handleSlackerCommand);
slack.command("/slacker-dev", handleSlackerCommand);
slack.action("resolve", resolve);
slack.action("snooze", snooze);
slack.action("followup", followUp);
slack.action("unsnooze", unsnooze);
slack.action("irrelevant", markIrrelevant);
slack.action("assigned", assign);
slack.action("notes", notes);
slack.action("gimme_again", gimmeAgain);
slack.view("snooze_submit", snoozeSubmit);
slack.view("notes_submit", notesSubmit);
slack.view("irrelevant_submit", irrelevantSubmit);
slack.view("resolve_submit", resolveSubmit);
slack.event("message", messageEvent);

cron.schedule("0 * * * *", unassignCron);
cron.schedule("0 * * * *", unsnoozeCron);
cron.schedule("0 * * * *", followUpCron);
cron.schedule("0 12 * * FRI", reportCron, { timezone: "America/New_York" });
cron.schedule("0 12 * * FRI", reviewCron, { timezone: "America/New_York" });

(async () => {
  try {
    metrics.increment("server.start.increment", 1);
    await checkDuplicateResources();
    await slack.start(process.env.PORT || 5001);
    await joinChannels();
    // await backFill();
    console.log(`Server running on http://localhost:5001`);
  } catch (err) {
    metrics.increment("server.start.error", 1);
    console.error(err);
  }
})();
