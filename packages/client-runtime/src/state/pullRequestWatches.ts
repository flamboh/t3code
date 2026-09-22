import {
  WS_METHODS,
  type ExecutionEnvironmentCapabilities,
  type PullRequestWatchEvent,
  type PullRequestWatchStatus,
  type PullRequestWatchStatusValue,
} from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * How often an open thread re-reads its watches while the status is mounted.
 * The server poll loop runs every 60s, so 20s keeps the banner fresh without
 * out-pacing the source of truth. The query atom only refreshes while
 * mounted and idles out after 5 minutes, which bounds the polling to visible UI.
 */
export const PULL_REQUEST_WATCH_POLL_INTERVAL_MS = 20_000;

/** The states a thread status indicator keeps visible. */
export function isPullRequestWatchActive(watch: PullRequestWatchStatus): boolean {
  return watch.status === "pending" || watch.status === "matched";
}

function describeWatchEvents(events: ReadonlyArray<PullRequestWatchEvent>): string {
  const watched = new Set(events);
  const failed = watched.has("check_failed");
  const finished = watched.has("checks_finished");
  const feedback = watched.has("review_feedback");

  if (failed && finished) {
    return feedback ? "CI or review feedback" : "CI results";
  }
  if (failed && feedback) return "a CI failure or review feedback";
  if (finished && feedback) return "CI or review feedback";
  if (failed) return "a CI failure";
  if (finished) return "CI to finish";
  if (feedback) return "review feedback";
  return "PR updates";
}

/** One line for a thread status row: the PR number. The banner title already
 * says what is being waited for, so lines never repeat "waiting". */
export function describePullRequestWatch(watch: PullRequestWatchStatus): string {
  return `PR #${watch.number}`;
}

const WATCH_STATUS_LABELS: Record<PullRequestWatchStatusValue, string> = {
  pending: "Waiting",
  matched: "Update found, waking agent",
  delivered: "Delivered",
  cancelled: "Cancelled",
  closed: "Ended",
};

/** Short status word for badges and accessibility labels. */
export function pullRequestWatchStatusLabel(watch: PullRequestWatchStatus): string {
  return WATCH_STATUS_LABELS[watch.status];
}

export interface PullRequestWatchBannerLine {
  readonly watchId: string;
  readonly text: string;
  /** Null for pending watches: the title already says what is waited for. */
  readonly status: string | null;
  readonly url: string | null;
  /** Last observation/rate-limit/auth failure stored on the watch itself. */
  readonly error: string | null;
}

export interface PullRequestWatchBannerContent {
  readonly variant: "default" | "error";
  readonly title: string;
  readonly lines: ReadonlyArray<PullRequestWatchBannerLine>;
  /** List RPC failure; per-watch failures ride on their own line. */
  readonly error: string | null;
}

/** Event-specific wait title based on the events persisted on each watch. */
export function describePullRequestWait(
  watches: ReadonlyArray<Pick<PullRequestWatchStatus, "events">>,
): string {
  const events = new Set<PullRequestWatchEvent>();
  for (const watch of watches) {
    for (const event of watch.events) events.add(event);
  }
  const count = watches.length > 1 ? ` (${watches.length})` : "";
  return `Waiting for ${describeWatchEvents([...events])}${count}`;
}

const toBannerLine = (
  watch: PullRequestWatchStatus,
  disambiguate: boolean,
): PullRequestWatchBannerLine => ({
  watchId: watch.watchId,
  // The title already names the waited-for events, so a lone pending line is
  // just the PR number. With several active watches, pending lines name
  // their own events so the user can tell them apart.
  text:
    watch.status === "pending" && disambiguate
      ? `PR #${watch.number} · ${describeWatchEvents(watch.events)}`
      : `PR #${watch.number}`,
  status: watch.status === "pending" ? null : pullRequestWatchStatusLabel(watch),
  url: watch.url,
  error: watch.error,
});

/**
 * Pure content decision for the "Waiting for …" thread indicator. Null means
 * no banner: no active watches, and no load error worth showing. A load error
 * with no data reads as an error banner rather than silence, so a broken
 * watch list never looks like "nothing is being waited on".
 */
export function resolvePullRequestWatchBannerContent(input: {
  readonly watches: ReadonlyArray<PullRequestWatchStatus> | null;
  readonly error: string | null;
}): PullRequestWatchBannerContent | null {
  const { watches, error } = input;
  if (watches === null) {
    return error === null
      ? null
      : { variant: "error", title: "Couldn't load PR watches", lines: [], error };
  }
  const active = watches.filter(isPullRequestWatchActive);
  if (active.length === 0) {
    // Terminal watches collapse away: delivery arrives as a durable thread
    // notification, and history stays server-side for the record.
    return null;
  }
  const waiting = active.filter((watch) => watch.status === "pending");
  const title =
    waiting.length > 0
      ? describePullRequestWait(waiting)
      : `Waking agent${active.length > 1 ? ` (${active.length})` : ""}`;
  const disambiguate = active.length > 1;
  return {
    variant: "default",
    title,
    lines: active.map((watch) => toBannerLine(watch, disambiguate)),
    error,
  };
}

/**
 * True only when the server advertises the watch routes. Older servers leave
 * the flag absent, and clients must mount no watch query at all — polling an
 * unknown method would fail every 20s forever.
 */
export function serverSupportsPullRequestWatches(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "pullRequestWatches"> | null | undefined,
): boolean {
  return capabilities?.pullRequestWatches === true;
}

/**
 * Shared watch query/command factories. One input shape everywhere — the
 * current thread only — so web and mobile cannot drift into listing another
 * thread's watches.
 */
export function createPullRequestWatchEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /**
     * This thread's watches, polled while mounted. No subscription RPC: the
     * set changes only when the agent registers/cancels or a poll delivers.
     */
    listByThread: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-request-watches:list-by-thread",
      tag: WS_METHODS.pullRequestWatchesList,
      staleTimeMs: 15_000,
      refreshIntervalMs: PULL_REQUEST_WATCH_POLL_INTERVAL_MS,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-request-watches:cancel",
      tag: WS_METHODS.pullRequestWatchesCancel,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}:${input.watchId}`,
      },
    }),
  };
}
