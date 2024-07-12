import { Request, Response } from "express";

export const authHandler = async (req: Request, res: Response) => {
  const id = req.query.id;

  if (!id) return res.json({ error: "No user id provided for the slack user" });

  const url = `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&redirect_uri=${process.env.DEPLOY_URL}/auth/callback?id=${id}`;
  res.redirect(url);
};
