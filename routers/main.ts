import { app } from "..";
import { publicProcedure, router } from "../trpc";

export const mainRouter = router({
  loginWithSlack: publicProcedure.query(async ({ ctx }) => {
    const params = ctx.req.query as { code: string; state: string };

    const response = await app.client.oauth.v2.access({
      code: params.code,
      client_id: process.env.SLACK_CLIENT_ID as string,
      client_secret: process.env.SLACK_CLIENT_SECRET as string,
      redirect_uri: "https://slacker.underpass.clb.li/trpc/main.loginWithSlack",
    });

    const user = {
      id: response.authed_user?.id,
      token: response.authed_user?.access_token,
    };

    if (!user.id || !user.token) throw new Error("Something weird happened");

    ctx.session.user = user;
    await ctx.session.save();

    return "ok";
  }),

  me: publicProcedure.query(async ({ ctx }) => {
    if (ctx.session.user) {
      return { ...ctx.session.user, isLoggedIn: true };
    } else {
      return { isLoggedIn: false, id: null, token: "" };
    }
  }),
});

export type AppRouter = typeof mainRouter;
