import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Durable one-shot pull request watches. A plain service table like
// scheduled_tasks: watch lifecycle is per-thread key/value state driven by a
// poll loop, not thread history, so it stays out of the v2 event log. Only
// the delivered notification itself is event sourced (message.dispatch).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_watches (
      watch_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      host TEXT,
      url TEXT,
      events_json TEXT NOT NULL,
      status TEXT NOT NULL,
      last_observation_json TEXT,
      -- Immutable once written: the frozen match/close payload a delivery
      -- (including post-restart recovery) dispatches without a fresh host
      -- read. Cleared only when the watch stops being deliverable.
      matched_json TEXT,
      last_error TEXT,
      last_polled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `;

  // Closed watches stay pollable until their close notification gets its
  // durable dispatch receipt (delivered_at), so a failed close delivery is
  // retried rather than dropped.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pull_request_watches_poll
    ON pull_request_watches(status, last_polled_at)
    WHERE status IN ('pending', 'matched', 'closed')
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pull_request_watches_thread
    ON pull_request_watches(thread_id, updated_at)
  `;
});
