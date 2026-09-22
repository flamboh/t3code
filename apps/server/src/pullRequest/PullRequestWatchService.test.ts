import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ThreadProjection,
  type ThreadPullRequestLink,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type PullRequestWatchEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import {
  ThreadManagementDurableRunProjectionError,
  ThreadManagementProjectionLoadError,
  ThreadManagementService,
  type ThreadManagementSendResult,
} from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  PullRequestWatchObserver,
  PullRequestWatchObservationError,
  type PullRequestWatchObservation,
} from "./PullRequestWatchObservation.ts";
import {
  layer as pullRequestWatchServiceLayer,
  PullRequestWatchService,
} from "./PullRequestWatchService.ts";
import {
  type PullRequestAutoSnoozeArmInput,
  PullRequestAutoSnoozeService,
} from "./PullRequestAutoSnooze.ts";

const projectId = ProjectId.make("project:test");
const threadId = ThreadId.make("thread:test");

const observation = (
  overrides?: Partial<PullRequestWatchObservation>,
): PullRequestWatchObservation => ({
  headSha: "abc123def456789",
  state: "open",
  checks: [],
  feedback: [],
  feedbackComplete: true,
  ...overrides,
});

const check = (
  name: string,
  state: PullRequestWatchObservation["checks"][number]["state"],
  url: string | null = null,
) => ({ id: name, name, state, url });

const feedbackItem = (id: string, body: string) => ({
  id,
  updatedAt: "2026-01-01T00:00:00.000Z",
  body,
  url: null,
});

type ConcreteRead =
  | { readonly kind: "observation"; readonly value: PullRequestWatchObservation }
  | {
      readonly kind: "failure";
      readonly reason: "transient" | "not-found" | "unsupported" | "auth" | "rate-limit";
    };

type ScriptedRead =
  | ConcreteRead
  | {
      /** Block the read until the test releases it, proving cancel/read races. */
      readonly kind: "gate";
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
      readonly afterRelease: ConcreteRead;
    };

interface SentMessage {
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
  readonly notification: unknown;
}

interface Harness {
  readonly reads: Ref.Ref<number>;
  readonly sent: Ref.Ref<ReadonlyArray<SentMessage>>;
  readonly linkCommands: Ref.Ref<ReadonlyArray<unknown>>;
  readonly links: Ref.Ref<ReadonlyArray<ThreadPullRequestLink>>;
  readonly threadFailures: Ref.Ref<number>;
  readonly threadArchived: Ref.Ref<boolean>;
  /** EventSinkV2.write inputs recorded from roster syncs. */
  readonly rosterWrites: Ref.Ref<ReadonlyArray<unknown>>;
  /** Active provider thread id seen by the thread projection mock (null = none). */
  readonly activeProviderThreadId: Ref.Ref<string | null>;
  /** Seeded non-watch roster entries by provider thread id. */
  readonly providerRosters: Ref.Ref<
    Record<string, ReadonlyArray<OrchestrationV2PendingBackgroundTask>>
  >;
  readonly armed: Ref.Ref<ReadonlyArray<PullRequestAutoSnoozeArmInput>>;
  readonly service: PullRequestWatchService["Service"];
}

