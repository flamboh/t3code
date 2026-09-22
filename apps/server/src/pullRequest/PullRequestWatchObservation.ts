import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  PullRequestState,
  PullRequestWatchEvent,
  TrimmedNonEmptyString,
  type ProjectId,
  type PullRequestActivity,
  type PullRequestCheck,
} from "@t3tools/contracts";

import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import type { GitHubPullRequestCore } from "./gitHubPullRequestJson.ts";
import { PullRequestService } from "./PullRequestService.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";

/** What a one-shot pull request watch compares across reads. */
export const PullRequestWatchCheckState = Schema.Literals([
  "pending",
  "passed",
  "failed",
  "cancelled",
  "skipped",
]);
export type PullRequestWatchCheckState = typeof PullRequestWatchCheckState.Type;

export const PullRequestWatchCheck = Schema.Struct({
  // Hosts report no stable check id, so the name is the identity.
  id: TrimmedNonEmptyString,
  name: Schema.String,
  state: PullRequestWatchCheckState,
  url: Schema.NullOr(Schema.String),
});
export type PullRequestWatchCheck = typeof PullRequestWatchCheck.Type;

export const PullRequestWatchFeedbackItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  // Host reads report no edit time, so edits surface as a body change on the
  // same id; the matcher compares both fields.
  updatedAt: IsoDateTime,
  body: Schema.String,
  url: Schema.NullOr(Schema.String),
});
export type PullRequestWatchFeedbackItem = typeof PullRequestWatchFeedbackItem.Type;

export const PullRequestWatchObservation = Schema.Struct({
  headSha: TrimmedNonEmptyString,
  state: PullRequestState,
  checks: Schema.Array(PullRequestWatchCheck),
  feedback: Schema.Array(PullRequestWatchFeedbackItem),
  // False when the host was not read to the end. A worker must re-read rather
  // than store such an observation as its baseline, or remarks posted in the
  // gap are silently dropped.
  feedbackComplete: Schema.Boolean,
});
export type PullRequestWatchObservation = typeof PullRequestWatchObservation.Type;

/** Why a watch read failed, in the worker's vocabulary. */
export class PullRequestWatchObservationError extends Schema.TaggedError<PullRequestWatchObservationError>()(
  "PullRequestWatchObservationError",
  {
    reason: Schema.Literals(["auth", "rate-limit", "not-found", "transient", "unsupported"]),
    detail: Schema.String,
    retryAt: Schema.optional(Schema.Finite),
  },
) {
  override get message(): string {
    return `Pull request watch read failed (${this.reason}): ${this.detail}`;
  }
}

export interface PullRequestWatchReadInput {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly host?: string | undefined;
  /** Final coalescing read must include feedback newer than the UI cache. */
  readonly refresh?: boolean;
}

const TERMINAL_CHECK_STATES: ReadonlySet<PullRequestWatchCheckState> = new Set([
  "passed",
  "failed",
  "cancelled",
  "skipped",
]);

const isTerminalCheck = (check: Pick<PullRequestWatchCheck, "state">): boolean =>
  TERMINAL_CHECK_STATES.has(check.state);

// `action-required` (awaiting maintainer approval) has not run: pending.
// `neutral` ran without failing: terminal, but not a pass or a failure.
export function toWatchCheckState(status: PullRequestCheck["status"]): PullRequestWatchCheckState {
  switch (status) {
    case "pending":
    case "action-required":
      return "pending";
    case "success":
      return "passed";
    case "failure":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "skipped":
    case "neutral":
      return "skipped";
  }
}

export function toWatchChecks(
  checks: ReadonlyArray<PullRequestCheck>,
): Array<PullRequestWatchCheck> {
  return checks.map((check) => ({
    id: check.name,
    name: check.name,
    state: toWatchCheckState(check.status),
    url: check.url,
  }));
}

