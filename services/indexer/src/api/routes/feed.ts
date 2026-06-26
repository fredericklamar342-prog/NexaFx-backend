import { Router, Request, Response } from "express";
import { Pool as PgPool } from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FeedPost {
  id: string;
  author: string;
  content: string;
  tip_total: string;
  like_count: string;
  created_at: string; // ISO-8601
  /** Keyset cursor — opaque to the client, pass as ?after= on next page. */
  cursor: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse and validate offset/keyset pagination params. */
function parseFeedPagination(query: Record<string, unknown>):
  | {
      limit: number;
      after?: string;
    }
  | { error: string; code: string } {
  const rawLimit = query.limit !== undefined ? Number(query.limit) : DEFAULT_LIMIT;

  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    return { error: "limit must be a positive integer", code: "INVALID_QUERY" };
  }
  if (rawLimit > MAX_LIMIT) {
    return {
      error: `limit cannot exceed ${MAX_LIMIT}`,
      code: "LIMIT_EXCEEDED",
    };
  }

  const after =
    typeof query.after === "string" && query.after.trim() !== "" ? query.after.trim() : undefined;

  return { limit: rawLimit, after };
}

/**
 * Encode a keyset cursor from a (created_at ISO string, id bigint string).
 * Format: base64url("<iso_timestamp>|<post_id>")
 */
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString("base64url");
}

/**
 * Decode a keyset cursor back to (created_at, id).
 * Returns null if the cursor is malformed.
 */
function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const pipeIndex = decoded.lastIndexOf("|");
    if (pipeIndex === -1) return null;
    const createdAt = decoded.slice(0, pipeIndex);
    const id = decoded.slice(pipeIndex + 1);
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** Map a raw DB row to a FeedPost. */
function rowToFeedPost(row: Record<string, unknown>): FeedPost {
  const id = String(row.id);
  const createdAt = row.created_at as string;
  return {
    id,
    author: row.author as string,
    content: (row.content as string) ?? "",
    tip_total: String(row.tip_total),
    like_count: String(row.like_count),
    created_at: createdAt,
    cursor: encodeCursor(createdAt, id),
  };
}

// ── Router factory ────────────────────────────────────────────────────────────

