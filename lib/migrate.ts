import { migrate } from "drizzle-orm/libsql/migrator";
import db from "./db";

async function runMigrate() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not defined");
  }

  console.log("Running migrations...");

  const start = Date.now();
  await migrate(db, { migrationsFolder: "./migrations" });
  const end = Date.now();

  console.log(`✅ Migrations completed in ${end - start}ms`);

  process.exit(0);
}

runMigrate().catch((err) => {
  console.error("❌ Migration failed");
  console.error(err);
  process.exit(1);
});
