-- Migration 009: follow_counts materialization
-- Description:
--   Adds a denormalized follow_counts table that stores pre-aggregated
--   follower_count / following_count per address.  Postgres triggers on
--   the follows table keep these counters in sync automatically, so every
--   INSERT / DELETE on follows atomically adjusts the two affected rows.
--
-- Trigger logic:
--   On INSERT follows(follower, followee):
--     followee.follower_count  += 1
--     follower.following_count += 1
--   On DELETE follows(follower, followee):
--     followee.follower_count  = max(0, follower_count - 1)
--     follower.following_count = max(0, following_count - 1)
--
-- The table is populated from the current follows data in the same
-- migration so the counts are immediately consistent after applying it.

-- 1. Create the materialized count table
CREATE TABLE IF NOT EXISTS follow_counts (
    address         TEXT    NOT NULL PRIMARY KEY,
    follower_count  BIGINT  NOT NULL DEFAULT 0 CHECK (follower_count  >= 0),
    following_count BIGINT  NOT NULL DEFAULT 0 CHECK (following_count >= 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Back-fill from existing follows rows
INSERT INTO follow_counts (address, follower_count, following_count)
SELECT
    addr,
    COALESCE(fc.cnt, 0) AS follower_count,
    COALESCE(gc.cnt, 0) AS following_count
FROM (
    SELECT DISTINCT followee AS addr FROM follows
    UNION
    SELECT DISTINCT follower AS addr FROM follows
) AS all_addrs
LEFT JOIN (
    SELECT followee AS addr, COUNT(*) AS cnt FROM follows GROUP BY followee
) AS fc USING (addr)
LEFT JOIN (
    SELECT follower AS addr, COUNT(*) AS cnt FROM follows GROUP BY follower
) AS gc USING (addr)
ON CONFLICT (address) DO UPDATE
    SET follower_count  = EXCLUDED.follower_count,
        following_count = EXCLUDED.following_count,
        updated_at      = NOW();

-- 3. Trigger function: fires after each INSERT on follows
CREATE OR REPLACE FUNCTION trg_follows_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- Increment followee's follower_count
    INSERT INTO follow_counts (address, follower_count, following_count)
        VALUES (NEW.followee, 1, 0)
    ON CONFLICT (address) DO UPDATE
        SET follower_count = follow_counts.follower_count + 1,
            updated_at     = NOW();

    -- Increment follower's following_count
    INSERT INTO follow_counts (address, follower_count, following_count)
        VALUES (NEW.follower, 0, 1)
    ON CONFLICT (address) DO UPDATE
        SET following_count = follow_counts.following_count + 1,
            updated_at      = NOW();

    RETURN NEW;
END;
$$;

-- 4. Trigger function: fires after each DELETE on follows
CREATE OR REPLACE FUNCTION trg_follows_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- Decrement followee's follower_count (floor at 0)
    UPDATE follow_counts
       SET follower_count = GREATEST(0, follower_count - 1),
           updated_at     = NOW()
     WHERE address = OLD.followee;

    -- Decrement follower's following_count (floor at 0)
    UPDATE follow_counts
       SET following_count = GREATEST(0, following_count - 1),
           updated_at      = NOW()
     WHERE address = OLD.follower;

    RETURN OLD;
END;
$$;

-- 5. Attach triggers to the follows table
DROP TRIGGER IF EXISTS follows_after_insert ON follows;
CREATE TRIGGER follows_after_insert
    AFTER INSERT ON follows
    FOR EACH ROW EXECUTE FUNCTION trg_follows_insert();

DROP TRIGGER IF EXISTS follows_after_delete ON follows;
CREATE TRIGGER follows_after_delete
    AFTER DELETE ON follows
    FOR EACH ROW EXECUTE FUNCTION trg_follows_delete();

-- 6. Index to support fast follow-count lookups by address
CREATE INDEX IF NOT EXISTS idx_follow_counts_follower_count
    ON follow_counts (follower_count DESC);
