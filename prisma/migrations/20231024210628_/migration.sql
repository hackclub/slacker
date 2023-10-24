/*
  Warnings:

  - You are about to drop the column `databaseId` on the `GithubItem` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[nodeId]` on the table `GithubItem` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[url]` on the table `Repository` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `url` to the `Repository` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "GithubItem" DROP COLUMN "databaseId";

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "url" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "GithubItem_nodeId_key" ON "GithubItem"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_url_key" ON "Repository"("url");
