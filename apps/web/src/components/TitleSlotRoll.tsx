import { useState, type ReactNode } from "react";

import { observeVisibleAnimation } from "~/lib/visibleAnimation";

type Phase = "idle" | "rolling" | "landing";

export function TitleSlotRoll({
  regenerating,
  children,
}: {
  regenerating: boolean;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>(regenerating ? "rolling" : "idle");
  if (regenerating && phase !== "rolling") setPhase("rolling");
  if (!regenerating && phase === "rolling") setPhase("landing");

  if (phase === "idle") return children;

  return (
    <span className="block overflow-hidden">
      <span
        className={
          phase === "rolling"
            ? "title-slot-roll-out relative block"
            : "title-slot-roll-in relative block"
        }
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && phase === "landing") setPhase("idle");
        }}
      >
        <span className="block truncate">{children}</span>
        <span
          aria-hidden
          ref={observeVisibleAnimation}
          className="absolute inset-x-0 top-full flex h-full items-center gap-1"
        >
          <span className="title-slot-dot size-1 rounded-full bg-current" />
          <span className="title-slot-dot size-1 rounded-full bg-current" />
          <span className="title-slot-dot size-1 rounded-full bg-current" />
        </span>
        <span aria-hidden className="absolute inset-x-0 top-[200%] block truncate">
          {children}
        </span>
      </span>
    </span>
  );
}
