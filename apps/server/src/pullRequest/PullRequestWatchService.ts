import {
  CommandId,
  DEFAULT_PULL_REQUEST_WATCH_EVENTS,
  MessageId,
  type OrchestrationV2Notification,
  ProjectId,
  PullRequestWatchError,
  PullRequestWatchEvent,
  PullRequestWatchId,
  type PullRequestWatchStatus,
  ThreadId,
} from "@t3tools/contracts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ThreadManagementService,
  ThreadManagementThreadArchivedError,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import {
  matchesWatchEvent,
  PullRequestWatchObservation,
  PullRequestWatchObserver,
} from "./PullRequestWatchObservation.ts";

/**
 * Durable one-shot pull request watches. A plain service table like
 * scheduled_tasks — watch lifecycle is per-thread key/value state driven by a
 * poll loop, not thread history, so it stays out of the v2 event log. Only
 * the delivered notification itself is event sourced (message.dispatch).
 *
 * Observation reads and per-event matching are canonical in
 * PullRequestWatchObservation.ts (observer worker); this module owns the
 * lifecycle around them: registration, the poll loop, the frozen
 * matched payload, serialized cancel/delivery, and notification formatting.
 */

export interface PullRequestWatchRegisterInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly repository: string;
  readonly number: number;
  readonly host?: string;
  readonly url?: string;
  readonly events?: ReadonlyArray<PullRequestWatchEvent>;
  /** Gap-free rearm: seed the cursor from this previous watch's last observation. */
  readonly previousWatchId?: PullRequestWatchId;
  /**
   * Idempotency key, bound to the thread (not the provider session) so a
   * retry after session rotation reuses the same watch row. Conflicting
   * params under a reused key fail instead of returning the old row.
   */
  readonly clientRequestId?: string;
}

/**
 * Holds the first match while a short coalescing window is open, then becomes
 * the frozen delivery payload. Recovery dispatches it without a fresh host
 * read. It carries the observed head sha and matched event names; detail is
 * bounded at build time (first relevant lines plus a count), never a full
 * conversation.
 */
const MatchedPayload = Schema.Struct({
  summary: Schema.String,
  detail: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["completed", "failed", "cancelled", "updated"]),
  /** Null only when the PR vanished before any observation (not-found). */
  headSha: Schema.NullOr(Schema.String),
  /** Every event the matching observation hit; empty for close payloads. */
  events: Schema.Array(PullRequestWatchEvent),
  /** Set for PR-closed/merged/not-found stops; absent for event matches. */
  closeReason: Schema.optional(Schema.Literals(["merged", "closed", "not-found"])),
  /** Retained across delivery retries, whose errors temporarily occupy last_error. */
  observationError: Schema.optional(Schema.String),
});
type MatchedPayload = typeof MatchedPayload.Type;

const MatchedJson = Schema.fromJsonString(MatchedPayload);

const parseMatchedJson = (
  json: string,
  watchId: PullRequestWatchId,
): Effect.Effect<MatchedPayload, PullRequestWatchError> =>
  decodeMatchedEffect(json).pipe(
    Effect.mapError(() => watchError("Could not decode watch delivery.", watchId)),
  );

const watchError = (message: string, watchId?: PullRequestWatchId) =>
  new PullRequestWatchError({ message, ...(watchId === undefined ? {} : { watchId }) });

const isThreadNotFound = Schema.is(ThreadManagementThreadNotFoundError);
const isThreadArchived = Schema.is(ThreadManagementThreadArchivedError);

const iso = (value: DateTime.DateTime): string => DateTime.formatIso(DateTime.toUtc(value));
const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

/** Minimum age of last_polled_at before a watch is polled again. */
const POLL_INTERVAL_MS = 60_000;
const POLL_BATCH_LIMIT = 25;
const COALESCE_WINDOW_MS = 15_000;

interface PullRequestWatchRow {
  readonly watch_id: string;
  readonly thread_id: string;
  readonly project_id: string;
  readonly repository: string;
  readonly number: number;
  readonly host: string | null;
  readonly url: string | null;
  readonly events_json: string;
  readonly status: string;
  readonly last_observation_json: string | null;
  readonly matched_json: string | null;
  readonly match_deadline_at: string | null;
  readonly last_error: string | null;
  readonly last_polled_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly delivered_at: string | null;
}

const EventsJson = Schema.fromJsonString(Schema.Array(PullRequestWatchEvent));
const ObservationJson = Schema.fromJsonString(PullRequestWatchObservation);

const decodeEventsEffect = Schema.decodeUnknownEffect(EventsJson);
const encodeEventsSync = Schema.encodeSync(EventsJson);
const decodeObservationEffect = Schema.decodeUnknownEffect(ObservationJson);
const encodeObservationSync = Schema.encodeSync(ObservationJson);
const decodeMatchedEffect = Schema.decodeUnknownEffect(MatchedJson);
const encodeMatchedSync = Schema.encodeSync(MatchedJson);

const encodeEvents = (events: ReadonlyArray<PullRequestWatchEvent>): string =>
  encodeEventsSync([...events]);

const encodeObservation = (observation: PullRequestWatchObservation): string =>
  encodeObservationSync(observation);

const encodeMatched = (payload: MatchedPayload): string => encodeMatchedSync(payload);

const decodeEventsJson = (
  json: string,
  watchId?: PullRequestWatchId,
): Effect.Effect<ReadonlyArray<PullRequestWatchEvent>, PullRequestWatchError> =>
  decodeEventsEffect(json).pipe(
    Effect.mapError(() => watchError("Could not decode watch events.", watchId)),
  );

const decodeObservationJson = (
  json: string | null,
): Effect.Effect<PullRequestWatchObservation | null> =>
  json === null
    ? Effect.succeed(null)
    : decodeObservationEffect(json).pipe(
        Effect.catch(() => Effect.succeed(null as PullRequestWatchObservation | null)),
      );

/**
 * Host is part of PR identity: the same owner/repo on github.com and on an
 * Enterprise install are two different pull requests. An omitted host means
 * github.com everywhere — registration, rearm comparison, and poll grouping
 * all resolve it identically.
 */
const canonicalHost = (host: string | null | undefined): string => {
  const trimmed = host?.trim().toLowerCase();
  return trimmed === undefined || trimmed === "" ? "github.com" : trimmed;
};

const displayUrl = (row: {
  readonly host: string | null;
  readonly repository: string;
  readonly number: number;
  readonly url: string | null;
}): string | null => {
  if (row.url !== null) return row.url;
  if (row.host === null || row.host.toLowerCase() === "github.com") {
    return `https://${row.host ?? "github.com"}/${row.repository}/pull/${row.number}`;
  }
  return null;
};

