import { createOAuthUserAuth } from "@octokit/auth-app";
import { Request, Response } from "express";
import { Octokit } from "octokit";
import { MAINTAINERS } from "../../lib/utils";
import { slack } from "../..";
import prisma from "../../lib/db";

export const callbackHandler = async (req: Request, res: Response) => {
  const { code, id, error, error_description } = req.query;

  if (error && error_description) return res.json({ error, error_description });
  if (!code) return res.json({ error: "No code provided" });
  if (!id) return res.json({ error: "No slackId provided" });

  const auth = createOAuthUserAuth({
    clientId: process.env.GITHUB_CLIENT_ID as string,
    clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
    code: code as string,
    scopes: ["email"],
  });

  const { token } = await auth();
  const octokit = new Octokit({ auth: token });
  const user = await octokit.rest.users.getAuthenticated();
  const maintainer = MAINTAINERS.find((m) => m.slack === id);

  if (maintainer && user.data.login !== maintainer.github)
    return res.json({
      error: `We see that you're trying to authenticate as ${user.data.login}, but you're registered as ${maintainer.github} in the config. Please authenticate as ${maintainer.github} instead.`,
    });

  let email = user.data.email;

  if (!email) {
    const { user } = await slack.client.users.info({ user: id as string });
    email = user?.profile?.email || "";

    if (!email) return res.json({ error: "No email found for this user" });
  }

  // find many users with either the same email / username / slackId
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { email },
        { email: user.data.login },
        { githubUsername: user.data.login },
        { slackId: id.toString().toUpperCase() },
      ],
    },
  });

  if (users.length > 0) {
    // all these users need to be merged into one
    // save them into one user, connect all the relations to that one user and delete the rest.
    const userId = users[0].id;

    await prisma.slackMessage.updateMany({
      where: { authorId: { in: users.map((u) => u.id) } },
      data: { authorId: userId },
    });

    await prisma.githubItem.updateMany({
      where: { authorId: { in: users.map((u) => u.id) } },
      data: { authorId: userId },
    });

    await prisma.participant.updateMany({
      where: { userId: { in: users.map((u) => u.id) } },
      data: { userId: userId },
    });

    await prisma.actionItem.updateMany({
      where: { snoozedById: { in: users.map((u) => u.id) } },
      data: { snoozedById: userId },
    });

    await prisma.actionItem.updateMany({
      where: { assigneeId: { in: users.map((u) => u.id) } },
      data: { assigneeId: userId },
    });

    await prisma.user.deleteMany({
      where: { id: { in: users.map((u) => u.id).filter((i) => i !== userId) } },
    });

    // update the user
    await prisma.user.update({
      where: { id: userId },
      data: {
        email,
        githubUsername: user.data.login,
        githubToken: token,
        slackId: id.toString().toUpperCase(),
      },
    });
  } else {
    // create a new user
    await prisma.user.create({
      data: {
        email,
        githubUsername: user.data.login,
        githubToken: token,
        slackId: id.toString().toUpperCase(),
      },
    });
  }

  return res.json({ message: "OAuth successful, hacker! Go ahead and start using slacker!" });
};
