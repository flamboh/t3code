import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

import { T3Wordmark } from "./T3Wordmark";
import { Badge } from "./ui/badge";

export function T3CodeBrand({ onBackdrop = false }: { readonly onBackdrop?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-baseline gap-1",
        onBackdrop ? "text-white" : "text-foreground",
      )}
    >
      <T3Wordmark aria-label="T3" className="h-2.5 w-auto shrink-0" />
      <span
        className={cn(
          "truncate text-sm font-medium tracking-tight",
          onBackdrop ? "text-white/70" : "text-muted-foreground",
        )}
      >
        Code
      </span>
    </span>
  );
}

export function EnvironmentStagePill({ className, ...props }: ComponentProps<typeof Badge>) {
  return (
    <Badge
      className={cn("ml-1 rounded-full px-1.5 text-muted-foreground", className)}
      size="sm"
      variant="secondary"
      {...props}
    />
  );
}
