import { PreviewCard } from "@base-ui/react/preview-card";
import type { PullRequestRef, PullRequestSummary } from "@t3tools/contracts";
import { ArrowLeftIcon, GitBranchIcon, GitPullRequestIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import { linkedPullRequestDetailAtom, useSharedPullRequestSummary } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { GhostBar } from "./PullRequestGhosts";
import type { PullRequestLinkPreviewTarget } from "./pullRequestLinkPreview.logic";
import { PullRequestMetaLine, resolvePullRequestState } from "./pullRequestPresentation";

/**
 * The "owner/repo #N" line every state shares, in the list row's meta ink. The provider icon
 * only arrives with the summary, so the ghost holds its slot to keep the card from shifting.
 */
function PullRequestLinkPreviewHeading({
  reference,
  icon,
  trailing,
}: {
  reference: PullRequestRef;
  icon?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/70">
      {icon}
      <span className="min-w-0 truncate">{reference.repository}</span>
      <span className="shrink-0">#{reference.number}</span>
      {trailing ? <span className="ml-auto shrink-0 pl-3 tabular-nums">{trailing}</span> : null}
    </div>
  );
}

function PullRequestLinkPreviewLoading({ reference }: { reference: PullRequestRef }) {
  return (
    <div aria-busy className="flex animate-ghost-pulse flex-col gap-2 p-3">
      <PullRequestLinkPreviewHeading
        reference={reference}
        icon={<GhostBar className="size-3.5 shrink-0" />}
        trailing={<GhostBar className="w-16" />}
      />
      {/* Each bar sits in the line box of the text it stands for, so the loaded card lands on
          the same rows: title at leading-5, meta at the xs line height. */}
      <div className="flex h-5 items-center">
        <GhostBar className="h-3.5 w-4/5" />
      </div>
      <div className="flex h-4 items-center">
        <GhostBar className="w-1/2" />
      </div>
    </div>
  );
}

function PullRequestLinkPreviewUnavailable({ reference }: { reference: PullRequestRef }) {
  return (
    <div className="flex flex-col gap-2 p-3">
      <PullRequestLinkPreviewHeading reference={reference} />
      <p className="text-sm font-medium text-foreground">Preview unavailable</p>
    </div>
  );
}

function PullRequestLinkPreviewSummary({ summary }: { summary: PullRequestSummary }) {
  const { Icon, providerName } = getSourceControlPresentationForKind(summary.provider);
  const state = resolvePullRequestState({
    state: summary.state,
    isDraft: summary.isDraft === true,
  });
  const updatedAt = formatRelativeTimeLabel(summary.updatedAt);
  return (
    <div className="flex flex-col gap-2 p-3">
      <PullRequestLinkPreviewHeading
        reference={summary}
        icon={<Icon aria-label={providerName} className="size-3.5 shrink-0" />}
        trailing={updatedAt ? `Updated ${updatedAt}` : undefined}
      />
      <p className="line-clamp-2 text-sm font-medium leading-5 text-foreground">{summary.title}</p>
      <PullRequestMetaLine className="text-xs text-muted-foreground">
        <span
          className={`inline-flex shrink-0 items-center gap-1 font-medium ${state.toneClassName}`}
        >
          <state.Icon aria-hidden className="size-3.5" />
          {state.label}
        </span>
        {/* Base first, as on the detail panel: the short branch stays visible and the long head
            branch takes the truncation. */}
        <span className="flex min-w-0 items-center gap-1">
          <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
          <code className="max-w-[45%] shrink-0 truncate">{summary.baseBranch}</code>
          <ArrowLeftIcon
            aria-label="receives changes from"
            className="size-3 shrink-0 opacity-60"
          />
          <code className="min-w-0 truncate">{summary.headBranch}</code>
        </span>
      </PullRequestMetaLine>
    </div>
  );
}

function PullRequestLinkPreviewContent({ target }: { target: PullRequestLinkPreviewTarget }) {
  const query = useEnvironmentQuery(
    linkedPullRequestDetailAtom({
      environmentId: target.environmentId,
      input: target.reference,
    }),
  );
  const summary = useSharedPullRequestSummary(target.environmentId, target.reference, query.data);
  if (summary !== null) return <PullRequestLinkPreviewSummary summary={summary} />;
  if (query.error !== null) {
    return <PullRequestLinkPreviewUnavailable reference={target.reference} />;
  }
  return <PullRequestLinkPreviewLoading reference={target.reference} />;
}

/**
 * The mark a pull request link wears in place of a favicon: one neutral glyph saying "this is a
 * pull request with a preview", never its state. State would need a request per link, or a glyph
 * that only changes once the reader has already hovered; the card carries it instead.
 */
export function PullRequestLinkStateIcon() {
  return <GitPullRequestIcon className="size-full shrink-0 text-muted-foreground" />;
}

/** A hover/focus preview whose query exists only while Base UI has the card mounted. */
export function PullRequestLinkPreview({
  target,
  trigger,
}: {
  readonly target: PullRequestLinkPreviewTarget;
  readonly trigger: ReactElement;
}) {
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger render={trigger} delay={450} closeDelay={125} />
      <PreviewCard.Portal>
        <PreviewCard.Positioner
          side="top"
          align="start"
          sideOffset={6}
          className="z-[130] max-w-(--available-width)"
        >
          {/* Same glass, radius and shadow as the app's menus, so the card reads as one of them. */}
          <PreviewCard.Popup
            aria-label={`${target.reference.repository} #${target.reference.number} preview`}
            className="dropdown-glass w-[min(22rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-lg text-popover-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]"
          >
            <PullRequestLinkPreviewContent target={target} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}
