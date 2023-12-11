// Analyze texts here:
import { ActionStatus } from "@prisma/client";
import prisma from "./lib/db";

async function analyze() {
  const items = await prisma.actionItem.findMany({
    select: {
      githubItem: { select: { body: true, title: true } },
      slackMessage: { select: { text: true } },
      status: true,
      flag: true,
    },
    where: { status: ActionStatus.closed },
  });

  const resolved = {
    count: 0,
    avgCharacterCount: 0,
    avgWords: 0,
    avgQuestionMarks: 0,
  };

  const irrelevant = {
    count: 0,
    avgCharacterCount: 0,
    avgWords: 0,
    avgQuestionMarks: 0,
  };

  for (const item of items) {
    const text = item.slackMessage?.text || item.githubItem?.title || item.githubItem?.body || "";
    const characterCount = text.length;
    const words = text.split(" ").length;
    const questionMarks = text.split("?").length - 1;

    if (item.flag === "irrelevant") {
      irrelevant.count++;
      irrelevant.avgCharacterCount += characterCount;
      irrelevant.avgWords += words;
      irrelevant.avgQuestionMarks += questionMarks;
    }

    if (item.flag !== "irrelevant" && item.status === ActionStatus.closed) {
      resolved.count++;
      resolved.avgCharacterCount += characterCount;
      resolved.avgWords += words;
      resolved.avgQuestionMarks += questionMarks;
    }
  }

  resolved.avgCharacterCount = resolved.avgCharacterCount / resolved.count;
  resolved.avgWords = resolved.avgWords / resolved.count;
  resolved.avgQuestionMarks = resolved.avgQuestionMarks / resolved.count;

  irrelevant.avgCharacterCount = irrelevant.avgCharacterCount / irrelevant.count;
  irrelevant.avgWords = irrelevant.avgWords / irrelevant.count;
  irrelevant.avgQuestionMarks = irrelevant.avgQuestionMarks / irrelevant.count;

  console.log("Here are the results of the analysis: ");
  console.log("Resolved: ", JSON.stringify(resolved, null, 2));
  console.log("Irrelevant: ", JSON.stringify(irrelevant, null, 2));
}

export default analyze;