function toWatchFeedbackItem(input: {
  readonly id: string;
  readonly createdAt: string;
  readonly body: string;
  readonly url: string | null;
}): PullRequestWatchFeedbackItem | null {
  const id = input.id.trim();
  if (id.length === 0) return null;
  return { id, updatedAt: input.createdAt, body: input.body, url: input.url };
}

// Flat comments plus each inline thread's own comments, de-duplicated by id.
export function toWatchFeedback(
  activity: PullRequestActivity,
): Array<PullRequestWatchFeedbackItem> {
  const items = new Map<string, PullRequestWatchFeedbackItem>();
  const add = (item: PullRequestWatchFeedbackItem | null) => {
    if (item !== null && !items.has(item.id)) items.set(item.id, item);
  };
  for (const comment of activity.comments) {
    add(toWatchFeedbackItem(comment));
  }
  for (const thread of activity.reviewThreads) {
    for (const comment of thread.comments) {
      add(toWatchFeedbackItem(comment));
    }
  }
  return [...items.values()];
}

// No top-level cursor field exists on this shape — the thread walk already
// folds its page cursor into `commentsTruncated` (verified against provider
// and contract types). Backstop: the host's own count must not exceed the
// unique remarks held; a surplus is missing data however the flags read.
export function isFeedbackComplete(activity: PullRequestActivity): boolean {
  if (activity.commentsTruncated) return false;
  if (activity.reviewThreads.some((thread) => thread.nextCommentsCursor !== undefined)) {
    return false;
  }
  const ids = new Set<string>();
  for (const comment of activity.comments) ids.add(comment.id);
  for (const thread of activity.reviewThreads) {
    for (const comment of thread.comments) ids.add(comment.id);
  }
  return activity.commentCount <= ids.size;
}

// Identity plus verdict plus location, so a rerun attempt under a new run URL
// reads as a new event even where the check id and its failure persist.
const failedCheckKey = (check: PullRequestWatchCheck): string => `${check.id}\n${check.url ?? ""}`;

const failedCheckKeys = (observation: PullRequestWatchObservation): ReadonlySet<string> =>
  new Set(observation.checks.filter((check) => check.state === "failed").map(failedCheckKey));

const isAllTerminal = (observation: PullRequestWatchObservation): boolean =>
  observation.checks.length > 0 && observation.checks.every(isTerminalCheck);

// The rollup as an order-insensitive multiset: a host reordering rows is not
// a change, while a new verdict, a new row, or a new run URL is.
const sortedCheckSignatures = (observation: PullRequestWatchObservation): ReadonlyArray<string> =>
  observation.checks.map((check) => `${check.id}\n${check.state}\n${check.url ?? ""}`).toSorted();

const sameCheckRollup = (
  previous: PullRequestWatchObservation,
  next: PullRequestWatchObservation,
): boolean => {
  const before = sortedCheckSignatures(previous);
  const after = sortedCheckSignatures(next);
  return (
    before.length === after.length && before.every((signature, index) => signature === after[index])
  );
};

const feedbackById = (
  observation: PullRequestWatchObservation,
): ReadonlyMap<string, PullRequestWatchFeedbackItem> =>
  new Map(observation.feedback.map((item) => [item.id, item]));

export interface MatchesWatchEventInput {
  // Null when the watch just registered and `next` is its baseline read.
  // CI events judge the baseline itself — a red or already-finished rollup
  // matches immediately, since parking after a fast CI run would wait forever —
  // while `review_feedback` never replays the existing conversation.
  readonly previous: PullRequestWatchObservation | null;
  readonly next: PullRequestWatchObservation;
  readonly event: PullRequestWatchEvent;
}

