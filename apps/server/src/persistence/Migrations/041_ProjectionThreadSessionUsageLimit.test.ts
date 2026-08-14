import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionThreadSessionUsageLimit", (it) => {
  it.effect("adds a nullable usage limit column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      const usageLimit = columns.find((column) => column.name === "usage_limit");

      assert.equal(usageLimit?.name, "usage_limit");
      assert.equal(usageLimit?.notnull, 0);
    }),
  );
});
