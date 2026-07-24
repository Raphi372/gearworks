-- Flag.replay: the captured recent-input window for admin review ([SEC-3]).
-- Additive (new nullable-with-default column).
ALTER TABLE "Flag" ADD COLUMN "replay" JSONB NOT NULL DEFAULT '[]';
