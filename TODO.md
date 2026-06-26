# TODO — Linkora-social indexer Phase 1-3

## Step 1 — Postgres DB implementation + follow_counts materialization

- [x] Inspect current DB expectations vs migrations (posts/follows/tips/likes/pools)
- [x] Install deps + run existing indexer test suite (all 57 handler tests passing)
- [x] Create `services/indexer/src/postgres-db.ts` implementing `Database`

- [x] Update migrations to add `follow_counts` table
- [x] Add triggers to keep `follow_counts` consistent on follows insert/delete

## Step 2 — Wire streaming dispatcher

- [x] Update `services/indexer/src/index.ts` to dispatch events by `event.topic[0]`
- [x] Map follow/unfollow and post/like/tip topics to existing handlers
- [x] Ensure idempotency and transaction boundaries as needed

## Step 3 — Social API endpoints

- [x] Add `/api/social/followers/:address` and `/api/social/following/:address` routes
- [x] Implement offset/limit pagination backed by materialized follows/follow_counts

## Step 4 — Feed endpoints

- [x] Add `/api/feed/following` using keyset pagination
- [x] Add `/api/feed/explore` score computation backing + keyset pagination
- [x] Implement background job refresh every 60 seconds

## Step 5 — Tests + OpenAPI

- [x] Add tests for follow graph + counts atomically updated
- [x] Add tests for following feed correctness
- [x] Add tests for explore scoring order
- [x] Add tests for keyset pagination no duplicates under concurrent inserts
- [x] Update `services/indexer/openapi.yaml` and relevant API docs

## Step 6 — Verify

- [ ] Run indexer test suite
- [ ] Run integration/e2e tests if available