/** Scripted observer/thread harness: reads pop from the script (last repeats), sends can fail N times. */
const makeHarness = (
  script: ReadonlyArray<ScriptedRead>,
  sendFailures = 0,
  linkFailures = 0,
): Effect.Effect<Harness, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const reads = yield* Ref.make(0);
    const remaining = yield* Ref.make<ReadonlyArray<ScriptedRead>>(script);
    const last = yield* Ref.make<ScriptedRead | null>(null);
    const sent = yield* Ref.make<ReadonlyArray<SentMessage>>([]);
    const linkCommands = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const links = yield* Ref.make<ReadonlyArray<ThreadPullRequestLink>>([]);
    const failuresLeft = yield* Ref.make(sendFailures);
    const linkFailuresLeft = yield* Ref.make(linkFailures);
    const threadFailures = yield* Ref.make(0);
    const threadArchived = yield* Ref.make(false);
    const rosterWrites = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const activeProviderThreadId = yield* Ref.make<string | null>(null);
    const providerRosters = yield* Ref.make<
      Record<string, ReadonlyArray<OrchestrationV2PendingBackgroundTask>>
    >({});
    const armed = yield* Ref.make<ReadonlyArray<PullRequestAutoSnoozeArmInput>>([]);
    const autoSnoozeMock = Layer.mock(PullRequestAutoSnoozeService)({
      arm: (input) => Ref.update(armed, (all) => [...all, input]),
    });
    const observerMock = Layer.mock(PullRequestWatchObserver)({
      read: () =>
        Effect.gen(function* () {
          yield* Ref.update(reads, (n) => n + 1);
          const rest = yield* Ref.get(remaining);
          const head = rest[0] ?? (yield* Ref.get(last));
          if (head === null) return yield* Effect.die(new Error("observer script exhausted"));
          const resolved: ConcreteRead =
            head.kind === "gate"
              ? yield* Deferred.succeed(head.entered, undefined).pipe(
                  Effect.andThen(Deferred.await(head.release)),
                  Effect.as(head.afterRelease),
                )
              : head;
          if (rest.length > 0) {
            yield* Ref.update(remaining, (all) => all.slice(1));
            yield* Ref.set(last, resolved);
          }
          if (resolved.kind === "failure") {
            return yield* new PullRequestWatchObservationError({
              reason: resolved.reason,
              detail: `scripted ${resolved.reason}`,
            });
          }
          return resolved.value;
        }),
    });
    const threadMock = Layer.mock(ThreadManagementService)({
      getProjectThread: () =>
        Effect.gen(function* () {
          if (yield* Ref.get(threadArchived)) {
            // Cast: the service only null-checks these fields.
            return {
              thread: { archivedAt: "archived", deletedAt: null },
            } as unknown as OrchestrationV2ThreadProjection;
          }
          const shouldFail = yield* Ref.modify(threadFailures, (n) =>
            n > 0 ? ([true, n - 1] as const) : ([false, n] as const),
          );
          if (shouldFail) {
            return yield* new ThreadManagementProjectionLoadError({
              projectId,
              threadId,
              cause: new Error("sqlite blip"),
            });
          }
          const activeId = yield* Ref.get(activeProviderThreadId);
          const rosters = yield* Ref.get(providerRosters);
          return {
            thread: {
              archivedAt: null,
              deletedAt: null,
              pullRequests: yield* Ref.get(links),
              activeProviderThreadId: activeId,
            },
            providerThreads:
              activeId === null
                ? []
                : [
                    {
                      id: activeId,
                      driver: ProviderDriverKind.make("claude"),
                      providerInstanceId: ProviderInstanceId.make("claude"),
                      status: "idle",
                      pendingBackgroundTasks: rosters[activeId] ?? [],
                    },
                  ],
          } as unknown as OrchestrationV2ThreadProjection;
        }),
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(linkCommands, (all) => [...all, command]);
          const shouldFail = yield* Ref.modify(linkFailuresLeft, (n) =>
            n > 0 ? ([true, n - 1] as const) : ([false, n] as const),
          );
          if (shouldFail) {
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: new Error("scripted link failure"),
            });
          }
          if (command.type === "thread.pull-request.link") {
            yield* Ref.update(links, (all) =>
              all.some(
                (link) =>
                  link.host === command.host &&
                  link.repository === command.repository &&
                  link.number === command.number,
              )
                ? all
                : [
                    ...all,
                    {
                      host: command.host,
                      repository: command.repository,
                      number: command.number,
                      url: command.url,
                      source: command.source,
                      linkedAt: "2026-01-01T00:00:00.000Z",
                      snapshot: null,
                      stack: null,
                    },
                  ],
            );
          }
          return { sequence: 1, storedEvents: [] };
        }),
      sendToThread: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(sent, (all) => [
            ...all,
            {
              commandId: input.commandId,
              messageId: input.messageId,
              text: input.text,
              notification: input.notification,
            },
          ]);
          const shouldFail = yield* Ref.modify(failuresLeft, (n) =>
            n > 0 ? ([true, n - 1] as const) : ([false, n] as const),
          );
          if (shouldFail) {
            // A neutral dispatch failure (not archived/deleted): the watch
            // must stay matched with its frozen payload for a later retry.
            return yield* new ThreadManagementDurableRunProjectionError({
              threadId: input.threadId,
              messageId: input.messageId,
            });
          }
          return {} as unknown as ThreadManagementSendResult;
        }),
    } satisfies Partial<ThreadManagementService["Service"]>);
    const eventSinkMock = Layer.mock(EventSink.EventSinkV2)({
      write: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(rosterWrites, (all) => [...all, input]);
          // Keep the thread projection mock consistent: later syncs read
          // the roster as if the appended events had been projected.
          for (const event of input.events) {
            if (event.type !== "provider-thread.updated") continue;
            const payload = event.payload as {
              readonly id?: unknown;
              readonly pendingBackgroundTasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
            };
            if (typeof payload.id === "string" && Array.isArray(payload.pendingBackgroundTasks)) {
              const tasks = payload.pendingBackgroundTasks;
              yield* Ref.update(providerRosters, (rosters) => ({
                ...rosters,
                [payload.id as string]: tasks,
              }));
            }
          }
          return [] as never;
        }),
    });
    const service = yield* PullRequestWatchService.pipe(
      Effect.provide(
        Layer.provideMerge(
          pullRequestWatchServiceLayer,
          Layer.mergeAll(
            observerMock,
            autoSnoozeMock,
            threadMock,
            eventSinkMock,
            IdAllocator.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );
    return {
      reads,
      sent,
      linkCommands,
      links,
      threadFailures,
      threadArchived,
      rosterWrites,
      activeProviderThreadId,
      providerRosters,
      armed,
      service,
    };
  });

const register = (
  service: PullRequestWatchService["Service"],
  input?: {
    readonly events?: ReadonlyArray<PullRequestWatchEvent>;
    readonly clientRequestId?: string;
  },
) =>
  service.watch({
    projectId,
    threadId,
    repository: "owner/repo",
    number: 12,
    ...(input?.events === undefined ? {} : { events: input.events }),
    ...(input?.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
  });

const watchTest = <A, E>(name: string, body: () => Effect.Effect<A, E, SqlClient.SqlClient>) =>
  it.effect(name, () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00.000Z"));
      yield* body();
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

const obs = (overrides?: Partial<PullRequestWatchObservation>): ConcreteRead => ({
  kind: "observation",
  value: observation(overrides),
});

const statusOf = (service: PullRequestWatchService["Service"], watchId?: string) =>
  Effect.gen(function* () {
    const { watches } = yield* service.list({ threadId, projectId });
    return watchId === undefined
      ? watches[0]?.status
      : watches.find((watch) => watch.watchId === watchId)?.status;
  });

const tick = (
  service: PullRequestWatchService["Service"],
  duration: Parameters<typeof TestClock.adjust>[0],
) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(duration);
    yield* service.pollDueWatches();
  });

const sentTexts = (harness: Pick<Harness, "sent">) =>
  Effect.map(Ref.get(harness.sent), (messages) => messages.map((message) => message.text));

watchTest("registers a pending watch with its baseline and lists it", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness([obs()]);
    const status = yield* register(service, { clientRequestId: "reg-1" });
    assert.equal(status.status, "pending");
    assert.equal(status.watchId, "pull-request-watch:thread:test:reg-1");
    const { watches } = yield* service.list({ threadId, projectId });
    assert.equal(watches.length, 1);
    assert.equal(watches[0]?.watchId, status.watchId);
  }),
);

watchTest("registration links the PR once and preserves it on re-registration", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([obs()]);
    yield* register(harness.service, { clientRequestId: "link-once" });
    yield* register(harness.service, { clientRequestId: "link-once" });
    const commands = yield* Ref.get(harness.linkCommands);
    const links = yield* Ref.get(harness.links);
    assert.equal(commands.length, 1);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.source, "agent");
    assert.equal(links[0]?.host, "github.com");
  }),
);

watchTest("a failed link leaves a repairable watch row for the same idempotency key", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([obs()], 0, 1);
    const first = yield* Effect.result(register(harness.service, { clientRequestId: "repair" }));
    assert.isFalse(Result.isSuccess(first));
    const repaired = yield* register(harness.service, { clientRequestId: "repair" });
    assert.equal(repaired.status, "pending");
    assert.equal((yield* Ref.get(harness.links)).length, 1);
    assert.equal((yield* Ref.get(harness.linkCommands)).length, 2);
  }),
);

