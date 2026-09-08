import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatDuration,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { AlarmClockIcon, CircleDashedIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { useUsage } from "../../state/usage";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { getDriverOption } from "../settings/providerDriverMeta";
import { useLinkedThreadPullRequest } from "../ThreadStatusIndicators";
import { barColor } from "../usage/UsageLimits";
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

function PoolWindowRow({
  window,
  color,
  now,
}: {
  readonly window: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  // The soonest reset that hands anything back, as the Usage page picks it.
  const nextReset = window.resets.find((reset) => reset.restoresPercent > 0);
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-x-2 leading-5">
      <span className="truncate text-muted-foreground">{window.label}</span>
      {/* Pooled across the provider's accounts, like the Usage page headline. */}
      <span aria-hidden className="relative h-1.5 overflow-hidden rounded-full bg-muted">
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${window.remainingPercent}%`, backgroundColor: color }}
        />
      </span>
      <span className="shrink-0 text-end tabular-nums">
        <span className="font-medium text-foreground">{window.remainingPercent}%</span>
        {nextReset ? (
          <span className="text-muted-foreground">
            {" "}
            · {nextReset.at <= now ? "now" : formatDuration(nextReset.at - now)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function PoolRows({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const label = getDriverOption(pool.driver)?.label ?? String(pool.driver);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 leading-5 font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={pool.driver}
          displayName={label}
          indicatorBackground="var(--popover)"
          className="size-4"
          iconClassName="size-3 text-foreground/80"
        />
        {label}
        {pool.accounts.length > 1 ? (
          <span className="font-normal text-muted-foreground">
            {" "}
            · {pool.accounts.length} accounts
          </span>
        ) : null}
      </span>
      {pool.windows.map((window) => (
        <PoolWindowRow
          key={`${window.kind}:${window.id}`}
          window={window}
          color={barColor(pool.driver)}
          now={now}
        />
      ))}
    </div>
  );
}

/**
 * Spend over the past day and what is left on each subscription window, read
 * from the same query and provider snapshots the Usage page uses. Mounted only
 * while the popover is open.
 */
export function SidebarUsagePreview() {
  // Anchored once per open: countdowns must not tick, and a fixed window keeps
  // the query key stable so it is not re-issued on every render.
  const [now] = useState(() => Date.now());
  const [window] = useState(() => makeWindow(1, new Date(now), "hour"));
  const { merged, selectedEnvironments, isPending, isPartial } = useUsage(window);
  const answered = selectedEnvironments.some((environment) => environment.summary !== null);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const pools = useMemo(
    () => collectLimitPools(collectLimitAccounts(presentations), now),
    [now, presentations],
  );

  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2 p-1 text-xs">
      <PreviewHeading title="Usage" />
      <div className="flex items-baseline justify-between gap-3 leading-5">
        <span className="text-muted-foreground">Spend, past 24h</span>
        <span className="font-medium text-foreground tabular-nums">
          {isPending ? "…" : !answered ? "—" : formatUsd(merged.costUsd)}
          {isPartial ? <span className="font-normal text-muted-foreground"> · partial</span> : null}
        </span>
      </div>
      {pools.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
          {pools.map((pool) => (
            <PoolRows key={pool.driver} pool={pool} now={now} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
