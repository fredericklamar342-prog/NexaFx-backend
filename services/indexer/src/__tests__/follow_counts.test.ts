import { Pool } from "pg";

const testDbUrl = process.env.TEST_DATABASE_URL;

const describeDb = testDbUrl ? describe : describe.skip;

describeDb("follow_counts triggers", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testDbUrl });

    // Ensure follows table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS follows (
        follower TEXT NOT NULL,
        followee TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (follower, followee)
      );
    `);

    // Ensure follow_counts table and triggers exist (simulating migration 009)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS follow_counts (
          address         TEXT    NOT NULL PRIMARY KEY,
          follower_count  BIGINT  NOT NULL DEFAULT 0 CHECK (follower_count  >= 0),
          following_count BIGINT  NOT NULL DEFAULT 0 CHECK (following_count >= 0),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE OR REPLACE FUNCTION trg_follows_insert()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
          INSERT INTO follow_counts (address, follower_count, following_count)
              VALUES (NEW.followee, 1, 0)
          ON CONFLICT (address) DO UPDATE
              SET follower_count = follow_counts.follower_count + 1,
                  updated_at     = NOW();

          INSERT INTO follow_counts (address, follower_count, following_count)
              VALUES (NEW.follower, 0, 1)
          ON CONFLICT (address) DO UPDATE
              SET following_count = follow_counts.following_count + 1,
                  updated_at      = NOW();

          RETURN NEW;
      END;
      $$;

      CREATE OR REPLACE FUNCTION trg_follows_delete()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
          UPDATE follow_counts
             SET follower_count = GREATEST(0, follower_count - 1),
                 updated_at     = NOW()
           WHERE address = OLD.followee;

          UPDATE follow_counts
             SET following_count = GREATEST(0, following_count - 1),
                 updated_at      = NOW()
           WHERE address = OLD.follower;

          RETURN OLD;
      END;
      $$;

      DROP TRIGGER IF EXISTS follows_after_insert ON follows;
      CREATE TRIGGER follows_after_insert
          AFTER INSERT ON follows
          FOR EACH ROW EXECUTE FUNCTION trg_follows_insert();

      DROP TRIGGER IF EXISTS follows_after_delete ON follows;
      CREATE TRIGGER follows_after_delete
          AFTER DELETE ON follows
          FOR EACH ROW EXECUTE FUNCTION trg_follows_delete();
    `);
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS follows, follow_counts CASCADE;");
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE follows, follow_counts CASCADE;");
  });

  it("increments follower and following counts on insert", async () => {
    await pool.query("INSERT INTO follows (follower, followee) VALUES ('userA', 'userB')");

    const resA = await pool.query(
      "SELECT following_count, follower_count FROM follow_counts WHERE address = 'userA'"
    );
    expect(resA.rows[0].following_count).toBe("1");
    expect(resA.rows[0].follower_count).toBe("0");

    const resB = await pool.query(
      "SELECT following_count, follower_count FROM follow_counts WHERE address = 'userB'"
    );
    expect(resB.rows[0].following_count).toBe("0");
    expect(resB.rows[0].follower_count).toBe("1");
  });

  it("decrements counts on delete", async () => {
    await pool.query("INSERT INTO follows (follower, followee) VALUES ('userA', 'userB')");
    await pool.query("INSERT INTO follows (follower, followee) VALUES ('userA', 'userC')");

    let resA = await pool.query(
      "SELECT following_count FROM follow_counts WHERE address = 'userA'"
    );
    expect(resA.rows[0].following_count).toBe("2");

    await pool.query("DELETE FROM follows WHERE follower = 'userA' AND followee = 'userB'");

    resA = await pool.query("SELECT following_count FROM follow_counts WHERE address = 'userA'");
    expect(resA.rows[0].following_count).toBe("1");

    const resB = await pool.query(
      "SELECT follower_count FROM follow_counts WHERE address = 'userB'"
    );
    expect(resB.rows[0].follower_count).toBe("0");
  });

  it("handles complex graph correctly", async () => {
    // A follows B and C
    // B follows A
    // C follows A
    await pool.query(
      "INSERT INTO follows (follower, followee) VALUES ('A', 'B'), ('A', 'C'), ('B', 'A'), ('C', 'A')"
    );

    const resA = await pool.query(
      "SELECT following_count, follower_count FROM follow_counts WHERE address = 'A'"
    );
    expect(resA.rows[0].following_count).toBe("2");
    expect(resA.rows[0].follower_count).toBe("2");

    const resB = await pool.query(
      "SELECT following_count, follower_count FROM follow_counts WHERE address = 'B'"
    );
    expect(resB.rows[0].following_count).toBe("1");
    expect(resB.rows[0].follower_count).toBe("1");
  });
});
