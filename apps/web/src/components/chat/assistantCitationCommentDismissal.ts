import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH } from "@t3tools/contracts";

export type AssistantCitationCommentDismissal =
  | { kind: "commit"; comment: string }
  | { kind: "close" }
  | { kind: "keep-open" };

/**
 * Decides what happens to unsaved comment text when the citation popover closes
 * without Save or Cancel: clicking away, focus leaving, or toggling the pencil.
 * Typed text is committed rather than dropped. Escape stays an explicit discard,
 * and a draft over the length limit keeps the popover open so the error is visible.
 */
export function resolveAssistantCitationCommentDismissal({
  reason,
  draft,
  savedComment,
}: {
  reason: string;
  draft: string | null;
  savedComment: string | undefined;
}): AssistantCitationCommentDismissal {
  if (reason === "escape-key" || draft === null) return { kind: "close" };
  if (draft.trim() === (savedComment ?? "")) return { kind: "close" };
  if (draft.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH) return { kind: "keep-open" };
  return { kind: "commit", comment: draft };
}
