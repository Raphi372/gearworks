-- Progression union source: the set of researched tech ids per world, so an
-- account's unlockedTech can be aggregated across its worlds without
-- deserializing snapshots. Defaults to an empty array for existing rows.
ALTER TABLE "Factory" ADD COLUMN "techIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
