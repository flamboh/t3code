/**
 * Active PR watches for one thread, as a stable array. Mounts the shared
 * watch-list query only while the server supports watches and the tab is
 * visible; every other case reads as "nothing watched".
 */
import { isPullRequestWatchActive } from "@t3tools/client-runtime/state/pull-request-watches";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestWatchStatus,
  ThreadId,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { useSupportsPullRequestWatches } from "./useSupportsPullRequestWatches";
import { pullRequestWatchEnvironment } from "../state/pullRequestWatches";
import { useEnvironmentQuery } from "../state/query";
import { useIsDocumentVisible } from "../components/chat/pullRequestWatchBanner.logic";

export interface ThreadPullRequestWatchesTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

const EMPTY_WATCHES: ReadonlyArray<PullRequestWatchStatus> = [];

export function useThreadPullRequestWatches(target: ThreadPullRequestWatchesTarget | null) {
  const visible = useIsDocumentVisible();
  // Older servers never advertised the watch routes: mount no query at all
  // instead of polling an unknown method every 20s forever.
  const supported = useSupportsPullRequestWatches(target?.environmentId ?? null);
  const query = useEnvironmentQuery(
    target === null || !visible || !supported
      ? null
      : pullRequestWatchEnvironment.listByThread({
          environmentId: target.environmentId,
          input: { threadId: target.threadId, projectId: target.projectId },
        }),
  );
  return useMemo(() => {
    const watches = query.data?.watches;
    if (watches === undefined || watches === null) return EMPTY_WATCHES;
    const active = watches.filter(isPullRequestWatchActive);
    return active.length === 0 ? EMPTY_WATCHES : active;
  }, [query.data?.watches]);
}
