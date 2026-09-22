/**
 * Compact "Waiting for …" indicator for the open thread. Mounted above the
 * composer, so the watch list is only polled while this thread is open and
 * the tab is visible. Collapses once every watch ends; delivery itself
 * arrives as a durable thread notification. Pending lines carry no status
 * text (the title already names the wait); matched lines do.
 */
import {
  isPullRequestWatchActive,
  pullRequestWatchStatusLabel,
} from "@t3tools/client-runtime/state/pull-request-watches";
import type { PullRequestWatchStatus } from "@t3tools/contracts";
import { useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestWatchEnvironment } from "../../state/pullRequestWatches";
import { useSupportsPullRequestWatches } from "../../hooks/useSupportsPullRequestWatches";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import {
  resolvePullRequestWatchBannerContent,
  useIsDocumentVisible,
  type PullRequestWatchBannerTarget,
} from "./pullRequestWatchBanner.logic";

export function usePullRequestWatchBannerItem(
  target: PullRequestWatchBannerTarget | null,
): ComposerBannerStackItem | null {
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
  const cancelWatch = useAtomCommand(pullRequestWatchEnvironment.cancel, {
    label: "pull request watch cancel",
    reportFailure: false,
  });
  const [busyWatchId, setBusyWatchId] = useState<string | null>(null);

  if (target === null) return null;
  const content = resolvePullRequestWatchBannerContent({
    watches: query.data?.watches ?? null,
    error: query.error,
  });
  if (content === null) return null;

  const handleCancel = async (watch: PullRequestWatchStatus) => {
    if (busyWatchId !== null) return;
    setBusyWatchId(watch.watchId);
    try {
      const result = await cancelWatch({
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          projectId: target.projectId,
          watchId: watch.watchId,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not cancel the PR watch",
            description: String(squashAtomCommandFailure(result)),
          }),
        );
      } else if (result._tag === "Success") {
        query.refresh();
      }
    } finally {
      setBusyWatchId(null);
    }
  };

  const activeWatches = (query.data?.watches ?? []).filter(isPullRequestWatchActive);
  const watchById: Map<string, PullRequestWatchStatus> = new Map(
    activeWatches.map((watch) => [watch.watchId, watch] as const),
  );
  // One watch keeps its Cancel in the banner actions; several move Cancel to
  // the end of each line so the user can tell them apart.
  const singleWatch = activeWatches.length === 1 ? activeWatches[0] : undefined;
  const showPerLineCancel = activeWatches.length > 1;

  return {
    id: `pull-request-watches:${target.threadId}`,
    variant: content.variant,
    priority: content.variant === "error" ? "urgent" : "activity",
    icon: (
      <span
        className="size-1.5 animate-status-pulse rounded-full bg-foreground"
        aria-hidden="true"
      />
    ),
    title: content.title,
    description:
      content.lines.length === 0 ? (
        (content.error ?? undefined)
      ) : (
        <span className="flex flex-col gap-1">
          {content.lines.map((line) => {
            const watch = watchById.get(line.watchId);
            return (
              <span key={line.watchId} className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  {line.url === null ? (
                    <span className="min-w-0 truncate">{line.text}</span>
                  ) : (
                    <a
                      href={line.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 truncate underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      {line.text}
                    </a>
                  )}
                  {line.status !== null ? (
                    <span className="shrink-0 text-muted-foreground">· {line.status}</span>
                  ) : null}
                  {showPerLineCancel && watch !== undefined ? (
                    <PullRequestWatchCancelButton
                      watch={watch}
                      busyWatchId={busyWatchId}
                      onCancel={(value) => void handleCancel(value)}
                    />
                  ) : null}
                </span>
                {line.error !== null ? (
                  <span className="truncate text-muted-foreground">
                    Couldn&apos;t refresh PR: {line.error}
                  </span>
                ) : null}
              </span>
            );
          })}
          {content.error !== null ? (
            <span className="text-muted-foreground">
              Couldn&apos;t load watches: {content.error}
            </span>
          ) : null}
        </span>
      ),
    actions:
      singleWatch === undefined ? undefined : (
        <span className="flex shrink-0 items-center gap-1">
          <PullRequestWatchCancelButton
            watch={singleWatch}
            busyWatchId={busyWatchId}
            onCancel={(watch) => void handleCancel(watch)}
          />
        </span>
      ),
  };
}

function PullRequestWatchCancelButton({
  watch,
  busyWatchId,
  onCancel,
}: {
  readonly watch: PullRequestWatchStatus;
  readonly busyWatchId: string | null;
  readonly onCancel: (watch: PullRequestWatchStatus) => void;
}) {
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={busyWatchId !== null}
      aria-label={`Cancel watch on PR #${watch.number} (${pullRequestWatchStatusLabel(watch).toLowerCase()})`}
      onClick={() => onCancel(watch)}
    >
      {busyWatchId === watch.watchId ? "Cancelling…" : "Cancel"}
    </Button>
  );
}