export class PullRequestWatchService extends Context.Service<
  PullRequestWatchService,
  {
    readonly watch: (
      input: PullRequestWatchRegisterInput,
    ) => Effect.Effect<PullRequestWatchStatus, PullRequestWatchError>;
    readonly list: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<
      { readonly watches: ReadonlyArray<PullRequestWatchStatus> },
      PullRequestWatchError
    >;
    readonly cancel: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly watchId: PullRequestWatchId;
    }) => Effect.Effect<PullRequestWatchStatus, PullRequestWatchError>;
    /** One poll tick over due watches. The Scheduler worker calls this; tests call it directly. */
    readonly pollDueWatches: () => Effect.Effect<void, PullRequestWatchError>;
  }
>()("t3/pullRequest/PullRequestWatchService") {}

/** Verdict counts for a finished rollup; terminal is not success. */
const summarizeChecks = (checks: PullRequestWatchObservation["checks"]): string => {
  const counts = new Map<string, number>();
  for (const check of checks) counts.set(check.state, (counts.get(check.state) ?? 0) + 1);
  const order = ["passed", "failed", "cancelled", "skipped", "pending"] as const;
  const parts = order.flatMap((state) => {
    const n = counts.get(state) ?? 0;
    return n > 0 ? [`${n} ${state}`] : [];
  });
  return `Checks finished: ${parts.join(", ")} (${checks.length} total)`;
};

/** Bounded evidence: first lines plus a remainder count, never the whole rollup. */
const MAX_DETAIL_CHECKS = 10;
const MAX_DETAIL_FEEDBACK = 5;

const detailChecks = (checks: PullRequestWatchObservation["checks"]): string => {
  const lines = checks.map(
    (check) => `- ${check.name}: ${check.state}${check.url ? ` (${check.url})` : ""}`,
  );
  const shown = lines.slice(0, MAX_DETAIL_CHECKS);
  if (lines.length > shown.length) shown.push(`…and ${lines.length - shown.length} more`);
  return shown.join("\n");
};

const detailFeedback = (items: PullRequestWatchObservation["feedback"]): string => {
  const shown = items.slice(0, MAX_DETAIL_FEEDBACK);
  const lines = shown.map(
    (item) => `- ${item.body.slice(0, 240)}${item.url ? ` (${item.url})` : ""}`,
  );
  if (items.length > shown.length) lines.push(`…and ${items.length - shown.length} more`);
  return lines.join("\n");
};

/** Remarks in next that are new or edited since previous (same id, new body/timestamp). */
const freshFeedback = (
  previous: PullRequestWatchObservation | null,
  next: PullRequestWatchObservation,
): PullRequestWatchObservation["feedback"] => {
  const before = new Map((previous?.feedback ?? []).map((item) => [item.id, item]));
  return next.feedback.filter((item) => {
    const known = before.get(item.id);
    return known === undefined || known.body !== item.body || known.updatedAt !== item.updatedAt;
  });
};

