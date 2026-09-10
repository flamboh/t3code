import {
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LayersIcon,
  TriangleAlertIcon,
} from "lucide-react";

/**
 * The one place the web app names a pull-request glyph. Pick by meaning, never by lucide name:
 * an open pull request wears the arrow (GitHub's current octicon) and every other state has its
 * own shape, so one pull request cannot look like two different things in two places. The root
 * lint config blocks the underlying lucide imports everywhere else.
 */
export const PullRequestGlyph = {
  /** The noun: navigation, empty states, an open PR, or one whose state is not known yet. */
  pullRequest: GitPullRequestArrowIcon,
  draft: GitPullRequestDraftIcon,
  closed: GitPullRequestClosedIcon,
  merged: GitMergeIcon,
  conflicting: TriangleAlertIcon,
  stack: LayersIcon,
} as const;

export type PullRequestGlyphIcon = (typeof PullRequestGlyph)[keyof typeof PullRequestGlyph];

/** The ink each settled state wears, shared by the sidebar badge, the right panel, and the list. */
export const PULL_REQUEST_STATE_TONE = {
  open: "text-emerald-600 dark:text-emerald-300/90",
  draft: "text-zinc-500 dark:text-zinc-400/80",
  closed: "text-red-600 dark:text-red-300/90",
  merged: "text-violet-600 dark:text-violet-300/90",
} as const;