watchTest("registration preserves existing PR links and their metadata", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([obs()]);
    const existing: ThreadPullRequestLink = {
      host: "github.com",
      repository: "Owner/Repo",
      number: 12,
      url: "https://github.com/Owner/Repo/pull/12",
      source: "manual",
      linkedAt: "2026-01-01T00:00:00.000Z",
      snapshot: null,
      stack: {
        kind: "native",
        id: "stack-1",
        number: 1,
        url: "https://github.com/Owner/Repo/pull/12",
        base: "main",
        layers: [],
      },
    };
    const other = { ...existing, number: 11, url: "https://github.com/Owner/Repo/pull/11" };
    yield* Ref.set(harness.links, [other, existing]);
    const first = yield* register(harness.service);
    yield* harness.service.watch({
      projectId,
      threadId,
      repository: "owner/repo",
      number: 12,
      previousWatchId: first.watchId,
    });
    assert.deepStrictEqual(yield* Ref.get(harness.links), [other, existing]);
    assert.equal((yield* Ref.get(harness.linkCommands)).length, 0);
    yield* harness.service.watch({ projectId, threadId, repository: "owner/repo", number: 13 });
    const links = yield* Ref.get(harness.links);
    assert.deepStrictEqual(links.slice(0, 2), [other, existing]);
    assert.equal(links[2]?.number, 13);
  }),
);

watchTest("watching a dismissed stack PR requests an explicit agent link", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([obs()]);
    yield* Ref.set(harness.links, [
      {
        host: "github.com",
        repository: "owner/repo",
        number: 12,
        url: "https://github.com/owner/repo/pull/12",
        source: "stack-dismissed",
        linkedAt: "2026-01-01T00:00:00.000Z",
        snapshot: null,
        stack: null,
      },
    ]);
    yield* register(harness.service);
    assert.deepInclude((yield* Ref.get(harness.linkCommands))[0], {
      type: "thread.pull-request.link",
      source: "agent",
      number: 12,
    });
  }),
);

watchTest("delivery and cancellation retain links without relinking after a user unlink", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([obs({ checks: [check("ci", "failed")] })]);
    const first = yield* register(harness.service);
    yield* tick(harness.service, "15 seconds");
    assert.equal(yield* statusOf(harness.service), "delivered");
    const retained = yield* Ref.get(harness.links);
    assert.equal(retained.length, 1);
    const rearmed = yield* harness.service.watch({
      projectId,
      threadId,
      repository: "owner/repo",
      number: 12,
      previousWatchId: first.watchId,
    });
    yield* harness.service.cancel({ projectId, threadId, watchId: rearmed.watchId });
    assert.deepStrictEqual(yield* Ref.get(harness.links), retained);
    const waiting = yield* harness.service.watch({
      projectId,
      threadId,
      repository: "owner/repo",
      number: 12,
      previousWatchId: first.watchId,
    });
    yield* Ref.set(harness.links, []);
    yield* tick(harness.service, "61 seconds");
    assert.deepStrictEqual(yield* Ref.get(harness.links), []);
    assert.equal((yield* Ref.get(harness.linkCommands)).length, 1);
    assert.equal(yield* statusOf(harness.service, waiting.watchId), "pending");
  }),
);

watchTest("rejects an unavailable thread before reading the PR or persisting a watch", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([]);
    yield* Ref.set(harness.threadArchived, true);
    assert.isFalse(Result.isSuccess(yield* Effect.result(register(harness.service))));
    assert.equal(yield* Ref.get(harness.reads), 0);
    assert.equal((yield* Ref.get(harness.linkCommands)).length, 0);
    assert.deepStrictEqual((yield* harness.service.list({ threadId, projectId })).watches, []);
  }),
);

watchTest("direct service calls default to all events and preserve explicit filters", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness([obs()]);
    const omitted = yield* service.watch({
      projectId,
      threadId,
      repository: "owner/repo",
      number: 12,
      clientRequestId: "default-events",
    });
    assert.deepStrictEqual(omitted.events, ["check_failed", "checks_finished", "review_feedback"]);
    const filtered = yield* service.watch({
      projectId,
      threadId,
      repository: "owner/repo",
      number: 12,
      events: ["review_feedback"],
      clientRequestId: "filtered-events",
    });
    assert.deepStrictEqual(filtered.events, ["review_feedback"]);
    const empty = yield* Effect.result(
      service.watch({
        projectId,
        threadId,
        repository: "owner/repo",
        number: 12,
        events: [],
        clientRequestId: "empty-events",
      }),
    );
    assert.isFalse(Result.isSuccess(empty));
  }),
);

watchTest("matches an already-red baseline immediately at registration", () =>
  Effect.gen(function* () {
    const { service, sent, reads } = yield* makeHarness([
      obs({ checks: [check("ci", "failed", "https://ci/run/1")] }),
    ]);
    const status = yield* register(service, { clientRequestId: "red" });
    assert.equal(status.status, "matched");
    assert.equal(yield* Ref.get(reads), 1);
    assert.equal((yield* Ref.get(sent)).length, 0);
    // The first match starts a fixed window; the final refresh happens at its
    // deadline and does not dispatch early.
    yield* tick(service, "14 seconds");
    assert.equal((yield* Ref.get(sent)).length, 0);
    yield* tick(service, "1 second");
    const messages = yield* sentTexts({ sent });
    assert.equal(messages.length, 1);
    assert.equal(yield* Ref.get(reads), 2);
    assert.include(messages[0] ?? "", "abc123def456789");
    assert.include(messages[0] ?? "", "check_failed");
    assert.include(messages[0] ?? "", "https://github.com/owner/repo/pull/12");
    // One-shot: a later poll sends nothing more.
    yield* tick(service, "61 seconds");
    assert.equal((yield* Ref.get(sent)).length, 1);
    assert.equal(yield* Ref.get(reads), 2);
  }),
);

watchTest("reports checks_finished with verdict counts, never empty success", () =>
  Effect.gen(function* () {
    const { service, sent } = yield* makeHarness([
      obs({
        checks: [check("a", "passed"), check("b", "failed"), check("c", "skipped")],
      }),
    ]);
    const status = yield* register(service, {
      events: ["checks_finished"],
      clientRequestId: "fin",
    });
    assert.equal(status.status, "matched");
    const text = (yield* sentTexts({ sent }))[0] ?? "";
    assert.equal(text, "");
    yield* tick(service, "16 seconds");
    const delivered = (yield* sentTexts({ sent }))[0] ?? "";
    assert.include(delivered, "Checks finished:");
    assert.include(delivered, "1 passed");
    assert.include(delivered, "1 failed");
    assert.include(delivered, "1 skipped");
    assert.notInclude(delivered, "All ");
  }),
);