export function createFeedRouter(pg: PgPool): Router {
  const router = Router();

  // ── GET /feed/following ──────────────────────────────────────────────────────

  /**
   * GET /feed/following?viewer=<address>&limit=<n>&after=<cursor>
   *
   * Returns the chronological post feed for all accounts followed by `viewer`,
   * using keyset pagination to prevent duplicates under concurrent inserts.
   *
   * Keyset: (created_at DESC, id DESC) — the cursor encodes both values so the
   * query can efficiently seek past the last seen post.
   */
  router.get("/following", async (req: Request, res: Response): Promise<void> => {
    const viewer = typeof req.query.viewer === "string" ? req.query.viewer.trim() : "";

    if (!viewer) {
      res.status(400).json({ error: "viewer address is required", code: "INVALID_QUERY" });
      return;
    }

    const pagination = parseFeedPagination(req.query as Record<string, unknown>);
    if ("error" in pagination) {
      res.status(400).json(pagination);
      return;
    }

    const { limit, after } = pagination;

    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;

    if (after) {
      const decoded = decodeCursor(after);
      if (!decoded) {
        res.status(400).json({ error: "invalid cursor", code: "INVALID_CURSOR" });
        return;
      }
      cursorCreatedAt = decoded.createdAt;
      cursorId = decoded.id;
    }

    // Keyset query: select posts authored by accounts `viewer` follows,
    // ordered by (created_at DESC, id DESC), with an optional keyset seek.
    const result = await pg.query<Record<string, unknown>>(
      `
        SELECT
          p.id::text          AS id,
          p.author,
          p.content,
          p.tip_total::text   AS tip_total,
          p.like_count::text  AS like_count,
          p.created_at        AS created_at
        FROM posts p
        WHERE p.deleted_at IS NULL
          AND p.author IN (
            SELECT followee
            FROM   follows
            WHERE  follower = $1
          )
          AND (
            $2::timestamptz IS NULL
            OR (p.created_at, p.id::text) < ($2::timestamptz, $3::text)
          )
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $4
        `,
      [viewer, cursorCreatedAt, cursorId, limit + 1]
    );

    const rows = result.rows as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const posts = page.map(rowToFeedPost);
    const nextCursor = hasMore && page.length > 0 ? posts[posts.length - 1]!.cursor : undefined;

    res.json({
      posts,
      has_more: hasMore,
      next_cursor: nextCursor ?? null,
      limit,
    });
  });

  // ── GET /feed/explore ────────────────────────────────────────────────────────

  /**
   * GET /feed/explore?limit=<n>&after=<cursor>
   *
   * Returns a scored explore feed: posts ranked by a composite hot-score
   *   score = (like_count * 2 + tip_total_normalised) / age_hours^1.5
   *
   * Uses keyset pagination on (score DESC, id DESC).  The score is computed
   * at query time from a materialized-style expression so we stay consistent.
   *
   * A background refresh (every 60 s) is wired in the createFeedRefreshJob
   * export at the bottom of this file for use in index.ts.
   */
  router.get("/explore", async (req: Request, res: Response): Promise<void> => {
    const pagination = parseFeedPagination(req.query as Record<string, unknown>);
    if ("error" in pagination) {
      res.status(400).json(pagination);
      return;
    }

    const { limit, after } = pagination;

    let cursorScore: number | null = null;
    let cursorId: string | null = null;

    if (after) {
      const decoded = decodeCursor(after);
      if (!decoded) {
        res.status(400).json({ error: "invalid cursor", code: "INVALID_CURSOR" });
        return;
      }
      // For the explore feed the cursor encodes: "<score_as_float>|<id>"
      cursorScore = parseFloat(decoded.createdAt); // reuse first slot for score
      cursorId = decoded.id;
      if (!isFinite(cursorScore)) {
        res.status(400).json({ error: "invalid cursor", code: "INVALID_CURSOR" });
        return;
      }
    }

    // Hot-score formula (inline SQL):
    //   age_hours = GREATEST(EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600, 0.1)
    //   score     = (p.like_count * 2 + p.tip_total / 1e7) / POW(age_hours, 1.5)
    //
    // We fetch limit+1 to detect hasMore without an extra COUNT query.
    const result = await pg.query<Record<string, unknown>>(
      `
        SELECT
          p.id::text         AS id,
          p.author,
          p.content,
          p.tip_total::text  AS tip_total,
          p.like_count::text AS like_count,
          p.created_at       AS created_at,
          (
            (p.like_count * 2 + p.tip_total::numeric / 1e7)
            / POW(
                GREATEST(EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600.0, 0.1),
                1.5
              )
          )                  AS score
        FROM posts p
        WHERE p.deleted_at IS NULL
          AND (
            $1::double precision IS NULL
            OR (
              (
                (p.like_count * 2 + p.tip_total::numeric / 1e7)
                / POW(
                    GREATEST(EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600.0, 0.1),
                    1.5
                  )
              ),
              p.id::text
            ) < ($1::double precision, $2::text)
          )
        ORDER BY score DESC, p.id DESC
        LIMIT $3
        `,
      [cursorScore, cursorId, limit + 1]
    );

    const rows = result.rows as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // For the explore cursor we encode score in place of createdAt slot.
    const posts = page.map((row) => {
      const fp = rowToFeedPost(row);
      // Override the cursor to encode score|id instead of created_at|id
      fp.cursor = encodeCursor(String(row.score ?? 0), fp.id);
      return fp;
    });

    const nextCursor = hasMore && page.length > 0 ? posts[posts.length - 1]!.cursor : undefined;

    res.json({
      posts,
      has_more: hasMore,
      next_cursor: nextCursor ?? null,
      limit,
    });
  });

  return router;
}

// ── Background refresh job ────────────────────────────────────────────────────

/**
 * Starts a background interval that keeps the explore feed's underlying data
 * fresh by vacuuming expired soft-deleted posts from any view cache and
 * refreshing a `explore_feed_cache` materialised row if one is used.
 *
 * Currently the explore feed is computed on-the-fly (no separate cache table),
 * so this job performs a lightweight ANALYZE on the posts table so Postgres
 * statistics stay current for the hot-score ORDER BY plan.
 *
 * Returns a cleanup function that stops the job.
 */
export function createFeedRefreshJob(
  pg: PgPool,
  intervalMs = 60_000,
  signal?: AbortSignal
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;

  const refresh = (): void => {
    pg.query("ANALYZE posts").catch((err: unknown) =>
      console.error("[feed-refresh] ANALYZE failed:", err)
    );
  };

  // Run once immediately, then on schedule.
  refresh();
  timer = setInterval(refresh, intervalMs);

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  signal?.addEventListener("abort", stop);
  return stop;
}
