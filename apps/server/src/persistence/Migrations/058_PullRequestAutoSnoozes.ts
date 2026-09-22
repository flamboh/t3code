import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_auto_snoozes (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      watch_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      host TEXT,
      url TEXT,
      state TEXT NOT NULL,
      observation_json TEXT NOT NULL,
      snoozed_at TEXT,
      next_check_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