watchTest("only an all-green delivery arms the auto-snooze", () =>
  Effect.gen(function* () {
    const { service, armed } = yield* makeHarness([
      obs({ checks: [check("a", "passed"), check("b", "skipped")] }),
    ]);
    yield* register(service, { events: ["checks_finished"], clientRequestId: "green" });
    assert.equal((yield* Ref.get(armed)).length, 0);
    yield* tick(service, "16 seconds");
    const [arm] = yield* Ref.get(armed);
    assert.equal(arm?.threadId, threadId);
    assert.equal(arm?.host, "github.com");
    assert.deepStrictEqual(
      arm?.observation.checks.map((c) => c.state),
      ["passed", "skipped"],
    );
  }),
);

watchTest("a finished rollup with a failure never arms the auto-snooze", () =>
  Effect.gen(function* () {
    const { service, sent, armed } = yield* makeHarness([
      obs({ checks: [check("a", "passed"), check("b", "cancelled")] }),
    ]);
    yield* register(service, { events: ["checks_finished"], clientRequestId: "mixed" });
    yield* tick(service, "16 seconds");
    assert.equal((yield* Ref.get(sent)).length, 1);
    assert.equal((yield* Ref.get(armed)).length, 0);
  }),
);

watchTest("an empty check list never matches checks_finished", () =>
  Effect.gen(function* () {
    const { service, sent } = yield* makeHarness([obs()]);
    const status = yield* register(service, {
      events: ["checks_finished"],
      clientRequestId: "empty",
    });
    assert.equal(status.status, "pending");
    yield* tick(service, "61 seconds");
    assert.equal((yield* Ref.get(sent)).length, 0);
    assert.equal(yield* statusOf(service), "pending");
  }),
);

watchTest("a staggered CI match and review comment share one notification", () =>
  Effect.gen(function* () {
    const { service, sent } = yield* makeHarness([
      obs(),
      obs({ checks: [check("ci", "failed")] }),
      obs({
        checks: [check("ci", "failed")],
        feedback: [feedbackItem("c1", "please fix")],
      }),
    ]);
    const status = yield* register(service, {
      events: ["check_failed", "review_feedback"],
      clientRequestId: "agg",
    });
    assert.equal(status.status, "pending");
    yield* tick(service, "61 seconds");
    assert.equal((yield* Ref.get(sent)).length, 0);
    assert.equal(yield* statusOf(service), "matched");
    // The final read is due 15 seconds from the first match, and includes the
    // comment posted after CI failed.
    yield* tick(service, "14 seconds");
    assert.equal((yield* Ref.get(sent)).length, 0);
    yield* tick(service, "1 second");
    const messages = yield* sentTexts({ sent });
    assert.equal(messages.length, 1);
    const text = messages[0] ?? "";
    assert.include(text, "check_failed+review_feedback");
    assert.include(text, "ci");
    assert.include(text, "please fix");
    assert.equal(yield* statusOf(service), "delivered");
  }),
);

watchTest("the coalescing deadline is fixed and a final read failure still dispatches", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(
      [obs(), obs({ checks: [check("ci", "failed")] }), { kind: "failure", reason: "transient" }],
      1,
    );
    const status = yield* register(harness.service, { clientRequestId: "deadline-failure" });
    assert.equal(status.status, "pending");
    yield* tick(harness.service, "61 seconds");
    const sql = yield* SqlClient.SqlClient;
    const before = yield* sql<{ readonly match_deadline_at: string | null }>`
      SELECT match_deadline_at
      FROM pull_request_watches
      WHERE watch_id = ${status.watchId}
    `;
    assert.isNotNull(before[0]?.match_deadline_at);
    assert.equal((yield* Ref.get(harness.sent)).length, 0);
    yield* tick(harness.service, "10 seconds");
    const during = yield* sql<{ readonly match_deadline_at: string | null }>`
      SELECT match_deadline_at
      FROM pull_request_watches
      WHERE watch_id = ${status.watchId}
    `;
    assert.equal(during[0]?.match_deadline_at, before[0]?.match_deadline_at);
    assert.equal((yield* Ref.get(harness.sent)).length, 0);
    yield* tick(harness.service, "5 seconds");
    assert.equal((yield* Ref.get(harness.sent)).length, 1);
    const current = (yield* harness.service.list({ threadId, projectId })).watches[0];
    assert.equal(current?.status, "matched");
    assert.include(
      (yield* sentTexts(harness))[0] ?? "",
      "Could not refresh nearby pull request updates",
    );
    yield* tick(harness.service, "61 seconds");
    const recovered = (yield* harness.service.list({ threadId, projectId })).watches[0];
    assert.equal(recovered?.status, "delivered");
    assert.include(recovered?.error ?? "", "Could not refresh nearby pull request updates");
    assert.equal((yield* Ref.get(harness.sent)).length, 2);
    assert.include(
      (yield* sentTexts(harness))[1] ?? "",
      "Could not refresh nearby pull request updates",
    );
    assert.equal(yield* Ref.get(harness.reads), 3);
  }),
);

watchTest("a collecting match survives restart before its deadline", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness([obs(), obs({ checks: [check("ci", "failed")] })]);
    const status = yield* register(first.service, { clientRequestId: "restart-window" });
    yield* tick(first.service, "61 seconds");
    assert.equal(yield* statusOf(first.service), "matched");
    const second = yield* makeHarness([
      obs({
        checks: [check("ci", "failed")],
        feedback: [feedbackItem("c1", "after restart")],
      }),
    ]);
    yield* tick(second.service, "16 seconds");
    assert.equal((yield* Ref.get(second.sent)).length, 1);
    assert.include((yield* sentTexts(second))[0] ?? "", "after restart");
    assert.equal((yield* Ref.get(first.sent)).length, 0);
    assert.equal(
      (yield* second.service.list({ threadId, projectId })).watches[0]?.watchId,
      status.watchId,
    );
  }),
);