/**
 * Whether one awaited watch event fired between two observations.
 *
 * - `check_failed`: a failed check on `next` whose id-and-URL pair was not
 *   failed on `previous`. A persisting failure under an unchanged run URL does
 *   not wake repeatedly; a failure that clears and fails again, or a rerun
 *   attempt under a new run URL the poll never saw pending, is new and wakes
 *   again. A new head resets the comparison instead of carrying the old
 *   commit's failures over.
 * - `checks_finished`: `next` carries a nonempty, fully terminal rollup that
 *   differs from `previous` on the same head — a missed pending phase, a new
 *   verdict, a new row, or a new run URL all wake. An unchanged rollup does
 *   not, however terminal. Terminal is not success: failed and cancelled
 *   checks finish too. An empty check list is never success: CI may simply
 *   not have started.
 * - `review_feedback`: a remark id appears, or a known id carries a new body
 *   or timestamp (an edit). Needs both sides complete; a truncated read
 *   answers false and the worker re-reads instead of advancing its baseline.
 */
export function matchesWatchEvent(input: MatchesWatchEventInput): boolean {
  const { previous, next, event } = input;
  switch (event) {
    case "check_failed": {
      const before =
        previous !== null && previous.headSha === next.headSha
          ? failedCheckKeys(previous)
          : new Set<string>();
      for (const key of failedCheckKeys(next)) {
        if (!before.has(key)) return true;
      }
      return false;
    }
    case "checks_finished": {
      if (!isAllTerminal(next)) return false;
      if (previous === null || previous.headSha !== next.headSha) return true;
      if (!isAllTerminal(previous)) return true;
      return !sameCheckRollup(previous, next);
    }
    case "review_feedback": {
      if (previous === null || !previous.feedbackComplete || !next.feedbackComplete) return false;
      const before = feedbackById(previous);
      for (const item of next.feedback) {
        const known = before.get(item.id);
        if (known === undefined || known.body !== item.body || known.updatedAt !== item.updatedAt) {
          return true;
        }
      }
      return false;
    }
  }
}

const unsupportedHost = (provider: string, repository: string, number: number) =>
  new PullRequestWatchObservationError({
    reason: "unsupported",
    detail:
      `Change request ${repository}#${number} lives on ${provider}, which reports no robust ` +
      `commit identity for scoping CI to the current commit. Watching is supported on GitHub only.`,
  });

const transient = (operation: string, detail: string) =>
  new PullRequestWatchObservationError({ reason: "transient", detail: `${operation}: ${detail}` });

// Outages and request failures are transient; a signed-out tool is auth;
// an unknown project or host is unsupported.
function toObservationError(
  operation: string,
): (error: {
  readonly _tag: string;
  readonly reason?: string;
  readonly detail?: string;
}) => PullRequestWatchObservationError {
  return (error) => {
    if (error._tag === "PullRequestUnavailableError") {
      if (error.reason === "cli-unauthenticated") {
        return new PullRequestWatchObservationError({
          reason: "auth",
          detail: `${operation}: the host account is not signed in.`,
        });
      }
      if (error.reason === "provider-unsupported") {
        return new PullRequestWatchObservationError({
          reason: "unsupported",
          detail: `${operation}: this project has no supported pull request host.`,
        });
      }
      return transient(operation, "the pull request host could not be reached.");
    }
    return transient(operation, error.detail ?? "the pull request host could not be read.");
  };
}

// The head read runs outside the service's rate wrapper, so its own limits are
// mapped here; a 404 ends the watch rather than retrying a missing request.
function toHeadReadError(
  error: GitHubPullRequestCli.GitHubPullRequestCliError,
): PullRequestWatchObservationError {
  switch (error._tag) {
    case "GitHubCliAuthenticationError":
      return new PullRequestWatchObservationError({
        reason: "auth",
        detail: "readHead: the GitHub account is not signed in.",
      });
    case "GitHubCliRateLimitError":
    case "SourceControlRateLimitPausedError":
      return new PullRequestWatchObservationError({
        reason: "rate-limit",
        detail: "readHead: GitHub rate limit reached.",
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      });
    case "GitHubCliCommandError":
      return error.httpStatus === 404
        ? new PullRequestWatchObservationError({
            reason: "not-found",
            detail: "readHead: the pull request was not found on its host.",
          })
        : transient("readHead", error.detail);
    default:
      return transient("readHead", error.detail);
  }
}

