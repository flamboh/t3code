import {
  CommandId,
  INDEFINITE_SNOOZE_UNTIL,
  type OrchestrationV2ThreadShell,
  ProjectId,
  PullRequestWatchError,
  PullRequestWatchId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  matchesWatchEvent,
  PullRequestWatchObservation,
  PullRequestWatchObserver,
} from "./PullRequestWatchObservation.ts";

export const WAKE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
export const PENDING_SNOOZE_TIMEOUT_MS = 60 * 60 * 1000;

export interface PullRequestAutoSnoozeArmInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly watchId: PullRequestWatchId;
  readonly repository: string;
  readonly number: number;
  readonly host: string;
  readonly url: string | null;
  readonly observation: PullRequestWatchObservation;
  readonly deliveredAt: string;
}

export class PullRequestAutoSnoozeService extends Context.Service<
  PullRequestAutoSnoozeService,
  {
    readonly arm: (
      input: PullRequestAutoSnoozeArmInput,
    ) => Effect.Effect<void, PullRequestWatchError>;
    readonly sweep: () => Effect.Effect<void, PullRequestWatchError>;
  }
>()("t3/pullRequest/PullRequestAutoSnooze/PullRequestAutoSnoozeService") {}

interface AutoSnoozeRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly watch_id: string;
  readonly repository: string;
  readonly number: number;
  readonly host: string | null;
  readonly url: string | null;
  readonly state: "pending" | "snoozed";
  readonly observation_json: string;
  readonly snoozed_at: string | null;
  readonly next_check_at: string | null;
  readonly created_at: string;
}

const ObservationJson = Schema.fromJsonString(PullRequestWatchObservation);
const decodeObservation = Schema.decodeUnknownEffect(ObservationJson);
const encodeObservation = Schema.encodeSync(ObservationJson);

const iso = (value: DateTime.DateTime): string => DateTime.formatIso(DateTime.toUtc(value));
const millis = (value: DateTime.Utc | null | undefined): number | null =>
  value == null ? null : DateTime.toEpochMillis(value);
const autoSnoozeError = (message: string) => new PullRequestWatchError({ message });

type PendingDecision = "wait" | "snooze" | "drop";

export function decidePendingSnooze(
  thread: OrchestrationV2ThreadShell | null,
  armedAtMs: number,
  nowMs: number,
): PendingDecision {
  if (thread === null || thread.archivedAt !== null || thread.pinnedAt != null) return "drop";
  if (thread.pendingRuntimeRequest !== null) return "drop";
  const snoozedUntilMs = millis(thread.snoozedUntil);
  if (snoozedUntilMs !== null && snoozedUntilMs > nowMs) return "drop";
  const completedAtMs = millis(thread.latestRunCompletedAt);
  const replied = completedAtMs !== null && completedAtMs >= armedAtMs;
  if (thread.activityRunStatus != null || !replied) {
    return nowMs - armedAtMs > PENDING_SNOOZE_TIMEOUT_MS ? "drop" : "wait";
  }
  return thread.status === "idle" || thread.status === "completed" ? "snooze" : "drop";
}

