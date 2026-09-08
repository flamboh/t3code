import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AlarmClockIcon, CircleDashedIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { useLinkedThreadPullRequest } from "../ThreadStatusIndicators";
import {
  collectPullRequestPreviewEntries,
  type PullRequestPreviewEntry,
} from "./SidebarUtilityPreviews.logic";

const MAX_PULL_REQUEST_ROWS = 8;

function PreviewHeading({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail?: string | undefined;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm leading-5 font-medium text-foreground">{title}</span>
      {detail ? (
        <span className="text-xs leading-5 text-muted-foreground tabular-nums">{detail}</span>
      ) : null}
    </div>
  );
}

function PullRequestPreviewRow({ entry }: { readonly entry: PullRequestPreviewEntry }) {
  const detail = useLinkedThreadPullRequest(entry.thread.environmentId, entry.reference);
  const pr = detail?.pr ?? null;
  const state = pr
    ? resolvePullRequestState({ state: pr.state, isDraft: pr.isDraft === true })
    : null;
  const title = pr?.title ?? entry.thread.branch ?? entry.thread.title;
  const Icon = state?.Icon ?? CircleDashedIcon;
  return (
    <li
      className={cn("flex items-center gap-2 leading-5", entry.snoozed && "text-muted-foreground")}
    >
      <Icon
        role="img"
        aria-label={state?.label ?? "Loading"}
        className={cn("size-3.5 shrink-0", state?.toneClassName ?? "text-muted-foreground/60")}
      />
      <span className="shrink-0 text-muted-foreground tabular-nums">#{entry.reference.number}</span>
      <span className="min-w-0 truncate">{title}</span>
      {entry.snoozed ? (
        <AlarmClockIcon aria-label="Snoozed" className="ms-auto size-3 shrink-0 opacity-70" />
      ) : null}
    </li>
  );
}

/**
 * The pull requests behind the sidebar's active and snoozed threads, for a
 * glance before opening the page. Mounted only while the popover is open, so
 * the footer itself never subscribes to thread state.
 */
export function SidebarPullRequestsPreview() {
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  // One clock per open: the popover is short-lived and must not tick.
  const [now] = useState(() => new Date().toISOString());
  const entries = useMemo(() => {
    const capabilities = new Map(
      [...serverConfigs].map(([id, config]) => [id, config.environment.capabilities] as const),
    );
    return collectPullRequestPreviewEntries(threads, capabilities, now);
  }, [now, serverConfigs, threads]);
  const visible = entries.slice(0, MAX_PULL_REQUEST_ROWS);
  const hidden = entries.length - visible.length;
  const snoozedCount = entries.filter((entry) => entry.snoozed).length;
  const activeCount = entries.length - snoozedCount;

  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-1.5 p-1 text-xs">
      <PreviewHeading
        title="Pull Requests"
        detail={
          entries.length > 0
            ? `${activeCount} active${snoozedCount > 0 ? ` · ${snoozedCount} snoozed` : ""}`
            : undefined
        }
      />
      {entries.length === 0 ? (
        <span className="leading-5 text-muted-foreground">
          No pull requests on your active threads.
        </span>
      ) : (
        <ul className="flex flex-col">
          {visible.map((entry) => (
            <PullRequestPreviewRow
              key={scopedThreadKey(scopeThreadRef(entry.thread.environmentId, entry.thread.id))}
              entry={entry}
            />
          ))}
          {hidden > 0 ? <li className="leading-5 text-muted-foreground">+{hidden} more</li> : null}
        </ul>
      )}
    </div>
  );
}
