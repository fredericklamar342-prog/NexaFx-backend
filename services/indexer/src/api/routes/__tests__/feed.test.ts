import { Pool } from "pg";
import { createFeedRouter } from "../feed";
import express from "express";
import request from "supertest";
const testDbUrl = process.env.TEST_DATABASE_URL;

const describeDb = testDbUrl ? describe : describe.skip;

describeDb("Feed API", () => {
  let pool: Pool;
  let app: express.Express;
  beforeAll(async () => {
    pool = new Pool({ connectionString: testDbUrl });
    app = express();
    app.use(express.json());
    app.use("/api/feed", createFeedRouter(pool));

    // Setup schema
    await pool.query(`
      CREATE TABLE IF NOT EXISTS follows (
        follower TEXT NOT NULL,
        followee TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (follower, followee)
      );
      CREATE TABLE IF NOT EXISTS posts (
        id BIGINT PRIMARY KEY,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        tip_total BIGINT NOT NULL DEFAULT 0,
        like_count BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        deleted_at TIMESTAMPTZ
      );
    `);
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS follows, posts CASCADE;");
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE follows, posts CASCADE;");
  });

  const insertPost = async (id: number, author: string, createdAt: Date, likes = 0, tips = 0) => {
    await pool.query(
      `INSERT INTO posts (id, author, content, like_count, tip_total, created_at)
       VALUES ($1, $2, 'content', $3, $4, $5)`,
      [id, author, likes, tips, createdAt]
    );
  };

  const insertFollow = async (follower: string, followee: string) => {
    await pool.query(
      "INSERT INTO follows (follower, followee, created_at) VALUES ($1, $2, NOW())",
      [follower, followee]
    );
  };

  describe("GET /feed/following", () => {
    it("returns chronological posts from followed accounts", async () => {
      const viewer = "viewer_addr";
      await insertFollow(viewer, "friend_1");
      await insertFollow(viewer, "friend_2");

      const now = new Date();
      await insertPost(1, "friend_1", new Date(now.getTime() - 1000));
      await insertPost(2, "friend_2", new Date(now.getTime() - 500));
      await insertPost(3, "stranger", new Date(now.getTime() - 100)); // Not followed
      await insertPost(4, "friend_1", new Date(now.getTime()));

      const res = await request(app).get(`/api/feed/following?viewer=${viewer}`);
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.posts).toHaveLength(3);
      expect(body.posts[0].id).toBe("4");
      expect(body.posts[1].id).toBe("2");
      expect(body.posts[2].id).toBe("1");
    });

    it("respects keyset pagination to avoid duplicates", async () => {
      const viewer = "viewer_addr";
      await insertFollow(viewer, "friend");

      const now = new Date();
      for (let i = 1; i <= 5; i++) {
        await insertPost(i, "friend", new Date(now.getTime() - (10 - i) * 1000));
      }

      // Fetch page 1, limit 3
      const page1 = await request(app).get(`/api/feed/following?viewer=${viewer}&limit=3`);
      expect(page1.status).toBe(200);
      const page1Body = page1.body as any;
      expect(page1Body.posts).toHaveLength(3);
      expect(page1Body.posts[0].id).toBe("5");
      expect(page1Body.posts[1].id).toBe("4");
      expect(page1Body.posts[2].id).toBe("3");
      expect(page1Body.has_more).toBe(true);

      const cursor = page1Body.next_cursor;

      // Simulate a concurrent insert of a newer post (id: 6) that would normally shift offsets
      await insertPost(6, "friend", new Date());

      // Fetch page 2 using cursor
      const page2 = await request(app).get(
        `/api/feed/following?viewer=${viewer}&limit=3&after=${cursor}`
      );
      expect(page2.status).toBe(200);
      const page2Body = page2.body as any;
      expect(page2Body.posts).toHaveLength(2); // IDs 2 and 1
      expect(page2Body.posts[0].id).toBe("2");
      expect(page2Body.posts[1].id).toBe("1");
      expect(page2Body.has_more).toBe(false);
    });
  });

  describe("GET /feed/explore", () => {
    it("returns posts sorted by hot-score", async () => {
      const now = new Date();

      // Post 1: old, no likes
      await insertPost(1, "author1", new Date(now.getTime() - 24 * 3600 * 1000), 0, 0);

      // Post 2: new, some likes
      await insertPost(2, "author2", new Date(now.getTime() - 3600 * 1000), 10, 0);

      // Post 3: very new, many likes + tips
      await insertPost(3, "author3", new Date(now.getTime() - 600 * 1000), 50, 100_000_000);

      const res = await request(app).get("/api/feed/explore");
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.posts).toHaveLength(3);

      // Should be sorted 3, 2, 1
      expect(body.posts[0].id).toBe("3");
      expect(body.posts[1].id).toBe("2");
      expect(body.posts[2].id).toBe("1");
    });
  });
});
