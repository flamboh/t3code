import { describe, expect, it } from "vite-plus/test";

import type { PullRequestWatchStatus } from "@t3tools/contracts";

import {
  describePullRequestWatch,
  describePullRequestWait,
  isPullRequestWatchActive,
  PULL_REQUEST_WATCH_POLL_INTERVAL_MS,
  pullRequestWatchStatusLabel,
  resolvePullRequestWatchBannerContent,
  serverSupportsPullRequestWatches,
} from "./pullRequestWatches.ts";

const watch = (overrides: Partial<PullRequestWatchStatus>): PullRequestWatchStatus => ({
  watchId: "pull-request-watch:test" as PullRequestWatchStatus["watchId"],
  threadId: "thread:test" as PullRequestWatchStatus["threadId"],
  projectId: "project:test" as PullRequestWatchStatus["projectId"],
  repository: "owner/repo",
  number: 42,
  host: "github.com",
  url: "https://github.com/owner/repo/pull/42",
  events: ["check_failed", "review_feedback"],
  status: "pending",
  error: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  deliveredAt: null,
  ...overrides,
});

describe("pull request watch visibility", () => {
  it("treats pending and matched as active, everything else as ended", () => {
    expect(isPullRequestWatchActive(watch({ status: "pending" }))).toBe(true);
    // Matched means delivery is in flight, not that the watch ended.
    expect(isPullRequestWatchActive(watch({ status: "matched" }))).toBe(true);
    for (const status of ["delivered", "cancelled", "closed"] as const) {
      expect(isPullRequestWatchActive(watch({ status }))).toBe(false);
    }
  });

  it("names each watch by PR number without repeating the wait", () => {
    expect(describePullRequestWatch(watch({}))).toBe("PR #42");
    expect(describePullRequestWatch(watch({ number: 7, events: [] }))).toBe("PR #7");
    expect(describePullRequestWatch(watch({ status: "matched" }))).toBe("PR #42");
    for (const status of ["delivered", "cancelled", "closed"] as const) {
      expect(describePullRequestWatch(watch({ status }))).toBe("PR #42");
    }
  });

  it("labels every status, including the in-flight matched state", () => {
    expect(pullRequestWatchStatusLabel(watch({ status: "matched" }))).toBe(
      "Update found, waking agent",
    );
    expect(pullRequestWatchStatusLabel(watch({ status: "pending" }))).toBe("Waiting");
    expect(pullRequestWatchStatusLabel(watch({ status: "delivered" }))).toBe("Delivered");
    expect(pullRequestWatchStatusLabel(watch({ status: "cancelled" }))).toBe("Cancelled");
    expect(pullRequestWatchStatusLabel(watch({ status: "closed" }))).toBe("Ended");
  });

  it("polls slower than the server poll loop it reads from", () => {
    // The server re-reads due watches every 60s; polling faster would mostly re-read the cache.
    expect(PULL_REQUEST_WATCH_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    expect(PULL_REQUEST_WATCH_POLL_INTERVAL_MS).toBeLessThan(60_000);
  });

  it("only polls servers that advertise the watch routes", () => {
    // Absent on older servers: no query mounts, so no unknown-method polling.
    expect(serverSupportsPullRequestWatches(null)).toBe(false);
    expect(serverSupportsPullRequestWatches(undefined)).toBe(false);
    expect(serverSupportsPullRequestWatches({})).toBe(false);
    expect(serverSupportsPullRequestWatches({ pullRequestWatches: false })).toBe(false);
    expect(serverSupportsPullRequestWatches({ pullRequestWatches: true })).toBe(true);
  });
});

describe("pull request watch banner content", () => {
  it("stays hidden without watches and without errors", () => {
    expect(resolvePullRequestWatchBannerContent({ watches: [], error: null })).toBeNull();
    expect(resolvePullRequestWatchBannerContent({ watches: null, error: null })).toBeNull();
  });

  it("collapses once every watch reaches a terminal state", () => {
    // Delivered watches arrive as durable thread notifications instead.
    expect(
      resolvePullRequestWatchBannerContent({
        watches: [
          watch({ status: "delivered" }),
          watch({ status: "cancelled" }),
          watch({ status: "closed" }),
        ],
        error: null,
      }),
    ).toBeNull();
  });

  it("shows a lone pending watch without repeating the wait", () => {
    const content = resolvePullRequestWatchBannerContent({
      watches: [watch({ status: "pending", events: ["checks_finished"] })],
      error: null,
    });
    expect(content?.variant).toBe("default");
    expect(content?.title).toBe("Waiting for CI to finish");
    expect(content?.lines).toHaveLength(1);
    expect(content?.lines[0]?.text).toBe("PR #42");
    expect(content?.lines[0]?.status).toBeNull();
  });

  it("disambiguates pending lines when several watches are active", () => {
    const content = resolvePullRequestWatchBannerContent({
      watches: [
        watch({ watchId: "a" as never, status: "pending", events: ["checks_finished"] }),
        watch({
          watchId: "b" as never,
          status: "matched",
          number: 7,
          events: ["review_feedback"],
        }),
      ],
      error: null,
    });
    expect(content?.title).toBe("Waiting for CI to finish");
    expect(content?.lines).toHaveLength(2);
    expect(content?.lines[0]?.text).toBe("PR #42 · CI to finish");
    expect(content?.lines[0]?.status).toBeNull();
    expect(content?.lines[1]?.text).toBe("PR #7");
    expect(content?.lines[1]?.status).toBe("Update found, waking agent");
  });

  it("titles a fully matched banner as waking the agent", () => {
    const single = resolvePullRequestWatchBannerContent({
      watches: [watch({ status: "matched" })],
      error: null,
    });
    expect(single?.title).toBe("Waking agent");
    expect(single?.lines[0]?.status).toBe("Update found, waking agent");

    const several = resolvePullRequestWatchBannerContent({
      watches: [
        watch({ watchId: "a" as never, status: "matched" }),
        watch({ watchId: "b" as never, status: "matched", number: 7 }),
      ],
      error: null,
    });
    expect(several?.title).toBe("Waking agent (2)");
  });

  it("titles the wait by the requested CI and review conditions", () => {
    expect(describePullRequestWait([watch({ events: ["check_failed"] })])).toBe(
      "Waiting for a CI failure",
    );
    expect(describePullRequestWait([watch({ events: ["checks_finished"] })])).toBe(
      "Waiting for CI to finish",
    );
    expect(describePullRequestWait([watch({ events: ["review_feedback"] })])).toBe(
      "Waiting for review feedback",
    );
    expect(
      describePullRequestWait([
        watch({ events: ["check_failed", "checks_finished", "review_feedback"] }),
      ]),
    ).toBe("Waiting for CI or review feedback");
    expect(describePullRequestWait([watch({ events: [] })])).toBe("Waiting for PR updates");
    expect(
      describePullRequestWait([
        watch({ events: ["check_failed"] }),
        watch({ events: ["checks_finished"] }),
      ]),
    ).toBe("Waiting for CI results (2)");
    expect(
      describePullRequestWait([
        watch({ events: ["check_failed"] }),
        watch({ events: ["review_feedback"] }),
      ]),
    ).toBe("Waiting for a CI failure or review feedback (2)");
    expect(
      describePullRequestWait([
        watch({ events: ["checks_finished"] }),
        watch({ events: ["review_feedback"] }),
      ]),
    ).toBe("Waiting for CI or review feedback (2)");
  });

  it("carries each watch's stored observation failure on its own line", () => {
    // The list RPC can succeed while a watch keeps failing its host reads:
    // rate limits and auth failures must stay visible, not vanish into success.
    const content = resolvePullRequestWatchBannerContent({
      watches: [watch({ error: "rate limited, retrying" })],
      error: null,
    });
    expect(content?.lines[0]?.error).toBe("rate limited, retrying");
    expect(content?.error).toBeNull();
  });

  it("reports a failed list read honestly instead of pretending nothing is waited on", () => {
    const content = resolvePullRequestWatchBannerContent({
      watches: null,
      error: "The environment request failed.",
    });
    expect(content?.variant).toBe("error");
    expect(content?.title).toBe("Couldn't load PR watches");
    expect(content?.error).toBe("The environment request failed.");
  });
});
