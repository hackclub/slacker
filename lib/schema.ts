import { sql, relations } from "drizzle-orm";
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const slackMessages = sqliteTable("slack_messages", {
  id: integer("id").primaryKey(),
  author: text("user").notNull(),
  channel: text("channel").notNull(),
  text: text("text").notNull(),
  ts: text("ts").notNull(),
  participants: text("participants", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(strftime('%s', 'now'))`),
});

export const githubItems = sqliteTable("github_items", {
  id: integer("id").primaryKey(),
  type: text("type", { enum: ["pull_request", "issue"] }).notNull(),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  author: text("user").notNull(),
  state: text("state", { enum: ["open", "closed"] }).notNull(),
  participants: blob("participants", { mode: "json" }).$type<string[]>().notNull(),
  comments: blob("comments", { mode: "json" })
    .$type<{ author: string; createdAt: Date; body: string }[]>()
    .notNull(),
  nodeId: text("node_id").notNull(),
  databaseId: integer("database_id").notNull(),
  repository: text("repository").notNull(),
  owner: text("owner").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(strftime('%s', 'now'))`),
});

export const slackActionRelations = relations(slackMessages, ({ one }) => ({
  actionItems: one(actionItems, {
    fields: [slackMessages.id],
    references: [actionItems.slackId],
  }),
}));

export const githubActionRelations = relations(githubItems, ({ one }) => ({
  actionItems: one(actionItems, {
    fields: [githubItems.id],
    references: [actionItems.githubId],
  }),
}));

export const actionItems = sqliteTable("action_items", {
  id: integer("id").primaryKey(),
  slackId: integer("slack_id").references(() => slackMessages.id),
  githubId: integer("github_id").references(() => githubItems.id),
  resolvedBy: text("resolved_by"),
  status: text("status", { enum: ["open", "ongoing", "resolved", "irrelevant"] }).notNull(),
  project: text("project").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(strftime('%s', 'now'))`),
});
