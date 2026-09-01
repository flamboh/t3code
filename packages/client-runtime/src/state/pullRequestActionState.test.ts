import { describe, expect, it } from "vite-plus/test";

import {
  beginPullRequestAction,
  completePullRequestAction,
  EMPTY_PULL_REQUEST_ACTION_STATE,
  observePullRequestDetail,
} from "./pullRequestActionState.ts";

function completedMerge() {
  return completePullRequestAction(
    beginPullRequestAction(EMPTY_PULL_REQUEST_ACTION_STATE, "merge"),
    "merge",
  );
}

describe("pullRequestActionState", () => {
  it("clears a merge hold when detail leaves open", () => {
    const state = observePullRequestDetail(completedMerge(), {
      state: "merged",
      isPending: false,
    });

    expect(state).toEqual(EMPTY_PULL_REQUEST_ACTION_STATE);
  });

  it("clears a merge hold when a post-hold read settles still open", () => {
    const pending = observePullRequestDetail(completedMerge(), {
      state: "open",
      isPending: true,
    });
    const settled = observePullRequestDetail(pending, {
      state: "open",
      isPending: false,
    });

    expect(pending.mergeHold).toBe(true);
    expect(settled).toEqual(EMPTY_PULL_REQUEST_ACTION_STATE);
  });

  it("does not clear a merge hold from the stale settled detail at hold-set time", () => {
    const state = observePullRequestDetail(completedMerge(), {
      state: "open",
      isPending: false,
    });

    expect(state).toMatchObject({ mergeHold: true, observedPostMergeRead: false });
  });
});
