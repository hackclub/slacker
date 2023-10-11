import { z } from "zod";
import { publicProcedure, router } from "../trpc";

type User = {
  id: string;
  name: string;
  bio?: string;
};

const users: Record<string, User> = {};

export const mainRouter = router({
  getUserById: publicProcedure.input(z.string()).query((opts) => {
    return users[opts.input];
  }),
  createUser: publicProcedure
    .input(
      z.object({
        name: z.string().min(3),
        bio: z.string().max(142).optional(),
      })
    )
    .mutation((opts) => {
      const id = Date.now().toString();
      const user: User = { id, ...opts.input };
      users[user.id] = user;
      return user;
    }),
});

export type AppRouter = typeof mainRouter;
