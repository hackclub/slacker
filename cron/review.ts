import { Octokit } from "octokit";
import { slack } from "..";
import { MAINTAINERS, getProjectDetails } from "../lib/utils";

// Runs every Friday at 12:00 PM
export const reviewCron = async () => {
  console.log("⏳⏳ Running review requests report cron job ⏳⏳");
  try {
    for await (const maintainer of MAINTAINERS) {
      let text = `:wave: Hey ${maintainer.id}!`;

      const { repositories } = await getProjectDetails("all", maintainer.slack, maintainer.github);

      if (repositories.length === 0) continue;

      const octokit = new Octokit();
      const q = `${repositories
        .map((r) => "repo:" + r.uri.split("/")[3] + "/" + r.uri.split("/")[4])
        .join(" ")} state:open type:pr review-requested:${
        maintainer.github
      } user-review-requested:${maintainer.github}`;

      const { data } = await octokit.rest.search.issuesAndPullRequests({ q });
      if (data.total_count === 0) continue;

      text += `\nYou have ${data.total_count} pull requests that need your review:\n`;
      data.items.forEach((item) => {
        text += `\n• ${item.title} (${item.html_url})`;
      });

      await slack.client.chat.postMessage({ channel: maintainer.slack, text });
    }
  } catch (err) {
    console.log("🚨🚨 Error in review requests report cron job 🚨🚨");
    console.error(err);
  }
};
