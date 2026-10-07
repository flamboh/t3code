import { EyeIcon } from "lucide-react";

/** The mark a snoozed row shows in place of its wake countdown when it waits on a pull request. */
export function SnoozedUntilAttentionIndicator() {
  return (
    <span
      role="img"
      aria-label="Until its pull request needs attention"
      className="inline-flex text-xs text-info-foreground"
    >
      <EyeIcon aria-hidden className="size-3" />
    </span>
  );
}
