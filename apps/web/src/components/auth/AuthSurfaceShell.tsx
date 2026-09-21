import type { ReactNode } from "react";

import { APP_STAGE_LABEL } from "../../branding";
import { resolveEnvironmentIdentificationPillLabel } from "../SidebarStageBackdrop";
import { T3CodeWordmark } from "../T3Wordmark";
import { Badge } from "../ui/badge";
import { StandalonePage } from "../ui/standalone-page";

export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  const stageLabel = resolveEnvironmentIdentificationPillLabel(APP_STAGE_LABEL);

  return (
    <StandalonePage tone="plain">
      <div className="flex items-center">
        <T3CodeWordmark />
        {stageLabel ? (
          <Badge className="ml-1" size="sm" variant="secondary">
            {stageLabel}
          </Badge>
        ) : null}
      </div>
      {children}
    </StandalonePage>
  );
}

export function AuthSurfaceMessage({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <>
      <h1 className="mt-6 text-xl font-semibold leading-tight">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}