watchTest("a frozen match survives restart without another host read", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness([obs(), obs({ checks: [check("ci", "failed")] })], 1);
    const status = yield* register(first.service, { clientRequestId: "restart-frozen" });
    assert.equal(status.status, "pending");
    yield* tick(first.service, "61 seconds");
    assert.equal(yield* Ref.get(first.reads), 2);
    assert.equal(yield* statusOf(first.service), "matched");
    // The final refresh freezes the payload, then the first delivery attempt
    // fails. Recovery after the restart below must not read the host again.
    yield* tick(first.service, "16 seconds");
    assert.equal(yield* Ref.get(first.reads), 3);
    assert.equal(yield* statusOf(first.service), "matched");
    const second = yield* makeHarness([]);
    yield* tick(second.service, "61 seconds");
    assert.equal(yield* Ref.get(second.reads), 0);
    assert.equal((yield* Ref.get(second.sent)).length, 1);
    // Idempotent redelivery of the frozen payload: both attempts share the
    // stable command/message ids.
    const attempts = [...(yield* Ref.get(first.sent)), ...(yield* Ref.get(second.sent))];
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.commandId, attempts[1]?.commandId);
    assert.equal(attempts[0]?.messageId, attempts[1]?.messageId);
    assert.equal(yield* statusOf(second.service), "delivered");
  }),
);

watchTest("rearm does not repeat the fired state but fires on new transitions", () =>
  Effect.gen(function* () {
    const failing = (name: string) => observation({ checks: [check(name, "failed")] });
    const { service, sent } = yield* makeHarness([
      obs(),
      { kind: "observation", value: failing("ci") },
    ]);
    const first = yield* register(service, { clientRequestId: "r1" });
    yield* tick(service, "61 seconds");
    assert.equal(yield* statusOf(service), "matched");
    yield* tick(service, "16 seconds");
    assert.equal(yield* statusOf(service), "delivered");
    // Same state through the rearm cursor: no repeat.
    const second = yield* service.watch({
      projectId,
      threadId,
      repository: "owner/repo",
      number: 12,
      events: ["check_failed"],
      previousWatchId: first.watchId,
    });
    assert.equal(second.status, "pending");
    yield* tick(service, "61 seconds");
    assert.equal((yield* Ref.get(sent)).length, 1);
    // A new failure after the cursor fires again.
    yield* tick(service, "61 seconds");
    assert.equal((yield* Ref.get(sent)).length, 1);
  }),
);

watchTest("default-event rearm uses the coalesced cursor without replaying comments", () =>
  Effect.gen(function* () {
    const failing = observation({ checks: [check("ci", "failed")] });
    const firstWithComment = observation({
      checks: [check("ci", "failed")],
      feedback: [feedbackItem("c1", "first comment")],
    });
    const secondWithComment = observation({
      checks: [check("ci", "failed")],
      feedback: [feedbackItem("c1", "first comment"), feedbackItem("c2", "later comment")],
    });
    const harness = yield* makeHarness([
      obs(),
      { kind: "observation", value: failing },
      { kind: "observation", value: firstWithComment },
      { kind: "observation", value: firstWithComment },
      { kind: "observation", value: secondWithComment },
    ]);
    const first = yield* register(harness.service, { clientRequestId: "rearm-default" });
    yield* tick(harness.service, "61 seconds");
    yield* tick(harness.service, "16 seconds");
    assert.equal((yield* Ref.get(harness.sent)).length, 1);
    const rearmed = yield* harness.service.watch({
      projectId,
      threadId,
      repository: "owner/repo",
      number: 12,
      previousWatchId: first.watchId,
    });
    assert.equal(rearmed.status, "pending");
    yield* tick(harness.service, "61 seconds");
    assert.equal((yield* Ref.get(harness.sent)).length, 1);
    yield* tick(harness.service, "61 seconds");
    yield* tick(harness.service, "16 seconds");
    const messages = yield* sentTexts(harness);
    assert.equal(messages.length, 2);
    assert.include(messages[1] ?? "", "later comment");
    assert.notInclude(messages[1] ?? "", "first comment");
  }),
);

watchTest("rearm rejects a different PR or host", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness([obs()]);
    const first = yield* register(service, { clientRequestId: "h1" });
    const otherNumber = yield* Effect.result(
      service.watch({
        projectId,
        threadId,
        repository: "owner/repo",
        number: 13,
        events: ["check_failed"],
        previousWatchId: first.watchId,
      }),
    );
    assert.isFalse(Result.isSuccess(otherNumber));
    const otherHost = yield* Effect.result(
      service.watch({
        projectId,
        threadId,
        repository: "owner/repo",
        number: 12,
        host: "ghe.example.com",
        events: ["check_failed"],
        previousWatchId: first.watchId,
      }),
    );
    assert.isFalse(Result.isSuccess(otherHost));
    // Omitted host canonically equals github.com, so this rearm is accepted.
    const sameHost = yield* service.watch({
      projectId,
      threadId,
      repository: "owner/repo",
      number: 12,
      host: "github.com",
      events: ["check_failed"],
      previousWatchId: first.watchId,
    });
    assert.equal(sameHost.status, "pending");
  }),
);

watchTest("clientRequestId is idempotent and rejects conflicting params", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness([obs()]);
    const first = yield* register(service, { clientRequestId: "idem" });
    const retry = yield* register(service, { clientRequestId: "idem" });
    assert.equal(retry.watchId, first.watchId);
    const conflict = yield* Effect.result(
      service.watch({
        projectId,
        threadId,
        repository: "owner/other",
        number: 12,
        events: ["check_failed"],
        clientRequestId: "idem",
      }),
    );
    assert.isFalse(Result.isSuccess(conflict));
  }),
);

