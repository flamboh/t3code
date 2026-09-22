import { assert, it } from "@effect/vitest";
import {
  type GreenPullRequestSnooze,
  INDEFINITE_SNOOZE_UNTIL,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  ProjectId,
  PullRequestWatchId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layer as autoSnoozeLayer, PullRequestAutoSnoozeService } from "./PullRequestAutoSnooze.ts";
import {
  PullRequestWatchObserver,
  type PullRequestWatchObservation,
} from "./PullRequestWatchObservation.ts";

const projectId = ProjectId.make("project:test");
const threadId = ThreadId.make("thread:test");
const watchId = PullRequestWatchId.make("watch:test");
const START = "2026-01-01T00:00:00.000Z";

const green: PullRequestWatchObservation = {
  headSha: "abc123",
  state: "open",
  checks: [{ id: "ci", name: "ci", state: "passed", url: "https://ci/1" }],
  feedback: [],
  feedbackComplete: true,
};

type Shell = Pick<
  OrchestrationV2ThreadShell,
  | "archivedAt"
  | "pinnedAt"
  | "pendingRuntimeRequest"
  | "snoozedUntil"
  | "snoozedAt"
  | "latestRunCompletedAt"
  | "activityRunStatus"
  | "status"
>;

const utc = (iso: string) => DateTime.makeUnsafe(iso);

