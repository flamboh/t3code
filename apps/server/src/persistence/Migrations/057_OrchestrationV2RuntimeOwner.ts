import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The environment whose server last recovered this database. The environment
 * ID lives beside the database, not in it, so a copied database boots under a
 * new ID; startup recovery compares the two before continuing provider work.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_runtime_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      environment_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