watchTest("cancel wins at every stage before delivery", () =>
  Effect.gen(function* () {
    // Phase 1: cancel while still pending, before the first poll.
    const pending = yield* makeHarness([obs(), obs({ checks: [check("ci", "failed")] })], 1);
    const pendingStatus = yield* register(pending.service, { clientRequestId: "cancel-pending" });
    const cancelledPending = yield* pending.service.cancel({
      threadId,
      projectId,
      watchId: pendingStatus.watchId,
    });
    assert.equal(cancelledPending.status, "cancelled");
    yield* tick(pending.service, "61 seconds");
    yield* tick(pending.service, "16 seconds");
    assert.equal((yield* Ref.get(pending.sent)).length, 0);
    assert.equal(yield* statusOf(pending.service), "cancelled");
    // Phase 2: cancel after matching, before the fixed deadline dispatches.
    // The first poll matches and starts collection; no delivery is attempted yet.
    const collecting = yield* makeHarness([obs(), obs({ checks: [check("ci", "failed")] })], 1);
    const collectingStatus = yield* register(collecting.service, {
      clientRequestId: "cancel-collecting",
    });
    yield* tick(collecting.service, "61 seconds");
    assert.equal(yield* statusOf(collecting.service), "matched");
    assert.equal((yield* Ref.get(collecting.sent)).length, 0);
    // Cancel before the fixed deadline: the final read and dispatch both stand down.
    const cancelledCollecting = yield* collecting.service.cancel({
      threadId,
      projectId,
      watchId: collectingStatus.watchId,
    });
    assert.equal(cancelledCollecting.status, "cancelled");
    yield* tick(collecting.service, "16 seconds");
    assert.equal((yield* Ref.get(collecting.sent)).length, 0);
    // Phase 3: cancel after the frozen payload's first delivery attempt fails.
    const frozen = yield* makeHarness([obs(), obs({ checks: [check("ci", "failed")] })], 1);
    const frozenStatus = yield* register(frozen.service, { clientRequestId: "cancel-frozen" });
    yield* tick(frozen.service, "61 seconds");
    yield* tick(frozen.service, "16 seconds");
    assert.equal((yield* Ref.get(frozen.sent)).length, 1);
    assert.equal(yield* statusOf(frozen.service), "matched");
    const cancelledFrozen = yield* frozen.service.cancel({
      threadId,
      projectId,
      watchId: frozenStatus.watchId,
    });
    assert.equal(cancelledFrozen.status, "cancelled");
    yield* tick(frozen.service, "61 seconds");
    assert.equal((yield* Ref.get(frozen.sent)).length, 1);
  }),
);

watchTest("closed-PR notification retries without a host read until receipt", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([obs(), obs({ state: "merged" })], 1);
    yield* register(harness.service, { clientRequestId: "closed" });
    yield* tick(harness.service, "61 seconds");
    const afterFail = (yield* harness.service.list({ threadId, projectId })).watches[0];
    assert.equal(afterFail?.status, "closed");
    assert.isNull(afterFail?.deliveredAt);
    assert.equal(yield* Ref.get(harness.reads), 2);
    yield* tick(harness.service, "61 seconds");
    assert.equal(yield* Ref.get(harness.reads), 2);
    const afterRecovery = (yield* harness.service.list({ threadId, projectId })).watches[0];
    assert.equal(afterRecovery?.status, "closed");
    assert.isNotNull(afterRecovery?.deliveredAt);
    const attempts = yield* Ref.get(harness.sent);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.commandId, attempts[1]?.commandId);
    assert.equal(attempts[0]?.messageId, attempts[1]?.messageId);
    assert.include(attempts[1]?.text ?? "", "merged");
  }),
);

watchTest("a close during collection keeps the first match and final feedback", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([
      obs(),
      obs({ checks: [check("ci", "failed")] }),
      obs({
        headSha: "fedcba987654321",
        state: "merged",
        checks: [check("ci", "failed")],
        feedback: [feedbackItem("c1", "merge follow-up")],
      }),
    ]);
    yield* register(harness.service, { clientRequestId: "close-collecting" });
    yield* tick(harness.service, "61 seconds");
    assert.equal((yield* Ref.get(harness.sent)).length, 0);
    yield* tick(harness.service, "16 seconds");
    const messages = yield* sentTexts(harness);
    assert.equal(messages.length, 1);
    assert.include(messages[0] ?? "", "ci");
    assert.include(messages[0] ?? "", "merge follow-up");
    assert.include(messages[0] ?? "", "merged");
    assert.include(messages[0] ?? "", "Later observation commit: fedcba987654321");
    assert.equal(yield* statusOf(harness.service), "closed");
  }),
);

watchTest("a vanished PR closes the watch with an explanatory notification", () =>
  Effect.gen(function* () {
    const { service, sent } = yield* makeHarness([obs(), { kind: "failure", reason: "not-found" }]);
    yield* register(service, { clientRequestId: "gone" });
    yield* tick(service, "61 seconds");
    assert.equal(yield* statusOf(service), "closed");
    assert.equal((yield* Ref.get(sent)).length, 1);
  }),
);

watchTest("a not-found final refresh preserves a collecting match", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([
      obs(),
      obs({ checks: [check("ci", "failed")] }),
      { kind: "failure", reason: "not-found" },
    ]);
    yield* register(harness.service, { clientRequestId: "not-found-collecting" });
    yield* tick(harness.service, "61 seconds");
    yield* tick(harness.service, "16 seconds");
    const message = (yield* sentTexts(harness))[0] ?? "";
    assert.include(message, "ci");
    assert.include(message, "could not be found");
    assert.equal(yield* statusOf(harness.service), "closed");
  }),
);

watchTest("transient read failures keep the watch pending with an error", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([{ kind: "failure", reason: "transient" }, obs()]);
    const status = yield* register(harness.service, { clientRequestId: "flaky" });
    assert.equal(status.status, "pending");
    assert.isNotNull(status.error);
    yield* tick(harness.service, "61 seconds");
    const current = (yield* harness.service.list({ threadId, projectId })).watches[0];
    assert.equal(current?.status, "pending");
    assert.isNull(current?.error);
  }),
);

watchTest("an incomplete read preserves the cursor and the next remark still fires", () =>
  Effect.gen(function* () {
    const { service, sent } = yield* makeHarness([
      // Registration baseline: one complete comment, never replayed.
      obs({ feedback: [feedbackItem("c1", "first remark")] }),
      // A truncated poll in the middle: nothing observable, cursor retained.
      obs({ feedback: [], feedbackComplete: false }),
      // Recovery read: the retained c1 plus the genuinely new c2.
      obs({
        feedback: [feedbackItem("c1", "first remark"), feedbackItem("c2", "second remark")],
      }),
    ]);
    const status = yield* register(service, {
      events: ["review_feedback"],
      clientRequestId: "partial",
    });
    assert.equal(status.status, "pending");
    yield* tick(service, "61 seconds");
    assert.equal((yield* Ref.get(sent)).length, 0);
    yield* tick(service, "61 seconds");
    assert.equal((yield* Ref.get(sent)).length, 0);
    yield* tick(service, "16 seconds");
    const messages = yield* sentTexts({ sent });
    assert.equal(messages.length, 1);
    const text = messages[0] ?? "";
    assert.include(text, "1 new or edited review comment");
    assert.include(text, "second remark");
    assert.notInclude(text, "first remark");
  }),
);

