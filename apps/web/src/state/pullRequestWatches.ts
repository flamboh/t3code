import { createPullRequestWatchEnvironmentAtoms } from "@t3tools/client-runtime/state/pull-request-watches";

import { connectionAtomRuntime } from "../connection/runtime";

export const pullRequestWatchEnvironment =
  createPullRequestWatchEnvironmentAtoms(connectionAtomRuntime);
