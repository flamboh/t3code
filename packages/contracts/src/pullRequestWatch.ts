import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const PullRequestWatchId = Schema.String.pipe(Schema.brand("PullRequestWatchId")).annotate({
  description: "Durable one-shot pull request watch id.",
});
export type PullRequestWatchId = typeof PullRequestWatchId.Type;

/** One-shot triggers. Omit the filter to watch CI results and review feedback. */
export const PullRequestWatchEvent = Schema.Literals([
  "check_failed",
  "checks_finished",
  "review_feedback",
]);
export type PullRequestWatchEvent = typeof PullRequestWatchEvent.Type;

export const DEFAULT_PULL_REQUEST_WATCH_EVENTS = [
  "check_failed",
  "checks_finished",
  "review_feedback",
] as const satisfies ReadonlyArray<PullRequestWatchEvent>;

/**
 * `matched` means a condition hit and nearby updates are being collected
 * or delivery is in flight. A restarted server resumes collection or delivery
 * with the same stable command/message ids, so recovery never duplicates.
 */
export const PullRequestWatchStatusValue = Schema.Literals([
  "pending",
  "matched",
  "delivered",
  "cancelled",
  "closed",
]);
export type PullRequestWatchStatusValue = typeof PullRequestWatchStatusValue.Type;

export const PullRequestWatchStatus = Schema.Struct({
  watchId: PullRequestWatchId,
  threadId: ThreadId,
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  host: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  events: Schema.Array(PullRequestWatchEvent),
  status: PullRequestWatchStatusValue,
  /** Last observation/rate-limit/auth failure. Never marks the watch successful. */
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deliveredAt: Schema.NullOr(IsoDateTime),
});
export type PullRequestWatchStatus = typeof PullRequestWatchStatus.Type;

export class PullRequestWatchError extends Schema.TaggedError<PullRequestWatchError>()(
  "PullRequestWatchError",
  {
    message: Schema.String,
    watchId: Schema.optional(PullRequestWatchId),
  },
) {}

export const INDEFINITE_SNOOZE_UNTIL = "9999-12-31T00:00:00.000Z";