watchTest("watches on one PR share a single observer read per tick", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([obs(), obs(), obs({ checks: [check("ci", "failed")] })]);
    const first = yield* register(harness.service, { clientRequestId: "shared-1" });
    const second = yield* register(harness.service, {
      events: ["checks_finished"],
      clientRequestId: "shared-2",
    });
    assert.equal(first.status, "pending");
    assert.equal(second.status, "pending");
    const readsBeforePoll = yield* Ref.get(harness.reads);
    yield* tick(harness.service, "61 seconds");
    // One grouped host read drove both watches into the collecting window.
    assert.equal(yield* Ref.get(harness.reads), readsBeforePoll + 1);
    assert.equal((yield* Ref.get(harness.sent)).length, 0);
    yield* tick(harness.service, "16 seconds");
    // The final grouped host read drove both deliveries.
    assert.equal(yield* Ref.get(harness.reads), readsBeforePoll + 2);
    assert.equal((yield* Ref.get(harness.sent)).length, 2);
    const statuses = yield* harness.service.list({ threadId, projectId });
    assert.isTrue(statuses.watches.every((watch) => watch.status === "delivered"));
  }),
);

watchTest("cancel racing an in-flight observer read avoids dispatch", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const harness = yield* makeHarness([
      obs(),
      {
        kind: "gate",
        entered,
        release,
        afterRelease: obs({ checks: [check("ci", "failed")] }),
      },
    ]);
    const status = yield* register(harness.service, { clientRequestId: "race" });
    assert.equal(status.status, "pending");
    const poll = yield* harness.service.pollDueWatches().pipe(Effect.forkChild);
    // The poll is inside the observer read; cancel now, before the
    // observation — and therefore the match — exists.
    yield* Deferred.await(entered);
    const cancelled = yield* harness.service.cancel({
      threadId,
      projectId,
      watchId: status.watchId,
    });
    assert.equal(cancelled.status, "cancelled");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(poll);
    assert.equal((yield* Ref.get(harness.sent)).length, 0);
    assert.equal(yield* statusOf(harness.service), "cancelled");
  }),
);

watchTest("a CI match keeps the feedback cursor and flags truncated reads", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([
      obs(),
      obs({
        feedback: [feedbackItem("cY", "unseen remark")],
        feedbackComplete: false,
      }),
      obs({
        checks: [check("ci", "failed")],
        feedback: [feedbackItem("cX", "fresh remark")],
        feedbackComplete: false,
      }),
      obs({
        checks: [check("ci", "failed")],
        feedback: [feedbackItem("cX", "fresh remark")],
      }),
      obs({
        checks: [check("ci", "failed")],
        feedback: [feedbackItem("cX", "fresh remark"), feedbackItem("cZ", "later remark")],
      }),
    ]);
    yield* register(harness.service, {
      events: ["check_failed", "review_feedback"],
      clientRequestId: "cursor",
    });
    // Truncated read with review_feedback awaited: stays pending with an
    // honest error instead of silently parking.
    yield* tick(harness.service, "61 seconds");
    const stalled = (yield* harness.service.list({ threadId, projectId })).watches[0];
    assert.equal(stalled?.status, "pending");
    assert.include(stalled?.error ?? "", "incomplete");
    assert.equal((yield* Ref.get(harness.sent)).length, 0);
    // CI match on a truncated read still starts collection. The final fresh
    // read completes feedback and combines the unseen comment into one
    // frozen notification while retaining the cursor for a later rearm.
    yield* tick(harness.service, "61 seconds");
    assert.equal(yield* statusOf(harness.service), "matched");
    yield* tick(harness.service, "16 seconds");
    assert.equal(yield* statusOf(harness.service), "delivered");
    const rearmed = yield* harness.service.watch({
      projectId,
      threadId,
      repository: "owner/repo",
      number: 12,
      events: ["review_feedback"],
      previousWatchId: stalled?.watchId ?? (yield* Effect.die(new Error("missing watch"))),
    });
    assert.equal(rearmed.status, "pending");
    yield* tick(harness.service, "61 seconds");
    assert.equal((yield* Ref.get(harness.sent)).length, 1);
    yield* tick(harness.service, "16 seconds");
    const messages = yield* sentTexts(harness);
    assert.equal(messages.length, 2);
    const text = messages[1] ?? "";
    assert.include(text, "1 new or edited review comment");
    assert.include(text, "later remark");
  }),
);

watchTest("transient thread lookup keeps the match pending instead of closing", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([obs(), obs({ checks: [check("ci", "failed")] })]);
    yield* register(harness.service, { clientRequestId: "flaky-thread" });
    // Registration now validates the scoped thread before linking. Inject the
    // transient lookup failure at delivery time, where this scenario belongs.
    // It is set after the first poll so the roster backfill sync (which also
    // reads the projection, and tolerates failures) does not consume it.
    yield* tick(harness.service, "61 seconds");
    yield* Ref.set(harness.threadFailures, 1);
    // Matched and collecting; the thread is not looked up until the frozen
    // payload reaches its deadline.
    const stalled = (yield* harness.service.list({ threadId, projectId })).watches[0];
    assert.equal(stalled?.status, "matched");
    assert.equal((yield* Ref.get(harness.sent)).length, 0);
    yield* tick(harness.service, "16 seconds");
    // The final refresh froze the payload, but thread lookup blipped. The
    // next tick recovers through the frozen payload without a host read.
    const afterFailure = (yield* harness.service.list({ threadId, projectId })).watches[0];
    assert.equal(afterFailure?.status, "matched");
    assert.include(afterFailure?.error ?? "", "Unable to load thread");
    yield* tick(harness.service, "61 seconds");
    assert.equal(yield* statusOf(harness.service), "delivered");
    assert.equal((yield* Ref.get(harness.sent)).length, 1);
  }),
);