export const layer = Layer.effect(
  PullRequestWatchService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const observer = yield* PullRequestWatchObserver;
    const threadManagement = yield* ThreadManagementService;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    // Cancel/delivery serialization: the poll's re-read→dispatch and an MCP
    // cancel share this permit, so a cancel landing first always wins before
    // dispatch. Single server owns the database; same scope as the scheduled
    // task in-memory run guard.
    const deliveryLock = yield* Semaphore.make(1);
    // Registration retries can race with one another. Serialize the projection
    // check and link command so only one caller needs to emit a v2 command.
    const linkLock = yield* Semaphore.make(1);

    const toStatus = (
      row: PullRequestWatchRow,
    ): Effect.Effect<PullRequestWatchStatus, PullRequestWatchError> =>
      Effect.gen(function* () {
        const events = yield* decodeEventsJson(
          row.events_json,
          PullRequestWatchId.make(row.watch_id),
        );
        return {
          watchId: PullRequestWatchId.make(row.watch_id),
          threadId: ThreadId.make(row.thread_id),
          projectId: ProjectId.make(row.project_id),
          repository: row.repository,
          number: row.number,
          host: row.host,
          url: displayUrl(row),
          events,
          status: row.status as PullRequestWatchStatus["status"],
          error: row.last_error,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deliveredAt: row.delivered_at,
        } satisfies PullRequestWatchStatus;
      });

    const findRow = (
      watchId: PullRequestWatchId,
    ): Effect.Effect<PullRequestWatchRow | null, PullRequestWatchError> =>
      Effect.gen(function* () {
        const rows = yield* sql<PullRequestWatchRow>`
        SELECT * FROM pull_request_watches WHERE watch_id = ${watchId}
      `.pipe(
          Effect.mapError((cause) =>
            watchError(`Could not load pull request watch: ${cause}`, watchId),
          ),
        );
        return rows[0] ?? null;
      });

    const loadScopedRow = (
      projectId: ProjectId,
      threadId: ThreadId,
      watchId: PullRequestWatchId,
    ): Effect.Effect<PullRequestWatchRow, PullRequestWatchError> =>
      Effect.gen(function* () {
        const row = yield* findRow(watchId);
        // Project/thread mismatch reads as not-found: never confirm or deny
        // another thread's watches.
        if (row === null || row.project_id !== projectId || row.thread_id !== threadId) {
          return yield* watchError(`Pull request watch ${watchId} was not found.`, watchId);
        }
        return row;
      });

    // First poll after startup backfills rosters for watches registered by
    // an older server version that never synced them.
    const rosterBackfilled = yield* Ref.make(false);

    /** Task type marking roster entries owned by pull request watches. */
    const WATCH_TASK_TYPE = "pull_request_watch";

    /**
     * Mirror this thread's pending/matched watches into the active provider
     * thread's `pendingBackgroundTasks` roster so clients render the thread
     * as Waiting. Watch entries are namespaced by taskType and preserved
     * alongside entries of other kinds. Appends one provider-thread.updated
     * event only when the taskId set differs. Failures are logged and never
     * fail the watch operation.
     */
    const syncThreadWatchRoster = (threadId: ThreadId, projectId: ProjectId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const rows = yield* sql<Pick<PullRequestWatchRow, "watch_id" | "number">>`
          SELECT watch_id, number FROM pull_request_watches
          WHERE thread_id = ${threadId} AND project_id = ${projectId}
            AND status IN ('pending', 'matched')
        `;
        const projection = yield* threadManagement.getProjectThread({ projectId, threadId });
        const activeId = projection.thread.activeProviderThreadId;
        if (activeId === null || activeId === undefined) return;
        const providerThread = (projection.providerThreads ?? []).find(
          (candidate) => candidate.id === activeId,
        );
        if (providerThread === undefined) return;
        const current = providerThread.pendingBackgroundTasks ?? [];
        const desired = [
          ...current.filter((task) => task.taskType !== WATCH_TASK_TYPE),
          ...rows.map((row) => ({
            taskId: `pull-request-watch:${row.watch_id}`,
            description: `PR #${row.number}`,
            taskType: WATCH_TASK_TYPE,
          })),
        ];
        const currentIds = new Set(current.map((task) => task.taskId));
        const desiredIds = new Set(desired.map((task) => task.taskId));
        if (
          currentIds.size === desiredIds.size &&
          [...desiredIds].every((id) => currentIds.has(id))
        ) {
          return;
        }
        const now = yield* DateTime.now;
        yield* eventSink.write({
          commandId: CommandId.make(
            `pull-request-watch:roster:${threadId}:${DateTime.formatIso(now)}`,
          ),
          events: [
            {
              id: yield* ids.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: providerThread.driver,
              providerInstanceId: providerThread.providerInstanceId,
              occurredAt: now,
              payload: {
                ...providerThread,
                pendingBackgroundTasks: desired,
                updatedAt: now,
              },
            },
          ],
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(`Could not sync pull request watch roster for ${threadId}: ${cause}`),
        ),
      );

    /**
     * Dispatch a frozen payload with the watch's stable ids. Every attempt —
     * first or post-restart recovery — reuses the same command/message pair,
     * so the event store's commandId idempotency and the messageId reuse keep
     * a retry from duplicating the timeline item. The durable dispatch
     * receipt is sendToThread success (it re-read the projection with the
     * dispatched message); only then is the watch marked terminally delivered.
     */
    const deliverPayload = (row: PullRequestWatchRow): Effect.Effect<void, PullRequestWatchError> =>
      deliveryLock.withPermits(1)(
        Effect.gen(function* () {
          // Cancel wins: re-read under the permit immediately before dispatch.
          const current = yield* findRow(PullRequestWatchId.make(row.watch_id));
          if (
            current === null ||
            current.matched_json === null ||
            current.match_deadline_at !== null ||
            !(
              current.status === "matched" ||
              (current.status === "closed" && current.delivered_at === null)
            )
          ) {
            return;
          }
          // Read the persisted payload under the delivery permit. A caller
          // may have loaded an older row before the final coalescing update;
          // delivery must always use the payload that was frozen on disk.
          const frozenPayload = yield* parseMatchedJson(
            current.matched_json,
            PullRequestWatchId.make(row.watch_id),
          );
          // Environment ownership plus archived/deleted thread checks: the
          // project-scoped read fails outside this project, and a settled-away
          // thread stops the watch instead of delivering into it.
          const projection = yield* threadManagement
            .getProjectThread({
              projectId: ProjectId.make(row.project_id),
              threadId: ThreadId.make(row.thread_id),
            })
            .pipe(Effect.result);
          const nowIso = iso(yield* localNow);
          if (!Result.isSuccess(projection)) {
            // Only a typed not-found (deleted thread or project mismatch)
            // stops the watch: transient persistence failures record an
            // error and retry with the frozen payload intact.
            const gone = isThreadNotFound(projection.failure);
            yield* sql`
              UPDATE pull_request_watches
              SET status = ${gone ? "closed" : current.status},
                  matched_json = ${gone ? null : current.matched_json},
                  last_error = ${gone ? "Thread is no longer available in this project." : String(projection.failure.message).slice(0, 2000)},
                  updated_at = ${nowIso}
              WHERE watch_id = ${row.watch_id}
            `.pipe(
              Effect.mapError((cause) =>
                watchError(
                  `Could not stop pull request watch: ${cause}`,
                  PullRequestWatchId.make(row.watch_id),
                ),
              ),
            );
            if (gone) {
              yield* syncThreadWatchRoster(
                ThreadId.make(row.thread_id),
                ProjectId.make(row.project_id),
              );
            }
            return;
          }
          const thread = projection.success.thread;
          if (thread.archivedAt !== null || thread.deletedAt !== null) {
            yield* sql`
              UPDATE pull_request_watches
              SET status = 'closed', matched_json = NULL,
                  last_error = ${thread.archivedAt !== null ? "Thread is archived." : "Thread was deleted."},
                  updated_at = ${nowIso}
              WHERE watch_id = ${row.watch_id}
            `.pipe(
              Effect.mapError((cause) =>
                watchError(
                  `Could not stop pull request watch: ${cause}`,
                  PullRequestWatchId.make(row.watch_id),
                ),
              ),
            );
            yield* syncThreadWatchRoster(
              ThreadId.make(row.thread_id),
              ProjectId.make(row.project_id),
            );
            return;
          }
          const watchId = PullRequestWatchId.make(row.watch_id);
          const prUrl = displayUrl(row);
          const eventLabel =
            frozenPayload.events.length > 0
              ? frozenPayload.events.join("+")
              : (frozenPayload.closeReason ?? "update");
          const commitLine =
            frozenPayload.headSha === null ? null : `Commit: ${frozenPayload.headSha}`;
          const evidenceLines = [
            `PR ${row.repository}#${row.number} — ${eventLabel}: ${frozenPayload.summary}`,
            ...(commitLine === null ? [] : [commitLine]),
            ...(prUrl === null ? [] : [`PR: ${prUrl}`]),
            ...(frozenPayload.detail === null ? [] : ["", frozenPayload.detail]),
          ];
          const nextStep =
            frozenPayload.closeReason === undefined
              ? `This one-shot watch has ended. Re-arm with watch_pull_request and previousWatchId="${watchId}" to keep waiting from this observation.`
              : "This pull request watch has stopped.";
          const text = `${evidenceLines.join("\n")}\n\n${nextStep}`;
          const dispatch = yield* threadManagement
            .sendToThread({
              projectId: ProjectId.make(row.project_id),
              commandId: CommandId.make(`pull-request-watch:${row.watch_id}:deliver`),
              threadId: ThreadId.make(row.thread_id),
              messageId: MessageId.make(`pull-request-watch-message:${row.watch_id}`),
              mode: "queue",
              createdBy: "agent",
              creationSource: "server",
              notification: {
                source: { kind: "pull_request_watch", watchId },
                outcome: frozenPayload.outcome,
                summary:
                  frozenPayload.closeReason === undefined
                    ? `PR ${row.repository}#${row.number}: ${frozenPayload.summary}`
                    : `PR ${row.repository}#${row.number} ${frozenPayload.summary}`,
                detail: evidenceLines.join("\n"),
              } satisfies OrchestrationV2Notification,
              text,
              attachments: [],
            })
            .pipe(Effect.result);
          if (!Result.isSuccess(dispatch)) {
            // Only a typed archived error stops the watch; every other
            // dispatch failure keeps the frozen payload for an idempotent
            // retry under the same stable ids. Failures never mark success.
            const archived = isThreadArchived(dispatch.failure);
            const message = archived
              ? "Thread is archived."
              : String(dispatch.failure.message).slice(0, 2000);
            yield* sql`
              UPDATE pull_request_watches
              SET status = ${archived ? "closed" : current.status},
                  matched_json = ${archived ? null : current.matched_json},
                  last_error = ${message}, updated_at = ${nowIso}
              WHERE watch_id = ${row.watch_id}
            `.pipe(
              Effect.mapError((cause) =>
                watchError(`Could not record pull request watch error: ${cause}`, watchId),
              ),
            );
            if (archived) {
              yield* syncThreadWatchRoster(
                ThreadId.make(row.thread_id),
                ProjectId.make(row.project_id),
              );
            }
            return;
          }
          yield* sql`
            UPDATE pull_request_watches
            SET status = ${frozenPayload.closeReason === undefined ? "delivered" : "closed"},
                last_error = ${frozenPayload.observationError ?? null},
                updated_at = ${nowIso},
                delivered_at = ${nowIso}
            WHERE watch_id = ${row.watch_id}
          `.pipe(
            Effect.mapError((cause) =>
              watchError(`Could not record pull request watch delivery: ${cause}`, watchId),
            ),
          );
          yield* syncThreadWatchRoster(
            ThreadId.make(row.thread_id),
            ProjectId.make(row.project_id),
          );
        }),
      );

    const closePayload = (
      reason: "merged" | "closed" | "not-found",
      headSha: string | null,
    ): MatchedPayload => ({
      summary:
        reason === "merged"
          ? `was merged before any watched event fired`
          : reason === "closed"
            ? `was closed before any watched event fired`
            : `is no longer found on its host, so the watch stopped`,
      detail: null,
      outcome: "cancelled",
      headSha,
      events: [],
      closeReason: reason,
    });

    /**
     * Every matching event aggregated into one bounded payload, or null.
     * One observation can hit several events at once (a failed check plus
     * new review comments); reporting them together means the cursor advance
     * never drops an undelivered reason a rearm would then miss. Shared by
     * the poll path and the registration immediate-match path so both
     * report identical evidence.
     */
    const buildEventPayload = (
      previous: PullRequestWatchObservation | null,
      next: PullRequestWatchObservation,
      events: ReadonlyArray<PullRequestWatchEvent>,
    ): MatchedPayload | null => {
      const hits = events.filter((event) => matchesWatchEvent({ previous, next, event }));
      if (hits.length === 0) return null;
      const summaries: Array<string> = [];
      const details: Array<string> = [];
      let outcome: MatchedPayload["outcome"] = "updated";
      if (hits.includes("check_failed")) {
        const failed = next.checks.filter((c) => c.state === "failed");
        summaries.push(
          `Check${failed.length === 1 ? "" : "s"} failed: ${failed.map((c) => c.name).join(", ")}`,
        );
        details.push(detailChecks(failed));
        outcome = "failed";
      }
      if (hits.includes("checks_finished")) {
        summaries.push(summarizeChecks(next.checks));
        details.push(detailChecks(next.checks));
        if (outcome !== "failed") outcome = "completed";
      }
      if (hits.includes("review_feedback")) {
        const fresh = freshFeedback(previous, next);
        summaries.push(
          `${fresh.length} new or edited review comment${fresh.length === 1 ? "" : "s"}`,
        );
        details.push(detailFeedback(fresh));
      }
      return {
        summary: summaries.join("; "),
        detail: details.join("\n"),
        outcome,
        headSha: next.headSha,
        events: hits,
      };
    };

    const appendPayloadNote = (payload: MatchedPayload, note: string): MatchedPayload => ({
      ...payload,
      detail:
        payload.detail === null || payload.detail.length === 0
          ? note
          : `${payload.detail}\n\n${note}`,
    });

    const combineOutcomes = (
      first: MatchedPayload["outcome"],
      second: MatchedPayload["outcome"],
    ): MatchedPayload["outcome"] => {
      if (first === "failed" || second === "failed") return "failed";
      if (first === "cancelled" || second === "cancelled") return "cancelled";
      if (first === "completed" || second === "completed") return "completed";
      return "updated";
    };

    /** Keep the first match as the primary evidence while adding later hits. */
    const combineMatchedPayload = (
      first: MatchedPayload,
      later: MatchedPayload,
    ): MatchedPayload => {
      const headNote =
        first.headSha !== null && later.headSha !== null && first.headSha !== later.headSha
          ? `Later observation commit: ${later.headSha}`
          : null;
      const details = [first.detail, headNote, later.detail].filter(
        (detail): detail is string => detail !== null && detail.length > 0,
      );
      const summaries = [first.summary, later.summary].filter((summary) => summary.length > 0);
      return {
        summary: summaries.join("; "),
        detail: details.length === 0 ? null : details.join("\n"),
        outcome: combineOutcomes(first.outcome, later.outcome),
        // The first matching commit remains the primary commit line. If an
        // old row has a null head, retain the later evidence instead.
        headSha: first.headSha ?? later.headSha,
        events: [...new Set([...first.events, ...later.events])],
        ...(later.closeReason === undefined && first.closeReason === undefined
          ? {}
          : { closeReason: later.closeReason ?? first.closeReason }),
      };
    };

    const closeCollectingPayload = (
      payload: MatchedPayload,
      reason: "merged" | "closed" | "not-found",
      headSha: string | null,
    ): MatchedPayload => {
      const phrase =
        reason === "merged"
          ? "was merged"
          : reason === "closed"
            ? "was closed"
            : "could not be found";
      const combined = {
        ...payload,
        summary: `${payload.summary}; PR ${phrase} during the coalescing window`,
        headSha: payload.headSha ?? headSha,
        closeReason: reason,
      } satisfies MatchedPayload;
      const headNote =
        payload.headSha !== null && headSha !== null && payload.headSha !== headSha
          ? `Later observation commit: ${headSha}`
          : null;
      return headNote === null ? combined : appendPayloadNote(combined, headNote);
    };

    /**
     * Advance the cursor after a non-matching poll. An incomplete feedback
     * read retains the prior feedback list *and* its completeness flag: the
     * stored cursor still describes a complete feedback history, so the next
     * complete read compares against it instead of rejecting on a false flag
     * and losing remarks posted in the gap.
     */
    const advanceCursor = (
      previous: PullRequestWatchObservation | null,
      next: PullRequestWatchObservation,
    ): PullRequestWatchObservation =>
      next.feedbackComplete
        ? next
        : {
            ...next,
            feedback: previous?.feedback ?? [],
            feedbackComplete: previous?.feedbackComplete ?? false,
          };

    const processPendingRow = (
      row: PullRequestWatchRow,
      next: PullRequestWatchObservation,
    ): Effect.Effect<void, PullRequestWatchError> =>
      Effect.gen(function* () {
        const watchId = PullRequestWatchId.make(row.watch_id);
        const current = yield* findRow(watchId);
        if (current === null || current.status !== "pending") return;
        const now = yield* DateTime.now;
        const nowIso = iso(now);
        if (next.state === "closed" || next.state === "merged") {
          const payload = closePayload(next.state, next.headSha);
          const claimed = yield* sql<{ watch_id: string }>`
              UPDATE pull_request_watches
              SET status = 'closed',
                  last_observation_json = ${encodeObservation(next)},
                  matched_json = ${encodeMatched(payload)},
                  last_error = NULL,
                  updated_at = ${nowIso}
              WHERE watch_id = ${current.watch_id} AND status = 'pending'
              RETURNING watch_id
            `.pipe(
            Effect.mapError((cause) =>
              watchError(`Could not close pull request watch: ${cause}`, watchId),
            ),
          );
          if (claimed.length === 0) return;
          yield* deliverPayload({ ...current, status: "closed" });
          return;
        }
        const previous = yield* decodeObservationJson(current.last_observation_json);
        const events = yield* decodeEventsJson(current.events_json, watchId);
        const payload = buildEventPayload(previous, next, events);
        if (payload === null) {
          // An incomplete feedback read while review_feedback is awaited
          // is an honest pending error, not a clean bill: truncated PR
          // histories would otherwise park the watch silently forever.
          const staleFeedback = !next.feedbackComplete && events.includes("review_feedback");
          yield* sql`
              UPDATE pull_request_watches
              SET last_observation_json = ${encodeObservation(advanceCursor(previous, next))},
                  last_error = ${staleFeedback ? "Feedback read incomplete; retrying without advancing past unseen remarks." : null},
                  updated_at = ${nowIso}
              WHERE watch_id = ${current.watch_id} AND status = 'pending'
            `.pipe(
            Effect.mapError((cause) =>
              watchError(`Could not advance pull request watch: ${cause}`, watchId),
            ),
          );
          return;
        }
        // The stored cursor advances through advanceCursor even on a
        // match: with incomplete feedback, the raw next would drop the
        // prior complete cursor and a rearm would lose those remarks.
        const claimed = yield* sql<{ watch_id: string }>`
            UPDATE pull_request_watches
            SET status = 'matched',
                last_observation_json = ${encodeObservation(advanceCursor(previous, next))},
                matched_json = ${encodeMatched(payload)},
                match_deadline_at = ${iso(DateTime.add(now, { milliseconds: COALESCE_WINDOW_MS }))},
                last_error = NULL,
                updated_at = ${nowIso}
            WHERE watch_id = ${current.watch_id} AND status = 'pending'
            RETURNING watch_id
          `.pipe(
          Effect.mapError((cause) =>
            watchError(`Could not match pull request watch: ${cause}`, watchId),
          ),
        );
        // The guarded update claims exactly one driver; a cancel (or a
        // concurrent tick) that landed first leaves zero rows and this
        // attempt stands down without writing anything.
        if (claimed.length === 0) return;
        // The row remains in the fixed coalescing window. Its deadline tick
        // performs the final shared read and freezes delivery.
      });

    const freezeCollectingRow = (
      row: PullRequestWatchRow,
      payload: MatchedPayload,
      cursor: PullRequestWatchObservation | undefined,
      error: string | null,
    ): Effect.Effect<void, PullRequestWatchError> =>
      Effect.gen(function* () {
        const watchId = PullRequestWatchId.make(row.watch_id);
        const current = yield* findRow(watchId);
        if (
          current === null ||
          current.status !== "matched" ||
          current.match_deadline_at === null
        ) {
          return;
        }
        const nowIso = iso(yield* DateTime.now);
        const claimed = yield* sql<{ watch_id: string }>`
          UPDATE pull_request_watches
          SET matched_json = ${encodeMatched({ ...payload, ...(error === null ? {} : { observationError: error }) })},
              last_observation_json = ${cursor === undefined ? current.last_observation_json : encodeObservation(cursor)},
              match_deadline_at = NULL,
              last_error = ${error},
              updated_at = ${nowIso}
          WHERE watch_id = ${current.watch_id}
            AND status = 'matched'
            AND match_deadline_at = ${current.match_deadline_at}
            AND match_deadline_at <= ${nowIso}
          RETURNING watch_id
        `.pipe(
          Effect.mapError((cause) =>
            watchError(`Could not freeze pull request watch: ${cause}`, watchId),
          ),
        );
        if (claimed.length === 0) return;
        // The payload and deadline are durable before dispatch starts. A
        // cancel that wins the delivery permit prevents the send below.
        yield* deliverPayload({ ...current, match_deadline_at: null });
      });

    const processCollectingRow = (
      row: PullRequestWatchRow,
      next: PullRequestWatchObservation,
    ): Effect.Effect<void, PullRequestWatchError> =>
      Effect.gen(function* () {
        const watchId = PullRequestWatchId.make(row.watch_id);
        const current = yield* findRow(watchId);
        if (
          current === null ||
          current.status !== "matched" ||
          current.match_deadline_at === null
        ) {
          return;
        }
        const first = yield* parseMatchedJson(current.matched_json!, watchId);
        const previous = yield* decodeObservationJson(current.last_observation_json);
        const events = yield* decodeEventsJson(current.events_json, watchId);
        const later = buildEventPayload(previous, next, events);
        let payload = later === null ? first : combineMatchedPayload(first, later);
        const incompleteFeedback = !next.feedbackComplete && events.includes("review_feedback");
        const error = incompleteFeedback
          ? "Feedback read incomplete at the coalescing deadline; reporting the observed match without advancing past unseen remarks."
          : null;
        if (next.state === "closed" || next.state === "merged") {
          payload = closeCollectingPayload(payload, next.state, next.headSha);
        }
        if (error !== null) payload = appendPayloadNote(payload, error);
        yield* freezeCollectingRow(current, payload, advanceCursor(previous, next), error);
      });

    type PollGroup = {
      readonly pending: ReadonlyArray<PullRequestWatchRow>;
      readonly collecting: ReadonlyArray<PullRequestWatchRow>;
    };

    const pollGroup = (group: PollGroup): Effect.Effect<void, PullRequestWatchError> =>
      Effect.gen(function* () {
        const first = group.pending[0] ?? group.collecting[0];
        if (first === undefined) return;
        const observation = yield* observer
          .read({
            projectId: ProjectId.make(first.project_id),
            repository: first.repository,
            number: first.number,
            host: canonicalHost(first.host),
            ...(group.collecting.length === 0 ? {} : { refresh: true }),
          })
          .pipe(Effect.result);
        const nowIso = iso(yield* DateTime.now);
        if (!Result.isSuccess(observation)) {
          const error = observation.failure;
          if (error.reason === "not-found") {
            for (const row of group.pending) {
              const payload = closePayload("not-found", null);
              const claimed = yield* sql<{ watch_id: string }>`
                UPDATE pull_request_watches
                SET status = 'closed',
                    matched_json = ${encodeMatched(payload)},
                    match_deadline_at = NULL,
                    last_error = NULL,
                    updated_at = ${nowIso}
                WHERE watch_id = ${row.watch_id} AND status = 'pending'
                RETURNING watch_id
              `.pipe(
                Effect.mapError((cause) =>
                  watchError(
                    `Could not close pull request watch: ${cause}`,
                    PullRequestWatchId.make(row.watch_id),
                  ),
                ),
              );
              if (claimed.length === 0) continue;
              yield* deliverPayload({ ...row, status: "closed", match_deadline_at: null });
            }
            for (const row of group.collecting) {
              const watchId = PullRequestWatchId.make(row.watch_id);
              const current = yield* findRow(watchId);
              if (current === null || current.matched_json === null) continue;
              const first = yield* parseMatchedJson(current.matched_json, watchId);
              yield* freezeCollectingRow(
                current,
                closeCollectingPayload(first, "not-found", null),
                undefined,
                null,
              );
            }
            return;
          }
          // A failure during the fixed final window freezes each matched
          // payload and reports it. It never extends the deadline or drops
          // the cursor; only pending rows remain pending for a retry.
          const message =
            error.reason === "unsupported"
              ? `Watching pull requests on this host is not supported yet: ${error.detail}`
              : error.message;
          const finalError = `Could not refresh nearby pull request updates; reporting the last observed match. ${message.slice(0, 1800)}`;
          for (const row of group.pending) {
            yield* sql`
              UPDATE pull_request_watches
              SET last_error = ${message.slice(0, 2000)}, updated_at = ${nowIso}
              WHERE watch_id = ${row.watch_id} AND status = 'pending'
            `.pipe(
              Effect.mapError((cause) =>
                watchError(
                  `Could not record pull request watch error: ${cause}`,
                  PullRequestWatchId.make(row.watch_id),
                ),
              ),
            );
          }
          for (const row of group.collecting) {
            const watchId = PullRequestWatchId.make(row.watch_id);
            const current = yield* findRow(watchId);
            if (current === null || current.matched_json === null) continue;
            const first = yield* parseMatchedJson(current.matched_json, watchId);
            yield* freezeCollectingRow(
              current,
              appendPayloadNote(first, finalError),
              undefined,
              finalError,
            );
          }
          return;
        }
        const next = observation.success;
        for (const row of group.pending) yield* processPendingRow(row, next);
        for (const row of group.collecting) yield* processCollectingRow(row, next);
      });

    const pollDueWatches = (): Effect.Effect<void, PullRequestWatchError> =>
      Effect.gen(function* () {
        // Once per process: repair roster entries for watches that survived
        // a restart or were registered by an older server version. Watches
        // outlive provider processes, so their Waiting signal must be
        // restored even when no poll row is due.
        if (!(yield* Ref.getAndSet(rosterBackfilled, true))) {
          const stragglers = yield* sql<Pick<PullRequestWatchRow, "thread_id" | "project_id">>`
            SELECT DISTINCT thread_id, project_id FROM pull_request_watches
            WHERE status IN ('pending', 'matched')
          `.pipe(
            Effect.mapError((cause) =>
              watchError(`Could not list pull request watch threads: ${cause}`),
            ),
          );
          for (const straggler of stragglers) {
            yield* syncThreadWatchRoster(
              ThreadId.make(straggler.thread_id),
              ProjectId.make(straggler.project_id),
            );
          }
        }
        // TestClock-driven time (not Date.now) so poll tests stay deterministic.
        const now = yield* DateTime.now;
        const cutoff = iso(DateTime.subtract(now, { seconds: POLL_INTERVAL_MS / 1000 }));
        const nowIso = iso(now);
        const rows = yield* sql<PullRequestWatchRow>`
          SELECT * FROM pull_request_watches
          WHERE (
            (status = 'pending' AND (last_polled_at IS NULL OR last_polled_at <= ${cutoff}))
            OR (
              status = 'matched'
              AND (
                (match_deadline_at IS NOT NULL AND match_deadline_at <= ${nowIso})
                OR (match_deadline_at IS NULL AND (last_polled_at IS NULL OR last_polled_at <= ${cutoff}))
              )
            )
            OR (
              status = 'closed'
              AND delivered_at IS NULL
              AND matched_json IS NOT NULL
              AND (last_polled_at IS NULL OR last_polled_at <= ${cutoff})
            )
          )
          ORDER BY last_polled_at ASC NULLS FIRST, watch_id ASC
          LIMIT ${POLL_BATCH_LIMIT}
        `.pipe(
          Effect.mapError((cause) => watchError(`Could not poll pull request watches: ${cause}`)),
        );
        if (rows.length > 0) {
          yield* sql`
            UPDATE pull_request_watches
            SET last_polled_at = ${nowIso}
            WHERE watch_id IN ${sql.in(rows.map((row) => row.watch_id))}
          `.pipe(
            Effect.mapError((cause) => watchError(`Could not poll pull request watches: ${cause}`)),
          );
        }
        // Recovery first, without any host read: every row with a frozen
        // payload and no receipt redrives its stable ids (idempotent).
        const recoverable = rows.filter(
          (row) =>
            row.matched_json !== null &&
            row.delivered_at === null &&
            row.match_deadline_at === null &&
            (row.status === "matched" || row.status === "closed"),
        );
        for (const row of recoverable) {
          yield* deliverPayload(row);
        }
        // Pending rows and collecting rows share one observation read per PR.
        const pending = rows.filter((row) => row.status === "pending");
        const collecting = rows.filter(
          (row) =>
            row.status === "matched" &&
            row.match_deadline_at !== null &&
            row.match_deadline_at <= nowIso,
        );
        const groups = new Map<
          string,
          {
            readonly pending: Array<PullRequestWatchRow>;
            readonly collecting: Array<PullRequestWatchRow>;
          }
        >();
        for (const row of [...pending, ...collecting]) {
          const key = `${row.project_id}\n${canonicalHost(row.host)}\n${row.repository.toLowerCase()}\n${row.number}`;
          const group = groups.get(key);
          if (group === undefined) {
            groups.set(key, {
              pending: row.status === "pending" ? [row] : [],
              collecting: row.status === "matched" ? [row] : [],
            });
          } else if (row.status === "pending") {
            group.pending.push(row);
          } else {
            group.collecting.push(row);
          }
        }
        for (const group of groups.values()) {
          yield* pollGroup(group);
        }
      });

    const ensureThreadPullRequestLink = (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly host: string;
      readonly repository: string;
      readonly number: number;
      readonly url?: string;
      readonly watchId: PullRequestWatchId;
    }): Effect.Effect<void, PullRequestWatchError> =>
      linkLock.withPermits(1)(
        Effect.gen(function* () {
          const projection = yield* threadManagement
            .getProjectThread({ projectId: input.projectId, threadId: input.threadId })
            .pipe(
              Effect.mapError((cause) =>
                watchError(`Could not validate pull request watch thread: ${cause}`, input.watchId),
              ),
            );
          if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
            return yield* watchError(
              `Thread ${input.threadId} is not available for a pull request watch.`,
              input.watchId,
            );
          }

          const key = normalizeThreadPullRequestKey({
            host: input.host,
            repository: input.repository,
            number: input.number,
          });
          const links = threadPullRequestsOf(projection.thread);
          if (
            visibleThreadPullRequests(links).some((link) => threadPullRequestKeysEqual(link, key))
          ) {
            return;
          }

          const url =
            input.url?.trim() ||
            (input.host === "github.com"
              ? `https://${input.host}/${key.repository}/pull/${input.number}`
              : null);
          if (url === null) {
            return yield* watchError(
              "A pull request URL is required for non-GitHub hosts.",
              input.watchId,
            );
          }
          // Dispatch is the v2 receipt boundary. A failed dispatch leaves the
          // durable watch row intact; a retry with its clientRequestId reaches
          // this seam again and repairs the missing membership.
          const commandUuid = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) =>
              watchError(`Could not allocate pull request link command: ${cause}`, input.watchId),
            ),
          );
          yield* threadManagement
            .dispatch({
              type: "thread.pull-request.link",
              // The projection check supplies idempotency. A fresh command id
              // is intentional: a later registration must relink after a user
              // explicitly unlinks the PR, while concurrent calls are serialized.
              commandId: CommandId.make(`server:pull-request-watch-link:${commandUuid}`),
              threadId: input.threadId,
              host: key.host,
              repository: key.repository,
              number: key.number,
              url,
              source: "agent",
            })
            .pipe(
              Effect.mapError((cause) =>
                watchError(`Could not link pull request to thread: ${cause}`, input.watchId),
              ),
            );
        }),
      );

    const watch: PullRequestWatchService["Service"]["watch"] = (input) =>
      Effect.gen(function* () {
        // Resolve the default exactly once so idempotency, matching, and the
        // stored row all use the same event set.
        const events = [...new Set(input.events ?? DEFAULT_PULL_REQUEST_WATCH_EVENTS)];
        if (events.length === 0) {
          return yield* watchError(
            "Watch at least one event: check_failed, checks_finished, or review_feedback.",
          );
        }
        const uuid = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) =>
            watchError(`Could not generate watch id: ${cause}`, undefined),
          ),
        );
        const repository = input.repository.trim();
        if (repository.length === 0) {
          return yield* watchError("Watch a pull request repository as owner/repo.");
        }
        if (!Number.isInteger(input.number) || input.number <= 0) {
          return yield* watchError("Watch a pull request with a positive number.");
        }
        // Validate scope before reading the host or mutating either durable
        // watch state or the v2 thread projection.
        const scopedThread = yield* threadManagement
          .getProjectThread({ projectId: input.projectId, threadId: input.threadId })
          .pipe(
            Effect.mapError((cause) =>
              watchError(`Could not validate pull request watch thread: ${cause}`),
            ),
          );
        if (scopedThread.thread.archivedAt !== null || scopedThread.thread.deletedAt !== null) {
          return yield* watchError(
            `Thread ${input.threadId} is not available for a pull request watch.`,
          );
        }
        // Stored and passed canonically: an omitted host IS github.com, so
        // rearm comparison, poll grouping, and observer reads all agree.
        const host = canonicalHost(input.host);
        const watchId = PullRequestWatchId.make(
          input.clientRequestId !== undefined
            ? `pull-request-watch:${input.threadId}:${input.clientRequestId}`
            : `pull-request-watch:${uuid}`,
        );
        const sameParams = (
          row: PullRequestWatchRow,
        ): Effect.Effect<boolean, PullRequestWatchError> =>
          decodeEventsJson(row.events_json, watchId).pipe(
            Effect.map(
              (stored) =>
                row.repository.toLowerCase() === repository.toLowerCase() &&
                row.number === input.number &&
                canonicalHost(row.host) === canonicalHost(host) &&
                [...new Set(stored)].sort().join(",") === [...events].sort().join(","),
            ),
            Effect.catch(() => Effect.succeed(false)),
          );
        const existing = yield* findRow(watchId);
        if (existing !== null) {
          if (existing.project_id !== input.projectId || existing.thread_id !== input.threadId) {
            return yield* watchError(`Pull request watch ${watchId} was not found.`, watchId);
          }
          if (!(yield* sameParams(existing))) {
            return yield* watchError(
              `clientRequestId ${input.clientRequestId ?? "(none)"} is already used by a watch on a different pull request or event set; retry with a fresh key.`,
              watchId,
            );
          }
          yield* ensureThreadPullRequestLink({
            projectId: input.projectId,
            threadId: input.threadId,
            host,
            repository,
            number: input.number,
            ...(input.url === undefined ? {} : { url: input.url }),
            watchId,
          });
          yield* syncThreadWatchRoster(input.threadId, input.projectId);
          return yield* toStatus(existing);
        }
        if (host !== "github.com" && !input.url?.trim()) {
          return yield* watchError("A pull request URL is required for non-GitHub hosts.", watchId);
        }
        let cursor: PullRequestWatchObservation | null = null;
        let cursorError: string | null = null;
        // A rearmed watch skips initial evaluation: its cursor already fired,
        // so only new transitions may fire again. A null inherited cursor
        // (the previous watch never observed) takes the initial evaluation
        // path like a fresh watch instead of parking blind.
        let allowImmediate = input.previousWatchId === undefined;
        const freshRead = Effect.gen(function* () {
          const read = yield* observer
            .read({
              projectId: input.projectId,
              repository,
              number: input.number,
              host,
            })
            .pipe(Effect.result);
          if (Result.isSuccess(read)) {
            cursor = read.success;
          } else if (read.failure.reason === "unsupported" || read.failure.reason === "not-found") {
            return yield* watchError(read.failure.message, watchId);
          } else {
            cursorError = read.failure.message.slice(0, 2000);
          }
        });
        if (input.previousWatchId !== undefined) {
          // Gap-free rearm: continue from what the previous watch last saw.
          // The cursor is consumed only from the same thread, project, and
          // PR (repository, number, and canonical host all match).
          const previous = yield* loadScopedRow(
            input.projectId,
            input.threadId,
            input.previousWatchId,
          ).pipe(
            Effect.mapError(() =>
              watchError("Previous watch not found for gap-free rearm.", watchId),
            ),
          );
          if (
            previous.repository.toLowerCase() !== repository.toLowerCase() ||
            previous.number !== input.number ||
            canonicalHost(previous.host) !== canonicalHost(host)
          ) {
            return yield* watchError(
              "Previous watch is for a different pull request; rearm with a matching PR.",
              watchId,
            );
          }
          cursor = yield* decodeObservationJson(previous.last_observation_json);
          if (cursor === null) {
            allowImmediate = true;
            yield* freshRead;
          }
        } else {
          yield* freshRead;
        }
        const now = yield* DateTime.now;
        const nowIso = iso(now);
        // Initial-register evaluation against the snapshot itself: a red or
        // already-finished rollup matches now instead of parking forever.
        // review_feedback with a null previous never replays (observer
        // semantics), so existing comments become the cursor silently.
        const immediate =
          cursor !== null && allowImmediate ? buildEventPayload(null, cursor, events) : null;
        const closeReason =
          cursor !== null && (cursor.state === "closed" || cursor.state === "merged")
            ? cursor.state
            : null;
        const status = closeReason !== null ? "closed" : immediate !== null ? "matched" : "pending";
        const matched: MatchedPayload | null =
          closeReason !== null && cursor !== null
            ? closePayload(closeReason, cursor.headSha)
            : immediate;
        const matchDeadlineAt =
          immediate !== null && closeReason === null
            ? iso(DateTime.add(now, { milliseconds: COALESCE_WINDOW_MS }))
            : null;
        const inserted = yield* sql<{ watch_id: string }>`
          INSERT INTO pull_request_watches (
            watch_id, thread_id, project_id, repository, number, host, url,
            events_json, status, last_observation_json, matched_json,
            match_deadline_at, last_error, last_polled_at, created_at, updated_at, delivered_at
          )
          VALUES (
            ${watchId}, ${input.threadId}, ${input.projectId}, ${repository},
            ${input.number}, ${host}, ${input.url ?? null},
            ${encodeEvents(events)}, ${status},
            ${cursor === null ? null : encodeObservation(cursor)},
            ${matched === null ? null : encodeMatched(matched)},
            ${matchDeadlineAt},
            ${cursorError},
            NULL, ${nowIso}, ${nowIso}, NULL
          )
          ON CONFLICT (watch_id) DO NOTHING
          RETURNING watch_id
        `.pipe(
          Effect.mapError((cause) =>
            watchError(`Could not save pull request watch: ${cause}`, watchId),
          ),
        );
        if (inserted.length === 0) {
          // Concurrent insert loser: return the winner row as-is, whatever
          // state it is in — even without a frozen payload yet — but still
          // reject conflicting params under a reused idempotency key.
          const winner = yield* findRow(watchId);
          if (
            winner === null ||
            winner.project_id !== input.projectId ||
            winner.thread_id !== input.threadId
          ) {
            return yield* watchError(`Pull request watch ${watchId} was not found.`, watchId);
          }
          if (!(yield* sameParams(winner))) {
            return yield* watchError(
              `clientRequestId ${input.clientRequestId ?? "(none)"} is already used by a watch on a different pull request or event set; retry with a fresh key.`,
              watchId,
            );
          }
          yield* ensureThreadPullRequestLink({
            projectId: input.projectId,
            threadId: input.threadId,
            host,
            repository,
            number: input.number,
            ...(input.url === undefined ? {} : { url: input.url }),
            watchId,
          });
          yield* syncThreadWatchRoster(input.threadId, input.projectId);
          return yield* toStatus(winner);
        }
        const row = yield* findRow(watchId);
        if (row === null) {
          return yield* watchError("Could not save pull request watch.", watchId);
        }
        yield* ensureThreadPullRequestLink({
          projectId: input.projectId,
          threadId: input.threadId,
          host,
          repository,
          number: input.number,
          ...(input.url === undefined ? {} : { url: input.url }),
          watchId,
        });
        if (closeReason !== null && matched !== null) {
          yield* deliverPayload(row);
          const current = yield* findRow(watchId);
          if (current === null) {
            return yield* watchError("Could not save pull request watch.", watchId);
          }
          yield* syncThreadWatchRoster(input.threadId, input.projectId);
          return yield* toStatus(current);
        }
        yield* syncThreadWatchRoster(input.threadId, input.projectId);
        return yield* toStatus(row);
      });

    const list: PullRequestWatchService["Service"]["list"] = (input) =>
      Effect.gen(function* () {
        const rows = yield* sql<PullRequestWatchRow>`
          SELECT * FROM pull_request_watches
          WHERE thread_id = ${input.threadId} AND project_id = ${input.projectId}
          ORDER BY updated_at DESC, watch_id ASC
        `.pipe(
          Effect.mapError((cause) => watchError(`Could not list pull request watches: ${cause}`)),
        );
        const watches: Array<PullRequestWatchStatus> = [];
        for (const row of rows) {
          watches.push(yield* toStatus(row));
        }
        return { watches };
      });

    const cancel: PullRequestWatchService["Service"]["cancel"] = (input) =>
      deliveryLock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* loadScopedRow(input.projectId, input.threadId, input.watchId);
          const nowIso = iso(yield* localNow);
          yield* sql`
            UPDATE pull_request_watches
            SET status = 'cancelled', matched_json = NULL, updated_at = ${nowIso}
            WHERE watch_id = ${input.watchId} AND status IN ('pending', 'matched')
          `.pipe(
            Effect.mapError((cause) =>
              watchError(`Could not cancel pull request watch: ${cause}`, input.watchId),
            ),
          );
          const current = yield* findRow(input.watchId);
          yield* syncThreadWatchRoster(input.threadId, input.projectId);
          return yield* toStatus(current ?? row);
        }),
      );

    return PullRequestWatchService.of({ watch, list, cancel, pollDueWatches });
  }),
);

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* PullRequestWatchService;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("pull-request-watches", service.pollDueWatches());
  }),
);
