import {
  resolvePullRequestWatchBannerContent,
  type PullRequestWatchBannerContent,
  type PullRequestWatchBannerLine,
} from "@t3tools/client-runtime/state/pull-request-watches";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

export {
  resolvePullRequestWatchBannerContent,
  type PullRequestWatchBannerContent,
  type PullRequestWatchBannerLine,
};

function subscribeToVisibilityChange(notify: () => void): () => void {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
}

/**
 * Polling runs only while the tab is visible: a hidden tab unmounts the query
 * (returning it to idle) and the visible tab revalidates on return.
 */
export function useIsDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeToVisibilityChange,
    () => document.visibilityState === "visible",
    () => true,
  );
}

export interface PullRequestWatchBannerTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}
