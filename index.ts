import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import fastify from "fastify";
import { createContext } from "./context";
import { appRouter } from "./routers";

const server = fastify({ maxParamLength: 5000 });

server.register(fastifyTRPCPlugin, {
  prefix: "/trpc",
  trpcOptions: { router: appRouter, createContext },
});

(async () => {
  try {
    await server.listen({ port: 5000 }).then((address) => {
      console.log(`Server running on ${address}`);
    });
  } catch (err) {
    server.log.error(err);
  }
})();
