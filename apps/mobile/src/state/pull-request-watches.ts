import { useAtomValue } from "@effect/atom-react";
import { createPullRequestWatchEnvironmentAtoms } from "@t3tools/client-runtime/state/pull-request-watches";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

export const pullRequestWatchEnvironment =
  createPullRequestWatchEnvironmentAtoms(connectionAtomRuntime);

/**
 * Older servers never advertised the watch routes: the card mounts no query
 * at all instead of polling an unknown method while the thread is open.
 */
export function useSupportsPullRequestWatches(environmentId: EnvironmentId): boolean {
  return (
    useAtomValue(
      serverEnvironment.configValueAtom(environmentId),
      (config) => config?.environment.capabilities.pullRequestWatches === true,
    ) === true
  );
}