// An explicit `host` wins; otherwise the detail's own URL names it — the same
// `owner/repo` exists on github.com and on Enterprise installs.
export function watchHeadHost(input: {
  readonly host?: string | undefined;
  readonly url: string;
}): string {
  const explicit = input.host?.trim().toLowerCase();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  try {
    const hostname = new URL(input.url).hostname.trim().toLowerCase();
    return hostname.length > 0 ? hostname : "github.com";
  } catch {
    return "github.com";
  }
}

export class PullRequestWatchObserver extends Context.Service<
  PullRequestWatchObserver,
  {
    /**
     * One observation for watch comparison. Identity and routing come from the
     * pull request service; head sha, state, and checks come from one GitHub
     * detail response, so the rollup can never belong to an older commit than
     * the sha beside it; remarks come from the service activity read.
     */
    readonly read: (
      input: PullRequestWatchReadInput,
    ) => Effect.Effect<PullRequestWatchObservation, PullRequestWatchObservationError>;
  }
>()("t3/pullRequest/PullRequestWatchObservation/PullRequestWatchObserver") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const service = yield* PullRequestService;
  const github = yield* GitHubPullRequestCli.GitHubPullRequestCli;
  const projects = yield* ProjectionProjectRepository;
  const enrichment = yield* ProjectEnrichmentService;

  const read: PullRequestWatchObserver["Service"]["read"] = Effect.fn(
    "PullRequestWatchObserver.read",
  )(function* (input: PullRequestWatchReadInput) {
    const project = yield* projects
      .getById({ projectId: input.projectId })
      .pipe(
        Effect.mapError(() => transient("readProject", "The watch project could not be read.")),
      );
    if (Option.isNone(project) || project.value.deletedAt !== null) {
      return yield* new PullRequestWatchObservationError({
        reason: "not-found",
        detail: "The watch project no longer exists.",
      });
    }
    // The UI's nonblocking metadata cache expires after one minute, exactly
    // the watch interval. Await resolution so every tick cannot hit a cold cache.
    yield* enrichment.awaitRepositoryIdentity(project.value.workspaceRoot);
    const ref = {
      projectId: input.projectId,
      repository: input.repository,
      number: input.number,
      ...(input.host === undefined ? {} : { host: input.host }),
    };
    if (input.refresh) yield* service.invalidate({ reference: ref });
    const detail = yield* service
      .detail({ ...ref, ...(input.refresh ? { allowStale: false } : {}) })
      .pipe(Effect.mapError(toObservationError("readDetail")));
    if (detail.provider !== "github") {
      return yield* unsupportedHost(detail.provider, detail.repository, detail.number);
    }
    const headInput = {
      cwd: detail.workspaceRoot,
      repository: detail.repository,
      host: watchHeadHost({ host: input.host, url: detail.url }),
      number: detail.number,
    };
    const [activity, head]: [PullRequestActivity, GitHubPullRequestCore] = yield* Effect.all(
      [
        service.activity(ref).pipe(Effect.mapError(toObservationError("readActivity"))),
        github.getPullRequestDetail(headInput).pipe(Effect.mapError(toHeadReadError)),
      ],
      { concurrency: 2 },
    );
    if (head.headSha === null || head.headSha === undefined || head.headSha.trim().length === 0) {
      return yield* transient("readHead", "GitHub reported no head commit for this pull request.");
    }
    return {
      headSha: head.headSha,
      state: head.state,
      checks: toWatchChecks(head.checks),
      feedback: toWatchFeedback(activity),
      feedbackComplete: isFeedbackComplete(activity),
    } satisfies PullRequestWatchObservation;
  });

  return PullRequestWatchObserver.of({ read });
});

export const layer = Layer.effect(PullRequestWatchObserver, make);
