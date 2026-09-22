import {
  isPullRequestWatchActive,
  resolvePullRequestWatchBannerContent,
} from "@t3tools/client-runtime/state/pull-request-watches";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestWatchStatus,
  ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";
import { AppState, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import {
  pullRequestWatchEnvironment,
  useSupportsPullRequestWatches,
} from "../../state/pull-request-watches";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

function useIsAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
    });
    return () => subscription.remove();
  }, []);
  return active;
}

/**
 * Compact watch status docked above the composer, mirroring the web banner.
 * Mounted only for the open thread on a supporting server, so the watch list
 * is polled while visible and never against an older server. Collapses once
 * every watch ends; delivery arrives as a durable thread notification.
 * Pending lines carry no status text (the title already names the wait).
 */
export function PullRequestWatchCard({
  environmentId,
  threadId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}) {
  const supported = useSupportsPullRequestWatches(environmentId);
  const appActive = useIsAppActive();
  const query = useEnvironmentQuery(
    !supported || !appActive
      ? null
      : pullRequestWatchEnvironment.listByThread({
          environmentId,
          input: { threadId, projectId },
        }),
  );
  const cancelWatch = useAtomCommand(pullRequestWatchEnvironment.cancel, {
    label: "pull request watch cancel",
    reportFailure: false,
  });
  const [busyWatchId, setBusyWatchId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  if (!supported) return null;
  const content = resolvePullRequestWatchBannerContent({
    watches: query.data?.watches ?? null,
    error: query.error,
  });
  if (content === null) return null;
  const activeWatches = (query.data?.watches ?? []).filter(isPullRequestWatchActive);
  const watchById: Map<string, PullRequestWatchStatus> = new Map(
    activeWatches.map((watch) => [watch.watchId, watch] as const),
  );
  const singleWatch = activeWatches.length === 1 ? activeWatches[0] : undefined;
  const showPerLineCancel = activeWatches.length > 1;

  const handleCancel = async (watch: PullRequestWatchStatus) => {
    if (busyWatchId !== null) return;
    setBusyWatchId(watch.watchId);
    setCancelError(null);
    try {
      const result = await cancelWatch({
        environmentId,
        input: { threadId, projectId, watchId: watch.watchId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setCancelError(String(squashAtomCommandFailure(result)));
      } else if (result._tag === "Success") {
        query.refresh();
      }
    } finally {
      setBusyWatchId(null);
    }
  };

  const renderCancel = (watch: PullRequestWatchStatus) => (
    <Pressable
      key={watch.watchId}
      accessibilityLabel={`Cancel watch on PR #${watch.number}`}
      accessibilityRole="button"
      hitSlop={8}
      disabled={busyWatchId !== null}
      onPress={() => void handleCancel(watch)}
      className="rounded-full border border-border px-3 py-1 active:opacity-60"
    >
      <Text className="text-[12px] font-medium text-foreground">
        {busyWatchId === watch.watchId ? "Cancelling…" : "Cancel"}
      </Text>
    </Pressable>
  );

  return (
    <View className="shrink-0 px-4 pb-3">
      <View className="overflow-hidden rounded-[20px] border-continuous bg-card">
        <View className="gap-1.5 px-4 py-3">
          <View className="flex-row items-center gap-2">
            <View className="size-1.5 rounded-full bg-foreground" />
            <Text className="text-[13px] font-semibold text-foreground">{content.title}</Text>
          </View>
          {content.lines.map((line) => (
            <View key={line.watchId} className="gap-0.5 pl-3.5">
              <Text className="text-[13px] text-foreground" numberOfLines={2}>
                {line.status !== null ? `${line.text} · ${line.status}` : line.text}
              </Text>
              {line.error !== null ? (
                <Text className="text-[12px] text-muted-foreground" numberOfLines={2}>
                  Couldn&apos;t refresh PR: {line.error}
                </Text>
              ) : null}
              {showPerLineCancel && watchById.get(line.watchId) !== undefined ? (
                <View className="flex-row pt-0.5">
                  {renderCancel(watchById.get(line.watchId) as PullRequestWatchStatus)}
                </View>
              ) : null}
            </View>
          ))}
          {content.error !== null ? (
            <Text className="pl-3.5 text-[12px] text-muted-foreground" numberOfLines={2}>
              Couldn&apos;t load watches: {content.error}
            </Text>
          ) : null}
          {cancelError !== null ? (
            <Text className="pl-3.5 text-[12px] text-destructive" numberOfLines={2}>
              Couldn&apos;t cancel the watch: {cancelError}
            </Text>
          ) : null}
          {singleWatch !== undefined ? (
            <View className="flex-row flex-wrap items-center gap-2 pl-3.5 pt-0.5">
              {renderCancel(singleWatch)}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}
