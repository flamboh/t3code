import type { ReactNode } from "react";

import { APP_STAGE_LABEL } from "../../branding";
import { resolveEnvironmentIdentificationPillLabel } from "../SidebarStageBackdrop";
import { EnvironmentStagePill, T3CodeBrand } from "../T3CodeBrand";

/**
 * Card for standalone auth pages, sized and styled like the app's dialogs so
 * the CLI-connect authorize and callback pages read as part of the product.
 * The brand row mirrors the sidebar header, including its release-channel pill.
 */
export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  const stageLabel = resolveEnvironmentIdentificationPillLabel(APP_STAGE_LABEL);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground sm:px-6">
      <main className="w-full max-w-lg rounded-2xl border bg-card p-6 sm:p-8">
        <div className="flex items-center gap-1">
          <T3CodeBrand />
          {stageLabel ? <EnvironmentStagePill>{stageLabel}</EnvironmentStagePill> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

/** Title and lead paragraph for a page in the shell, sized like a dialog header. */
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
