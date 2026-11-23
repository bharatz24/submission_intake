-- The reviewer's form behind an IMS 2 intake (routes/ims2Queue.ts), so a fix after a rejection or a refusal starts
-- from what was sent. Its own migration: 008 had already run on databases without this column.
ALTER TABLE ims2_intake_queue ADD COLUMN IF NOT EXISTS form jsonb;
