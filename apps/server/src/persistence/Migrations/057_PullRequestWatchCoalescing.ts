import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// A non-null deadline means the matched payload is still collecting nearby
// PR updates. Null keeps the pre-coalescing rows as frozen delivery recovery.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE pull_request_watches
    ADD COLUMN match_deadline_at TEXT
  `;
});
