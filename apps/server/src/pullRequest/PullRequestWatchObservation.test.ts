import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import type {
  ProjectId,
  PullRequestActivity,
  PullRequestCheck,
  PullRequestDetail,
} from "@t3tools/contracts";
import { PullRequestOperationError, PullRequestUnavailableError } from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import type { GitHubPullRequestCore } from "./gitHubPullRequestJson.ts";
import {
  isFeedbackComplete,
  make,
  matchesWatchEvent,
  PullRequestWatchObserver,
  toWatchChecks,
  toWatchCheckState,
  toWatchFeedback,
  watchHeadHost,
  type PullRequestWatchObservation,
} from "./PullRequestWatchObservation.ts";
import * as PullRequestService from "./PullRequestService.ts";

const projectId = "p1" as ProjectId;

function check(
  name: string,
  status: PullRequestCheck["status"],
  url: string | null = null,
): PullRequestCheck {
  return { name, status, description: null, url };
}

function observation(
  overrides?: Partial<PullRequestWatchObservation>,
): PullRequestWatchObservation {
  return {
    headSha: "abc123def456abc123def456abc123def456abcd",
    state: "open",
    checks: [],
    feedback: [],
    feedbackComplete: true,
    ...overrides,
  };
}

const pending = (name: string): PullRequestWatchObservation["checks"][number] => ({
  id: name,
  name,
  state: "pending",
  url: null,
});

const passed = (name: string): PullRequestWatchObservation["checks"][number] => ({
  id: name,
  name,
  state: "passed",
  url: null,
});

const failed = (name: string): PullRequestWatchObservation["checks"][number] => ({
  id: name,
  name,
  state: "failed",
  url: null,
});

const remark = (
  id: string,
  body: string,
  updatedAt = "2026-09-01T10:00:00Z",
): PullRequestWatchObservation["feedback"][number] => ({ id, updatedAt, body, url: null });

describe("toWatchCheckState", () => {
  it("maps host statuses onto the five watch states", () => {
    expect(toWatchCheckState("pending")).toBe("pending");
    // A workflow awaiting a maintainer's approval has not run yet.
    expect(toWatchCheckState("action-required")).toBe("pending");
    expect(toWatchCheckState("success")).toBe("passed");
    expect(toWatchCheckState("failure")).toBe("failed");
    expect(toWatchCheckState("cancelled")).toBe("cancelled");
    expect(toWatchCheckState("skipped")).toBe("skipped");
    // Ran without failing, which is terminal but not a failure.
    expect(toWatchCheckState("neutral")).toBe("skipped");
  });
});

describe("toWatchChecks", () => {
  it("names checks by their check name, the only stable identity hosts report", () => {
    expect(toWatchChecks([check("build", "pending", "https://ci/build")])).toEqual([
      { id: "build", name: "build", state: "pending", url: "https://ci/build" },
    ]);
  });
});

describe("toWatchFeedback", () => {
  const activity = (overrides?: Partial<PullRequestActivity>): PullRequestActivity => ({
    comments: [],
    commentCount: 0,
    commentsTruncated: false,
    reviewThreads: [],
    commits: [],
    ...overrides,
  });

  it("reads top-level comments, reviews, and inline thread comments", () => {
    const feedback = toWatchFeedback(
      activity({
        comments: [
          {
            id: "c1",
            kind: "issue-comment",
            author: null,
            body: "top level",
            createdAt: "2026-09-01T10:00:00Z",
            url: "https://host/c1",
            path: null,
            reviewState: null,
          },
          {
            id: "r1",
            kind: "review",
            author: null,
            body: "approved",
            createdAt: "2026-09-01T11:00:00Z",
            url: null,
            path: null,
            reviewState: "APPROVED",
          },
        ],
        reviewThreads: [
          {
            id: "t1",
            path: "src/a.ts",
            line: 10,
            side: "right",
            isResolved: false,
            isOutdated: false,
            comments: [
              {
                id: "tc1",
                author: null,
                body: "inline",
                createdAt: "2026-09-01T12:00:00Z",
                url: null,
              },
            ],
          },
        ],
      }),
    );
    expect(feedback.map((item) => item.id)).toEqual(["c1", "r1", "tc1"]);
    expect(feedback[0]).toMatchObject({
      updatedAt: "2026-09-01T10:00:00Z",
      body: "top level",
      url: "https://host/c1",
    });
  });

  it("de-duplicates a remark reachable both flat and through its thread", () => {
    const feedback = toWatchFeedback(
      activity({
        comments: [
          {
            id: "dup",
            kind: "review-comment",
            author: null,
            body: "same",
            createdAt: "2026-09-01T10:00:00Z",
            url: null,
            path: null,
            reviewState: null,
          },
        ],
        reviewThreads: [
          {
            id: "t1",
            path: "src/a.ts",
            line: 10,
            side: "right",
            isResolved: false,
            isOutdated: false,
            comments: [
              {
                id: "dup",
                author: null,
                body: "same",
                createdAt: "2026-09-01T10:00:00Z",
                url: null,
              },
            ],
          },
        ],
      }),
    );
    expect(feedback.map((item) => item.id)).toEqual(["dup"]);
  });
});

