import {
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LayersIcon,
  Link2Icon,
  TriangleAlertIcon,
} from "lucide-react";

export const PullRequestGlyph = {
  pullRequest: GitPullRequestArrowIcon,
  draft: GitPullRequestDraftIcon,
  closed: GitPullRequestClosedIcon,
  merged: GitMergeIcon,
  conflicting: TriangleAlertIcon,
  stack: LayersIcon,
  linked: Link2Icon,
} as const;

export type PullRequestGlyphIcon = (typeof PullRequestGlyph)[keyof typeof PullRequestGlyph];

export const PULL_REQUEST_STATE_TONE = {
  open: "text-emerald-600 dark:text-emerald-300/90",
  draft: "text-zinc-500 dark:text-zinc-400/80",
  closed: "text-red-600 dark:text-red-300/90",
  merged: "text-violet-600 dark:text-violet-300/90",
} as const;
