-- Factory leaderboard projection: one row per world (unique worldId), and an
-- index on money for cheap top-N leaderboard queries. The Factory table has
-- never been written to, so making worldId unique is safe.
DROP INDEX IF EXISTS "Factory_worldId_idx";
CREATE UNIQUE INDEX "Factory_worldId_key" ON "Factory"("worldId");
CREATE INDEX "Factory_money_idx" ON "Factory"("money");