export function stillAutoSnoozed(
  thread: OrchestrationV2ThreadShell | null,
  snoozedAt: string | null,
  nowMs: number,
): boolean {
  if (thread === null || thread.archivedAt !== null || snoozedAt === null) return false;
  const snoozedAtMs = millis(thread.snoozedAt);
  const snoozedUntilMs = millis(thread.snoozedUntil);
  if (snoozedAtMs === null || snoozedUntilMs === null) return false;
  if (snoozedAtMs !== Date.parse(snoozedAt) || snoozedUntilMs <= nowMs) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  const completedAtMs = millis(thread.latestRunCompletedAt);
  return completedAtMs === null || completedAtMs <= snoozedAtMs;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const observer = yield* PullRequestWatchObserver;
  const threads = yield* ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;

  const deleteRow = (threadId: string) =>
    sql`DELETE FROM pull_request_auto_snoozes WHERE thread_id = ${threadId}`.pipe(
      Effect.mapError((cause) =>
        autoSnoozeError(`Could not clear pull request auto-snooze: ${cause}`),
      ),
    );

  const readShell = (threadId: string) =>
    threads
      .getThreadShell(ThreadId.make(threadId))
      .pipe(Effect.mapError((cause) => autoSnoozeError(`Could not read thread: ${cause.message}`)));

  const arm: PullRequestAutoSnoozeService["Service"]["arm"] = (input) =>
    Effect.gen(function* () {
      const preference = (yield* settings.getSettings.pipe(
        Effect.mapError((cause) => autoSnoozeError(`Could not read settings: ${cause}`)),
      )).snoozeGreenPullRequests;
      if (preference === null) return;
      const nowIso = iso(yield* DateTime.now);
      yield* sql`
        INSERT OR REPLACE INTO pull_request_auto_snoozes (
          thread_id, project_id, watch_id, repository, number, host, url, state,
          observation_json, snoozed_at, next_check_at, last_error, created_at, updated_at
        ) VALUES (
          ${input.threadId}, ${input.projectId}, ${input.watchId}, ${input.repository},
          ${input.number}, ${input.host}, ${input.url}, 'pending', ${encodeObservation(input.observation)},
          NULL, NULL, NULL, ${input.deliveredAt}, ${nowIso}
        )
      `.pipe(
        Effect.mapError((cause) =>
          autoSnoozeError(`Could not arm pull request auto-snooze: ${cause}`),
        ),
      );
    });

  const settlePending = (row: AutoSnoozeRow) =>
    Effect.gen(function* () {
      const preference = (yield* settings.getSettings.pipe(
        Effect.mapError((cause) => autoSnoozeError(`Could not read settings: ${cause}`)),
      )).snoozeGreenPullRequests;
      if (preference === null) return yield* deleteRow(row.thread_id);
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const thread = yield* readShell(row.thread_id);
      const decision = decidePendingSnooze(thread, Date.parse(row.created_at), nowMs);
      if (decision === "wait") return;
      if (decision === "drop") return yield* deleteRow(row.thread_id);
      const snoozedUntil =
        preference === "indefinitely"
          ? INDEFINITE_SNOOZE_UNTIL
          : iso(DateTime.add(now, { hours: preference }));
      const dispatched = yield* threads
        .dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(
            `pull-request-auto-snooze:${row.watch_id}:${millis(thread?.latestRunCompletedAt)}`,
          ),
          threadId: ThreadId.make(row.thread_id),
          snoozedUntil,
          pullRequest: { repository: row.repository, number: row.number, url: row.url },
        })
        .pipe(Effect.result);
      if (!Result.isSuccess(dispatched)) {
        return yield* sql`
          UPDATE pull_request_auto_snoozes
          SET last_error = ${String(dispatched.failure.message).slice(0, 2000)}, updated_at = ${iso(now)}
          WHERE thread_id = ${row.thread_id}
        `.pipe(
          Effect.mapError((cause) =>
            autoSnoozeError(`Could not record auto-snooze error: ${cause}`),
          ),
        );
      }
      const snoozed = yield* readShell(row.thread_id);
      const snoozedAt = snoozed?.snoozedAt == null ? null : iso(snoozed.snoozedAt);
      if (snoozedAt === null) return yield* deleteRow(row.thread_id);
      yield* sql`
        UPDATE pull_request_auto_snoozes
        SET state = 'snoozed', snoozed_at = ${snoozedAt},
            next_check_at = ${iso(DateTime.add(now, { milliseconds: WAKE_CHECK_INTERVAL_MS }))},
            last_error = NULL, updated_at = ${iso(now)}
        WHERE thread_id = ${row.thread_id}
      `.pipe(Effect.mapError((cause) => autoSnoozeError(`Could not record auto-snooze: ${cause}`)));
    });

  const checkSnoozed = (row: AutoSnoozeRow) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowIso = iso(now);
      const thread = yield* readShell(row.thread_id);
      if (!stillAutoSnoozed(thread, row.snoozed_at, DateTime.toEpochMillis(now))) {
        return yield* deleteRow(row.thread_id);
      }
      const nextCheckAt = iso(DateTime.add(now, { milliseconds: WAKE_CHECK_INTERVAL_MS }));
      const read = yield* observer
        .read({
          projectId: ProjectId.make(row.project_id),
          repository: row.repository,
          number: row.number,
          ...(row.host === null ? {} : { host: row.host }),
          refresh: true,
        })
        .pipe(Effect.result);
      if (!Result.isSuccess(read)) {
        if (read.failure.reason === "not-found") return yield* deleteRow(row.thread_id);
        return yield* sql`
          UPDATE pull_request_auto_snoozes
          SET next_check_at = ${nextCheckAt}, last_error = ${read.failure.message.slice(0, 2000)},
              updated_at = ${nowIso}
          WHERE thread_id = ${row.thread_id}
        `.pipe(
          Effect.mapError((cause) =>
            autoSnoozeError(`Could not record auto-snooze error: ${cause}`),
          ),
        );
      }
      const next = read.success;
      if (next.state !== "open") return yield* deleteRow(row.thread_id);
      const previous = yield* decodeObservation(row.observation_json).pipe(
        Effect.mapError(() => autoSnoozeError("Could not decode auto-snooze cursor.")),
      );
      const wakeReasons = (["check_failed", "review_feedback"] as const).filter((event) =>
        matchesWatchEvent({ previous, next, event }),
      );
      if (wakeReasons.length > 0) {
        yield* threads
          .dispatch({
            type: "thread.unsnooze",
            commandId: CommandId.make(`pull-request-auto-wake:${row.watch_id}:${row.snoozed_at}`),
            threadId: ThreadId.make(row.thread_id),
            reason: "pull-request",
            wakeReasons,
          })
          .pipe(
            Effect.mapError((cause) =>
              autoSnoozeError(`Could not wake auto-snoozed thread: ${cause.message}`),
            ),
          );
        return yield* deleteRow(row.thread_id);
      }
      const cursor = next.feedbackComplete
        ? next
        : { ...next, feedback: previous.feedback, feedbackComplete: previous.feedbackComplete };
      yield* sql`
        UPDATE pull_request_auto_snoozes
        SET observation_json = ${encodeObservation(cursor)}, next_check_at = ${nextCheckAt},
            last_error = NULL, updated_at = ${nowIso}
        WHERE thread_id = ${row.thread_id}
      `.pipe(
        Effect.mapError((cause) => autoSnoozeError(`Could not advance auto-snooze: ${cause}`)),
      );
    });

  const sweep: PullRequestAutoSnoozeService["Service"]["sweep"] = () =>
    Effect.gen(function* () {
      const nowIso = iso(yield* DateTime.now);
      const rows = yield* sql<AutoSnoozeRow>`
        SELECT * FROM pull_request_auto_snoozes
        WHERE state = 'pending' OR next_check_at <= ${nowIso}
        ORDER BY updated_at ASC
      `.pipe(Effect.mapError((cause) => autoSnoozeError(`Could not list auto-snoozes: ${cause}`)));
      yield* Effect.forEach(
        rows,
        (row) =>
          (row.state === "pending" ? settlePending(row) : checkSnoozed(row)).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("pull request auto-snooze skipped", {
                    threadId: row.thread_id,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        { discard: true },
      );
    });

  return PullRequestAutoSnoozeService.of({ arm, sweep });
});

export const layer = Layer.effect(PullRequestAutoSnoozeService, make);

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* PullRequestAutoSnoozeService;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("pull-request-auto-snooze", service.sweep());
  }),
);
