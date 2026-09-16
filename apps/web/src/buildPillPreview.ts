import * as Schema from "effect/Schema";

import type { EnvironmentIdentificationPillLabel } from "./components/SidebarStageBackdrop";
import { useLocalStorage } from "./hooks/useLocalStorage";

const BUILD_PILL_PREVIEW_STORAGE_KEY = "t3code:build-pill-preview";

const BuildPillPreview = Schema.Literals(["automatic", "dev", "nightly"]);
type BuildPillPreview = typeof BuildPillPreview.Type;

export const BUILD_PILL_PREVIEW_LABELS: Record<BuildPillPreview, string> = {
  automatic: "Automatic",
  dev: "Dev",
  nightly: "Nightly",
};

export function resolveBuildPillPreviewLabel(
  resolvedLabel: EnvironmentIdentificationPillLabel | null,
  preview: BuildPillPreview,
): EnvironmentIdentificationPillLabel | null {
  if (!import.meta.env.DEV || preview === "automatic") return resolvedLabel;
  return preview === "dev" ? "Dev" : "Nightly";
}

export function useBuildPillPreview() {
  return useLocalStorage(BUILD_PILL_PREVIEW_STORAGE_KEY, "automatic", BuildPillPreview);
}