const makeHarness = (preference: GreenPullRequestSnooze | null) =>
  Effect.gen(function* () {
    const shell = yield* Ref.make<Shell>({
      archivedAt: null,
      pinnedAt: null,
      pendingRuntimeRequest: null,
      snoozedUntil: null,
      snoozedAt: null,
      latestRunCompletedAt: null,
      activityRunStatus: "running",
      status: "running",
    });
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
    const reads = yield* Ref.make<ReadonlyArray<PullRequestWatchObservation>>([]);
    const readCount = yield* Ref.make(0);
    const threads = Layer.mock(ThreadManagementService)({
      getThreadShell: () =>
        Ref.get(shell).pipe(Effect.map((value) => value as unknown as OrchestrationV2ThreadShell)),
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(commands, (all) => [...all, command]);
          const now = yield* DateTime.now;
          if (command.type === "thread.snooze") {
            yield* Ref.update(shell, (value) => ({
              ...value,
              snoozedUntil: utc(command.snoozedUntil),
              snoozedAt: now,
            }));
          }
          if (command.type === "thread.unsnooze") {
            yield* Ref.update(shell, (value) => ({
              ...value,
              snoozedUntil: null,
              snoozedAt: null,
            }));
          }
          return { sequence: 1, storedEvents: [] };
        }),
    });
    const observer = Layer.mock(PullRequestWatchObserver)({
      read: () =>
        Effect.gen(function* () {
          yield* Ref.update(readCount, (n) => n + 1);
          const [next, ...rest] = yield* Ref.get(reads);
          if (next === undefined) return yield* Effect.die(new Error("no scripted read"));
          if (rest.length > 0) yield* Ref.set(reads, rest);
          return next;
        }),
    });
    const service = yield* PullRequestAutoSnoozeService.pipe(
      Effect.provide(
        autoSnoozeLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              threads,
              observer,
              ServerSettings.layerTest({ snoozeGreenPullRequests: preference }),
            ),
          ),
        ),
      ),
    );
    const armGreen = service.arm({
      projectId,
      threadId,
      watchId,
      repository: "owner/repo",
      number: 12,
      host: "github.com",
      observation: green,
      deliveredAt: START,
    });
    const finishReply = (status: Shell["status"] = "idle") =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* Ref.update(shell, (value) => ({
          ...value,
          activityRunStatus: null,
          status,
          latestRunCompletedAt: now,
        }));
      });
    const snoozeCommands = Ref.get(commands).pipe(
      Effect.map((all) => all.filter((command) => command.type === "thread.snooze")),
    );
    const wakeCommands = Ref.get(commands).pipe(
      Effect.map((all) => all.filter((command) => command.type === "thread.unsnooze")),
    );
    const rowCount = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM pull_request_auto_snoozes`;
      return rows[0]?.n ?? 0;
    });
    return {
      service,
      shell,
      reads,
      readCount,
      armGreen,
      finishReply,
      snoozeCommands,
      wakeCommands,
      rowCount,
    };
  });

const autoSnoozeTest = <A, E>(name: string, body: () => Effect.Effect<A, E, SqlClient.SqlClient>) =>
  it.effect(name, () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(START));
      yield* body();
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

const snoozed = (preference: GreenPullRequestSnooze = "indefinitely") =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(preference);
    yield* harness.armGreen;
    yield* TestClock.adjust("30 seconds");
    yield* harness.finishReply();
    yield* harness.service.sweep();
    assert.equal((yield* harness.snoozeCommands).length, 1);
    return harness;
  });

autoSnoozeTest("does nothing while the setting is off", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(null);
    yield* harness.armGreen;
    yield* harness.finishReply();
    yield* harness.service.sweep();
    assert.equal(yield* harness.rowCount, 0);
    assert.equal((yield* harness.snoozeCommands).length, 0);
  }),
);

autoSnoozeTest("waits for the agent's reply, then snoozes indefinitely", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness("indefinitely");
    yield* harness.armGreen;
    yield* harness.service.sweep();
    assert.equal((yield* harness.snoozeCommands).length, 0);
    yield* TestClock.adjust("30 seconds");
    yield* harness.finishReply();
    yield* harness.service.sweep();
    const [command] = yield* harness.snoozeCommands;
    assert.equal(
      command?.type === "thread.snooze" ? command.snoozedUntil : null,
      INDEFINITE_SNOOZE_UNTIL,
    );
  }),
);

autoSnoozeTest("snoozes for the configured number of hours", () =>
  Effect.gen(function* () {
    const harness = yield* snoozed(3);
    const [command] = yield* harness.snoozeCommands;
    assert.equal(
      command?.type === "thread.snooze" ? command.snoozedUntil : null,
      "2026-01-01T03:00:30.000Z",
    );
  }),
);

autoSnoozeTest("a failed reply leaves the thread awake", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness("indefinitely");
    yield* harness.armGreen;
    yield* TestClock.adjust("30 seconds");
    yield* harness.finishReply("failed");
    yield* harness.service.sweep();
    assert.equal((yield* harness.snoozeCommands).length, 0);
    assert.equal(yield* harness.rowCount, 0);
  }),
);

autoSnoozeTest("a pinned thread is never auto-snoozed", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness("indefinitely");
    yield* harness.armGreen;
    yield* Ref.update(harness.shell, (value) => ({ ...value, pinnedAt: utc(START) }));
    yield* harness.finishReply();
    yield* harness.service.sweep();
    assert.equal((yield* harness.snoozeCommands).length, 0);
    assert.equal(yield* harness.rowCount, 0);
  }),
);

autoSnoozeTest("checks the pull request on the slow cadence and wakes on a new failure", () =>
  Effect.gen(function* () {
    const harness = yield* snoozed();
    yield* Ref.set(harness.reads, [
      green,
      { ...green, checks: [{ id: "ci", name: "ci", state: "failed", url: "https://ci/2" }] },
    ]);
    yield* TestClock.adjust("14 minutes");
    yield* harness.service.sweep();
    assert.equal(yield* Ref.get(harness.readCount), 0);
    yield* TestClock.adjust("1 minute");
    yield* harness.service.sweep();
    assert.equal(yield* Ref.get(harness.readCount), 1);
    assert.equal((yield* harness.wakeCommands).length, 0);
    yield* TestClock.adjust("15 minutes");
    yield* harness.service.sweep();
    const [wake] = yield* harness.wakeCommands;
    assert.equal(wake?.type === "thread.unsnooze" ? wake.reason : null, "pull-request");
    assert.equal(yield* harness.rowCount, 0);
  }),
);

autoSnoozeTest("new review feedback wakes the thread", () =>
  Effect.gen(function* () {
    const harness = yield* snoozed();
    yield* Ref.set(harness.reads, [
      {
        ...green,
        feedback: [{ id: "r1", updatedAt: START, body: "please rename", url: null }],
      },
    ]);
    yield* TestClock.adjust("15 minutes");
    yield* harness.service.sweep();
    assert.equal((yield* harness.wakeCommands).length, 1);
  }),
);

autoSnoozeTest("a merge ends the watch without waking the thread", () =>
  Effect.gen(function* () {
    const harness = yield* snoozed();
    yield* Ref.set(harness.reads, [{ ...green, state: "merged" }]);
    yield* TestClock.adjust("15 minutes");
    yield* harness.service.sweep();
    assert.equal((yield* harness.wakeCommands).length, 0);
    assert.equal(yield* harness.rowCount, 0);
    assert.isNotNull((yield* Ref.get(harness.shell)).snoozedUntil);
  }),
);

autoSnoozeTest("a thread woken some other way stops being watched without a read", () =>
  Effect.gen(function* () {
    const harness = yield* snoozed();
    yield* Ref.update(harness.shell, (value) => ({
      ...value,
      snoozedUntil: null,
      snoozedAt: null,
    }));
    yield* TestClock.adjust("15 minutes");
    yield* harness.service.sweep();
    assert.equal(yield* Ref.get(harness.readCount), 0);
    assert.equal(yield* harness.rowCount, 0);
  }),
);

autoSnoozeTest("a timed snooze that expires stops being watched", () =>
  Effect.gen(function* () {
    const harness = yield* snoozed(1);
    yield* TestClock.adjust("61 minutes");
    yield* harness.service.sweep();
    assert.equal(yield* Ref.get(harness.readCount), 0);
    assert.equal(yield* harness.rowCount, 0);
  }),
);
