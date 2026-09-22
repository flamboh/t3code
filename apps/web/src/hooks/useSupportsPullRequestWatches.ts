import type { EnvironmentId } from "@t3tools/contracts";
import { useServerConfigs } from "~/state/entities";

export function useSupportsPullRequestWatches(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.pullRequestWatches === true
  );
}