describe("isFeedbackComplete", () => {
  it("is false while the conversation or any thread is still paged", () => {
    const base: PullRequestActivity = {
      comments: [],
      commentCount: 0,
      commentsTruncated: false,
      reviewThreads: [],
      commits: [],
    };
    expect(isFeedbackComplete(base)).toBe(true);
    expect(isFeedbackComplete({ ...base, commentsTruncated: true })).toBe(false);
    // The host counts more remarks than the read holds: missing data,
    // however the flags read.
    expect(isFeedbackComplete({ ...base, commentCount: 3 })).toBe(false);
    expect(
      isFeedbackComplete({
        ...base,
        reviewThreads: [
          {
            id: "t1",
            path: "src/a.ts",
            line: 1,
            side: "right",
            isResolved: false,
            isOutdated: false,
            comments: [],
            nextCommentsCursor: "cursor",
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("matchesWatchEvent", () => {
  describe("check_failed", () => {
    const event = "check_failed" as const;

    it("fires on a newly failed check", () => {
      expect(
        matchesWatchEvent({
          previous: observation({ checks: [pending("build")] }),
          next: observation({ checks: [failed("build")] }),
          event,
        }),
      ).toBe(true);
    });

    it("stays silent while a failure persists across polls", () => {
      const run = "https://github.com/acme/web/actions/runs/1";
      const at = (url: string) => ({
        id: "build",
        name: "build",
        state: "failed" as const,
        url,
      });
      expect(
        matchesWatchEvent({
          previous: observation({ checks: [at(run)] }),
          next: observation({ checks: [at(run)] }),
          event,
        }),
      ).toBe(false);
    });

    it("wakes when a rerun fails under a new run URL the poll never saw pending", () => {
      const failedAt = (url: string) => ({
        id: "build",
        name: "build",
        state: "failed" as const,
        url,
      });
      const previous = observation({
        checks: [failedAt("https://github.com/acme/web/actions/runs/1")],
      });
      const next = observation({
        checks: [failedAt("https://github.com/acme/web/actions/runs/2")],
      });
      expect(matchesWatchEvent({ previous, next, event })).toBe(true);
      // A finished rerun under a new URL is also a changed rollup.
      expect(matchesWatchEvent({ previous, next, event: "checks_finished" })).toBe(true);
    });

    it("fires again when a rerun fails after clearing", () => {
      expect(
        matchesWatchEvent({
          previous: observation({ checks: [pending("build")] }),
          next: observation({ checks: [failed("build")] }),
          event,
        }),
      ).toBe(true);
    });

    it("wakes on the baseline itself when registering against a red rollup", () => {
      expect(
        matchesWatchEvent({
          previous: null,
          next: observation({ checks: [failed("build")] }),
          event,
        }),
      ).toBe(true);
      expect(
        matchesWatchEvent({
          previous: null,
          next: observation({ checks: [pending("build")] }),
          event,
        }),
      ).toBe(false);
      expect(matchesWatchEvent({ previous: null, next: observation({ checks: [] }), event })).toBe(
        false,
      );
    });

    it("does not carry the old commit's failures onto a new head", () => {
      const oldHead = observation({ checks: [failed("build")] });
      // Same failures on a new head are new failures: the baseline resets.
      expect(
        matchesWatchEvent({
          previous: oldHead,
          next: observation({
            headSha: "fff999fff999fff999fff999fff999fff999ffff",
            checks: [failed("build")],
          }),
          event,
        }),
      ).toBe(true);
      // And a clean new head does not wake for the old head's failure.
      expect(
        matchesWatchEvent({
          previous: oldHead,
          next: observation({
            headSha: "fff999fff999fff999fff999fff999fff999ffff",
            checks: [passed("build")],
          }),
          event,
        }),
      ).toBe(false);
    });
  });

  describe("checks_finished", () => {
    const event = "checks_finished" as const;

    it("fires on the pending-to-complete transition", () => {
      expect(
        matchesWatchEvent({
          previous: observation({ checks: [pending("build"), passed("lint")] }),
          next: observation({ checks: [passed("build"), passed("lint")] }),
          event,
        }),
      ).toBe(true);
    });

    it("never reads an empty check list as success", () => {
      expect(
        matchesWatchEvent({
          previous: observation({ checks: [] }),
          next: observation({ checks: [] }),
          event,
        }),
      ).toBe(false);
      expect(
        matchesWatchEvent({
          previous: observation({ checks: [pending("build")] }),
          next: observation({ checks: [] }),
          event,
        }),
      ).toBe(false);
    });

    it("stays silent while checks are still running or already finished", () => {
      expect(
        matchesWatchEvent({
          previous: observation({ checks: [pending("build")] }),
          next: observation({ checks: [pending("build")] }),
          event,
        }),
      ).toBe(false);
      expect(
        matchesWatchEvent({
          previous: observation({ checks: [passed("build")] }),
          next: observation({ checks: [passed("build")] }),
          event,
        }),
      ).toBe(false);
    });

    it("wakes on an already-complete baseline instead of parking forever", () => {
      expect(
        matchesWatchEvent({
          previous: null,
          next: observation({ checks: [passed("build"), failed("lint")] }),
          event,
        }),
      ).toBe(true);
      expect(matchesWatchEvent({ previous: null, next: observation({ checks: [] }), event })).toBe(
        false,
      );
      expect(
        matchesWatchEvent({
          previous: null,
          next: observation({ checks: [pending("build")] }),
          event,
        }),
      ).toBe(false);
    });

    it("fires when the current head already landed complete", () => {
      expect(
        matchesWatchEvent({
          previous: observation({ checks: [pending("build")] }),
          next: observation({
            headSha: "fff999fff999fff999fff999fff999fff999ffff",
            checks: [passed("build")],
          }),
          event,
        }),
      ).toBe(true);
    });

    it("finishes on failed and cancelled checks without conflating them with success", () => {
      const previous = observation({ checks: [pending("build"), pending("lint")] });
      const next = observation({ checks: [failed("build"), passed("lint")] });
      expect(matchesWatchEvent({ previous, next, event })).toBe(true);
      expect(matchesWatchEvent({ previous, next, event: "check_failed" })).toBe(true);
      // checks_finished reports completion, not success: the failure that
      // finished alongside it still wakes check_failed on its own.
    });

    it("wakes when a completed rerun lands under the same head", () => {
      // The poll never saw pending: previous was already terminal, but the
      // verdict changed, so this is a finished rerun rather than old news.
      expect(
        matchesWatchEvent({
          previous: observation({ checks: [failed("build")] }),
          next: observation({ checks: [passed("build")] }),
          event,
        }),
      ).toBe(true);
    });

    it("wakes when an extra check completes on the same head", () => {
      expect(
        matchesWatchEvent({
          previous: observation({ checks: [passed("build")] }),
          next: observation({ checks: [passed("build"), passed("lint")] }),
          event,
        }),
      ).toBe(true);
    });

    it("stays silent on a reordered but unchanged rollup", () => {
      const previous = observation({ checks: [passed("build"), failed("lint")] });
      const next = observation({ checks: [failed("lint"), passed("build")] });
      expect(matchesWatchEvent({ previous, next, event })).toBe(false);
      expect(matchesWatchEvent({ previous, next, event: "check_failed" })).toBe(false);
    });

    it("treats cancelled and skipped as terminal without failing", () => {
      const previous = observation({ checks: [pending("build")] });
      const next = observation({
        checks: [
          { id: "build", name: "build", state: "cancelled", url: null },
          { id: "lint", name: "lint", state: "skipped", url: null },
        ],
      });
      expect(matchesWatchEvent({ previous, next, event })).toBe(true);
      expect(matchesWatchEvent({ previous, next, event: "check_failed" })).toBe(false);
    });
  });

  describe("review_feedback", () => {
    const event = "review_feedback" as const;

    it("fires on a new remark", () => {
      expect(
        matchesWatchEvent({
          previous: observation({ feedback: [remark("c1", "first")] }),
          next: observation({ feedback: [remark("c1", "first"), remark("c2", "second")] }),
          event,
        }),
      ).toBe(true);
    });

    it("fires on an edited remark body with no timestamp change", () => {
      // Host reads report no edit time, so the body comparison is what
      // catches an edit posted between the previous watch and the rearm.
      expect(
        matchesWatchEvent({
          previous: observation({ feedback: [remark("c1", "first")] }),
          next: observation({ feedback: [remark("c1", "first (edited)")] }),
          event,
        }),
      ).toBe(true);
    });

    it("fires on a timestamp change alone", () => {
      expect(
        matchesWatchEvent({
          previous: observation({ feedback: [remark("c1", "same", "2026-09-01T10:00:00Z")] }),
          next: observation({ feedback: [remark("c1", "same", "2026-09-01T11:00:00Z")] }),
          event,
        }),
      ).toBe(true);
    });

    it("stays silent on an identical conversation", () => {
      const feedback = [remark("c1", "first"), remark("c2", "second")];
      expect(
        matchesWatchEvent({
          previous: observation({ feedback }),
          next: observation({ feedback: [...feedback] }),
          event,
        }),
      ).toBe(false);
    });

    it("never replays the existing conversation as a baseline", () => {
      expect(
        matchesWatchEvent({
          previous: null,
          next: observation({ feedback: [remark("c1", "first"), remark("c2", "second")] }),
          event,
        }),
      ).toBe(false);
    });

    it("refuses the comparison while either side is truncated", () => {
      const feedback = [remark("c1", "first")];
      expect(
        matchesWatchEvent({
          previous: observation({ feedback }),
          next: observation({ feedback, feedbackComplete: false }),
          event,
        }),
      ).toBe(false);
      expect(
        matchesWatchEvent({
          previous: observation({ feedback, feedbackComplete: false }),
          next: observation({ feedback: [...feedback, remark("c2", "second")] }),
          event,
        }),
      ).toBe(false);
    });
  });
});

describe("watchHeadHost", () => {
  it("prefers the explicit host, then the change request's own URL", () => {
    expect(
      watchHeadHost({ host: "GHE.Example.COM ", url: "https://github.com/acme/web/pull/7" }),
    ).toBe("ghe.example.com");
    expect(watchHeadHost({ host: undefined, url: "https://ghe.example.com/acme/web/pull/7" })).toBe(
      "ghe.example.com",
    );
    expect(watchHeadHost({ host: undefined, url: "not a url" })).toBe("github.com");
  });
});

describe("PullRequestWatchObserver.read", () => {
  const detail = (overrides?: Partial<PullRequestDetail>): PullRequestDetail => ({
    provider: "github",
    capabilities: {
      diff: true,
      comment: true,
      actions: [],
      mergeMethods: [],
      updateMethods: [],
      search: true,
      reactions: true,
      viewedFiles: "host",
      review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
      reviewers: { request: false, listCandidates: false },
      edit: { changeRequest: false, comment: false },
      stacks: false,
      stackActions: false,
      labels: false,
    },
    viewerPermissions: {
      actions: [],
      comment: true,
      resolve: false,
      verdicts: [],
      requestReviewers: false,
      labels: false,
    },
    projectId,
    projectTitle: "web",
    workspaceRoot: "/w",
    repository: "acme/web",
    number: 7,
    title: "Change",
    body: "",
    url: "https://github.com/acme/web/pull/7",
    author: null,
    state: "open",
    isDraft: false,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headBranch: "feature",
    baseBranch: "main",
    createdAt: "2026-09-01T09:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    labels: [],
    checks: [],
    mergeCapabilities: { merge: false, squash: false, rebase: false },
    ...overrides,
  });

  const head = (overrides?: Partial<GitHubPullRequestCore>): GitHubPullRequestCore => ({
    authorId: null,
    number: 7,
    title: "Change",
    url: "https://github.com/acme/web/pull/7",
    author: null,
    headBranch: "feature",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "unknown",
    reviewDecision: null,
    additions: 0,
    deletions: 0,
    createdAt: "2026-09-01T09:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
    reviewRequestLogins: [],
    hasTeamReviewRequest: false,
    labels: [],
    checksState: null,
    headRepositoryOwner: "acme",
    headSha: "abc123def456abc123def456abc123def456abcd",
    body: "",
    changedFiles: 0,
    mergedAt: null,
    closedAt: null,
    checks: [check("build", "success")],
    viewerAccess: {
      canWrite: false,
      canTriage: false,
      canUpdate: false,
      didAuthor: false,
      mergeCapabilities: { merge: false, squash: false, rebase: false },
    },
    comparison: null,
    checksTruncated: false,
    ...overrides,
  });

  const activity: PullRequestActivity = {
    comments: [
      {
        id: "c1",
        kind: "issue-comment",
        author: null,
        body: "looks good",
        createdAt: "2026-09-01T10:00:00Z",
        url: null,
        path: null,
        reviewState: null,
      },
    ],
    commentCount: 1,
    commentsTruncated: false,
    reviewThreads: [],
    commits: [],
  };

  const routingLayer = Layer.mergeAll(
    Layer.mock(ProjectEnrichmentService)({ awaitRepositoryIdentity: () => Effect.void }),
    Layer.mock(ProjectionProjectRepository)({
      getById: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "web",
            workspaceRoot: "/w",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            scripts: [],
            createdAt: "2026-09-01T09:00:00Z",
            updatedAt: "2026-09-01T09:00:00Z",
            deletedAt: null,
          }),
        ),
    }),
  );
  const observerServiceLayer = Layer.effect(PullRequestWatchObserver, make).pipe(
    Layer.provide(routingLayer),
  );

  const observerLayer = (options?: {
    readonly detailOverrides?: Partial<PullRequestDetail>;
    readonly headOverrides?: Partial<GitHubPullRequestCore>;
    readonly headError?: GitHubPullRequestCli.GitHubPullRequestCliError;
  }) =>
    Layer.merge(
      Layer.mock(PullRequestService.PullRequestService)({
        detail: () => Effect.succeed(detail(options?.detailOverrides)),
        activity: () => Effect.succeed(activity),
      }),
      Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
        getPullRequestDetail: (input) => {
          expect(input.cwd).toBe("/w");
          expect(input.repository).toBe("acme/web");
          if (options?.headError !== undefined) return Effect.fail(options.headError);
          return Effect.succeed(head(options?.headOverrides));
        },
      }),
    );

  const read = (options?: Parameters<typeof observerLayer>[0]) =>
    Effect.gen(function* () {
      const observer = yield* PullRequestWatchObserver;
      return yield* observer.read({
        projectId,
        repository: "acme/web",
        number: 7,
      });
    }).pipe(Effect.provide(Layer.provideMerge(observerServiceLayer, observerLayer(options))));

  it.effect("refreshes cached feedback for the final coalescing observation", () =>
    Effect.gen(function* () {
      const cached = yield* Ref.make(true);
      const services = Layer.merge(
        Layer.mock(PullRequestService.PullRequestService)({
          invalidate: ({ reference }) => {
            expect(reference).toEqual({ projectId, repository: "acme/web", number: 7 });
            return Ref.set(cached, false);
          },
          detail: () => Effect.succeed(detail()),
          activity: () =>
            Ref.get(cached).pipe(
              Effect.map((isCached) =>
                isCached ? { ...activity, comments: [], commentCount: 0 } : activity,
              ),
            ),
        }),
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({
          getPullRequestDetail: () => Effect.succeed(head()),
        }),
      );
      yield* Effect.gen(function* () {
        const observer = yield* PullRequestWatchObserver;
        const ref = { projectId, repository: "acme/web", number: 7 };
        expect((yield* observer.read(ref)).feedback).toHaveLength(0);
        const refreshed = yield* observer.read({ ...ref, refresh: true });
        expect(refreshed.feedback).toHaveLength(1);
        expect(refreshed.feedback[0]?.body).toBe("looks good");
      }).pipe(Effect.provide(Layer.provideMerge(observerServiceLayer, services)));
    }),
  );

  it.effect("reads head, state, checks, and remarks in one observation", () =>
    Effect.gen(function* () {
      const result = yield* read({
        headOverrides: { checks: [check("build", "success"), check("lint", "pending")] },
      });
      expect(result.headSha).toBe("abc123def456abc123def456abc123def456abcd");
      expect(result.state).toBe("open");
      // Checks come from the same detail response as the head sha, never
      // from an independently cached read that could belong to an older push.
      expect(result.checks).toEqual([
        { id: "build", name: "build", state: "passed", url: null },
        { id: "lint", name: "lint", state: "pending", url: null },
      ]);
      expect(result.feedback).toEqual([
        { id: "c1", updatedAt: "2026-09-01T10:00:00Z", body: "looks good", url: null },
      ]);
      expect(result.feedbackComplete).toBe(true);
    }),
  );

  it.effect("refuses a non-GitHub host with an explicit unsupported error", () =>
    Effect.gen(function* () {
      const failure = yield* read({ detailOverrides: { provider: "gitlab" } }).pipe(Effect.flip);
      expect(failure._tag).toBe("PullRequestWatchObservationError");
      expect(failure.reason).toBe("unsupported");
    }),
  );

  it.effect("fails transiently when GitHub reports no head commit", () =>
    Effect.gen(function* () {
      const failure = yield* read({ headOverrides: { headSha: null } }).pipe(Effect.flip);
      expect(failure.reason).toBe("transient");
    }),
  );

  it.effect("maps a host 404 onto not-found and sign-in failures onto auth", () =>
    Effect.gen(function* () {
      const notFound = yield* read({
        headError: new GitHubCli.GitHubCliCommandError({
          command: "gh",
          cwd: "/w",
          httpStatus: 404,
          cause: new Error("not found"),
        }),
      }).pipe(Effect.flip);
      expect(notFound.reason).toBe("not-found");

      const auth = yield* read({
        headError: new GitHubCli.GitHubCliAuthenticationError({
          command: "gh",
          cwd: "/w",
          cause: new Error("signed out"),
        }),
      }).pipe(Effect.flip);
      expect(auth.reason).toBe("auth");
    }),
  );

  it.effect("maps service outages onto transient and sign-in failures onto auth", () =>
    Effect.gen(function* () {
      const transientLayer = Layer.merge(
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.fail(
              new PullRequestOperationError({ operation: "detail", detail: "host exploded" }),
            ),
        }),
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({}),
      );
      const transientFailure = yield* Effect.gen(function* () {
        const observer = yield* PullRequestWatchObserver;
        return yield* observer.read({ projectId, repository: "acme/web", number: 7 });
      }).pipe(
        Effect.provide(Layer.provideMerge(observerServiceLayer, transientLayer)),
        Effect.flip,
      );
      expect(transientFailure.reason).toBe("transient");

      const authLayer = Layer.merge(
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.fail(new PullRequestUnavailableError({ reason: "cli-unauthenticated" })),
        }),
        Layer.mock(GitHubPullRequestCli.GitHubPullRequestCli)({}),
      );
      const authFailure = yield* Effect.gen(function* () {
        const observer = yield* PullRequestWatchObserver;
        return yield* observer.read({ projectId, repository: "acme/web", number: 7 });
      }).pipe(Effect.provide(Layer.provideMerge(observerServiceLayer, authLayer)), Effect.flip);
      expect(authFailure.reason).toBe("auth");
    }),
  );
});
