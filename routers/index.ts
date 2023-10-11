import { router } from "../trpc";
import { mainRouter } from "./main";

export const appRouter = router({ main: mainRouter });

export type AppRouter = typeof appRouter;
