import { inferAsyncReturnType } from "@trpc/server";
import { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import { getIronSession } from "iron-session";
import { sessionOptions } from "./lib/session";

export async function createContext({ req, res }: CreateFastifyContextOptions) {
  const session = await getIronSession(req.raw, res.raw, sessionOptions);
  return { req, res, session };
}

export type Context = inferAsyncReturnType<typeof createContext>;