watchTest("list returns active and terminal watches without a cap", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { service } = yield* makeHarness([obs()]);
    const active = yield* register(service, { clientRequestId: "active-1" });
    assert.equal(active.status, "pending");
    const now = "2026-01-01T00:00:00.000Z";
    for (let n = 0; n < 3; n += 1) {
      const id = `pull-request-watch:seed:${n}`;
      yield* sql`INSERT INTO pull_request_watches ${sql.insert({
        watch_id: id,
        thread_id: threadId,
        project_id: projectId,
        repository: "owner/repo",
        number: 12,
        host: "github.com",
        url: null,
        events_json: '["check_failed"]',
        status: "delivered",
        last_observation_json: null,
        matched_json: null,
        last_error: null,
        last_polled_at: null,
        created_at: now,
        // Distinct timestamps so recency ordering is deterministic.
        updated_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
        delivered_at: now,
      })}`;
    }
    const { watches } = yield* service.list({ threadId, projectId });
    assert.equal(watches.length, 4);
    assert.isTrue(watches.some((watch) => watch.watchId === active.watchId));
    // Even the oldest terminal watch remains available to clients.
    assert.isTrue(watches.some((watch) => watch.watchId === "pull-request-watch:seed:0"));
    assert.isTrue(watches.some((watch) => watch.watchId === "pull-request-watch:seed:2"));
  }),
);

const providerThreadId = "provider-thread:test";

const withActiveProviderThread = (
  harness: Harness,
  seed?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
) =>
  Effect.gen(function* () {
    yield* Ref.set(harness.activeProviderThreadId, providerThreadId);
    if (seed !== undefined) {
      yield* Ref.set(harness.providerRosters, { [providerThreadId]: seed });
    }
  });

const rosterUpdatePayloads = (writes: ReadonlyArray<unknown>) =>
  writes.flatMap((write) => {
    const input = write as {
      readonly events: ReadonlyArray<{
        readonly type: string;
        readonly payload: {
          readonly pendingBackgroundTasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
        };
      }>;
    };
    return input.events.filter((event) => event.type === "provider-thread.updated");
  });

watchTest("register syncs the watch roster once alongside other entries", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([obs()]);
    yield* withActiveProviderThread(harness, [{ taskId: "bg-1", description: "sleep 30" }]);
    const status = yield* register(harness.service, { clientRequestId: "roster-sync" });
    assert.equal(status.status, "pending");
    const payloads = rosterUpdatePayloads(yield* Ref.get(harness.rosterWrites));
    assert.equal(payloads.length, 1);
    assert.deepStrictEqual(payloads[0]?.payload.pendingBackgroundTasks, [
      { taskId: "bg-1", description: "sleep 30" },
      {
        taskId: `pull-request-watch:${status.watchId}`,
        description: "PR #12",
        taskType: "pull_request_watch",
      },
    ]);
    // Re-registering the same watch changes nothing, so it emits no new event.
    yield* register(harness.service, { clientRequestId: "roster-sync" });
    assert.equal(rosterUpdatePayloads(yield* Ref.get(harness.rosterWrites)).length, 1);
  }),
);

watchTest("cancel removes the pull request watch roster entry", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([obs()]);
    yield* withActiveProviderThread(harness, [{ taskId: "bg-1", description: "sleep 30" }]);
    const status = yield* register(harness.service, { clientRequestId: "roster-cancel" });
    const cancelled = yield* harness.service.cancel({
      threadId,
      projectId,
      watchId: status.watchId,
    });
    assert.equal(cancelled.status, "cancelled");
    const payloads = rosterUpdatePayloads(yield* Ref.get(harness.rosterWrites));
    assert.equal(payloads.length, 2);
    // The unrelated entry survives while the watch entry is dropped.
    assert.deepStrictEqual(payloads[1]?.payload.pendingBackgroundTasks, [
      { taskId: "bg-1", description: "sleep 30" },
    ]);
  }),
);

watchTest("delivery removes the pull request watch roster entry", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([obs(), obs({ checks: [check("ci", "failed")] })]);
    yield* withActiveProviderThread(harness);
    const status = yield* register(harness.service, { clientRequestId: "roster-deliver" });
    assert.equal(status.status, "pending");
    yield* tick(harness.service, "61 seconds");
    yield* tick(harness.service, "16 seconds");
    assert.equal(yield* statusOf(harness.service), "delivered");
    const payloads = rosterUpdatePayloads(yield* Ref.get(harness.rosterWrites));
    assert.isAtLeast(payloads.length, 2);
    assert.deepStrictEqual(payloads.at(-1)?.payload.pendingBackgroundTasks, []);
  }),
);

watchTest("the first poll after startup backfills rosters for surviving watches", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([obs()]);
    // Registered before any active provider thread existed: no roster entry.
    const status = yield* register(harness.service, { clientRequestId: "roster-restart" });
    assert.equal((yield* Ref.get(harness.rosterWrites)).length, 0);
    // A restart later: the same durable watch now finds an active thread and
    // the first poll restores its roster entry without a host read.
    yield* withActiveProviderThread(harness);
    yield* harness.service.pollDueWatches();
    const payloads = rosterUpdatePayloads(yield* Ref.get(harness.rosterWrites));
    assert.equal(payloads.length, 1);
    assert.deepStrictEqual(payloads[0]?.payload.pendingBackgroundTasks, [
      {
        taskId: `pull-request-watch:${status.watchId}`,
        description: "PR #12",
        taskType: "pull_request_watch",
      },
    ]);
  }),
);

watchTest("delivery and close notifications read as plain pull request sentences", () =>
  Effect.gen(function* () {
    const eventHarness = yield* makeHarness([
      obs({ checks: [check("ci", "failed", "https://ci/run/1")] }),
    ]);
    yield* register(eventHarness.service, { clientRequestId: "summary-event" });
    yield* tick(eventHarness.service, "16 seconds");
    const eventMessages = yield* Ref.get(eventHarness.sent);
    assert.equal(eventMessages.length, 1);
    const eventSummary = (eventMessages[0]?.notification as { readonly summary?: unknown })
      ?.summary;
    assert.equal(
      eventSummary,
      "PR owner/repo#12: Check failed: ci; Checks finished: 1 failed (1 total)",
    );
    // The agent-facing text keeps the machine-readable evidence lines.
    assert.include(eventMessages[0]?.text ?? "", "check_failed");
    assert.include(eventMessages[0]?.text ?? "", "Commit: abc123def456789");
    const closeHarness = yield* makeHarness([obs({ state: "merged" })]);
    const closed = yield* register(closeHarness.service, { clientRequestId: "summary-close" });
    assert.equal(closed.status, "closed");
    const closeMessages = yield* Ref.get(closeHarness.sent);
    assert.equal(closeMessages.length, 1);
    const closeSummary = (closeMessages[0]?.notification as { readonly summary?: unknown })
      ?.summary;
    assert.equal(closeSummary, "PR owner/repo#12 was merged before any watched event fired");
  }),
);
