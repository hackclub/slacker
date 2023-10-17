import { type Config } from "drizzle-kit";

export default {
  out: "./migrations",
  schema: "./lib/schema.ts",
  breakpoints: true,
} satisfies Config;
