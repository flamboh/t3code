import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  PullRequestWatchCancelInput,
  PullRequestWatchCancelResult,
  PullRequestWatchListInput,
  PullRequestWatchListResult,
  WS_METHODS,
  WsRpcGroup,
} from "./rpc.ts";

const decodeListInput = Schema.decodeUnknownSync(PullRequestWatchListInput);
const decodeListInputExit = Schema.decodeUnknownExit(PullRequestWatchListInput);
const decodeCancelInput = Schema.decodeUnknownSync(PullRequestWatchCancelInput);
const decodeCancelInputExit = Schema.decodeUnknownExit(PullRequestWatchCancelInput);
const decodeListResult = Schema.decodeUnknownSync(PullRequestWatchListResult);
const decodeListResultExit = Schema.decodeUnknownExit(PullRequestWatchListResult);
const decodeCancelResult = Schema.decodeUnknownSync(PullRequestWatchCancelResult);

describe("pull request watch RPC contracts", () => {
  it("names the list/cancel methods in the watches namespace", () => {
    expect(WS_METHODS.pullRequestWatchesList).toBe("pullRequestWatches.list");
    expect(WS_METHODS.pullRequestWatchesCancel).toBe("pullRequestWatches.cancel");
  });

  it("registers both routes in the WebSocket RPC group", () => {
    const methods = [...WsRpcGroup.requests.keys()];
    expect(methods).toEqual(
      expect.arrayContaining([
        WS_METHODS.pullRequestWatchesList,
        WS_METHODS.pullRequestWatchesCancel,
      ]),
    );
  });

  it("scopes the list input to one thread in one project", () => {
    const decoded = decodeListInput({
      threadId: "thread:abc",
      projectId: "project:abc",
    });
    expect(decoded).toEqual({ threadId: "thread:abc", projectId: "project:abc" });
    // No thread, no listing: a client only ever reads the thread it has open.
    expect(decodeListInputExit({ projectId: "project:abc" })).toSatisfy(Exit.isFailure);
  });

  it("requires the watch id to cancel", () => {
    const decoded = decodeCancelInput({
      threadId: "thread:abc",
      projectId: "project:abc",
      watchId: "pull-request-watch:abc",
    });
    expect(decoded.watchId).toBe("pull-request-watch:abc");
    expect(
      decodeCancelInputExit({
        threadId: "thread:abc",
        projectId: "project:abc",
      }),
    ).toSatisfy(Exit.isFailure);
  });

  it("carries the full watch status the thread UI renders from", () => {
    const decoded = decodeListResult({
      watches: [
        {
          watchId: "pull-request-watch:abc",
          threadId: "thread:abc",
          projectId: "project:abc",
          repository: "owner/repo",
          number: 42,
          host: "github.com",
          url: "https://github.com/owner/repo/pull/42",
          events: ["check_failed", "review_feedback"],
          status: "pending",
          error: "rate limited, retrying",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:01.000Z",
          deliveredAt: null,
        },
      ],
    });
    expect(decoded.watches).toHaveLength(1);
    expect(decoded.watches[0]?.status).toBe("pending");
    expect(decoded.watches[0]?.error).toBe("rate limited, retrying");
  });

  it("rejects an unknown watch status instead of rendering it", () => {
    expect(
      decodeListResultExit({
        watches: [
          {
            watchId: "pull-request-watch:abc",
            threadId: "thread:abc",
            projectId: "project:abc",
            repository: "owner/repo",
            number: 42,
            host: "github.com",
            url: "https://github.com/owner/repo/pull/42",
            events: ["check_failed"],
            status: "flying",
            error: null,
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:01.000Z",
            deliveredAt: null,
          },
        ],
      }),
    ).toSatisfy(Exit.isFailure);
  });

  it("returns the stored watch after cancel", () => {
    const decoded = decodeCancelResult({
      watch: {
        watchId: "pull-request-watch:abc",
        threadId: "thread:abc",
        projectId: "project:abc",
        repository: "owner/repo",
        number: 42,
        host: "github.com",
        url: "https://github.com/owner/repo/pull/42",
        events: ["checks_finished"],
        status: "cancelled",
        error: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:02.000Z",
        deliveredAt: null,
      },
    });
    expect(decoded.watch.status).toBe("cancelled");
  });
});
