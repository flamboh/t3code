import { ChevronRightIcon } from "lucide-react";

import { useEnvironmentOperateAccess } from "../../hooks/useEnvironmentOperateAccess";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { SettingsRow } from "./settingsLayout";

export function EnvironmentDirectorySettings({
  environment,
  collapsible = false,
}: {
  environment: EnvironmentPresentation;
  collapsible?: boolean;
}) {
  const settings = useEnvironmentSettings(environment.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  const operateAccess = useEnvironmentOperateAccess(environment.environmentId);
  const disabled = environment.connection.phase !== "connected" || operateAccess !== "granted";
  const supportsWorktreeDirectory =
    environment.serverConfig?.environment.capabilities.worktreeBaseDirectory === true;

  const fields = (
    <>
      {disabled ? (
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          {environment.connection.phase !== "connected"
            ? "Connect to edit directories."
            : operateAccess === "pending"
              ? "Checking access…"
              : "Your session cannot edit settings."}
        </p>
      ) : null}
      <SettingsRow
        title="Repositories directory"
        description="Add Project and Clone Repository start here. Defaults to your home folder."
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={settings.addProjectBaseDirectory}
            onCommit={(addProjectBaseDirectory) => updateSettings({ addProjectBaseDirectory })}
            disabled={disabled}
            placeholder="Path, e.g. ~/repos"
            spellCheck={false}
            aria-label="Repositories directory"
          />
        }
      />
      <SettingsRow
        title="Worktrees directory"
        description={
          supportsWorktreeDirectory
            ? "New worktrees only. Leave empty for T3's default directory."
            : "Update this server to set a worktrees directory."
        }
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={settings.worktreeBaseDirectory}
            onCommit={(worktreeBaseDirectory) => updateSettings({ worktreeBaseDirectory })}
            disabled={disabled || !supportsWorktreeDirectory}
            placeholder="Path, e.g. ~/worktrees"
            spellCheck={false}
            aria-label="Worktrees directory"
          />
        }
      />
    </>
  );

  const description = "Shared by all clients on this server.";
  if (collapsible) {
    const summary =
      environment.connection.phase !== "connected"
        ? "Connect to view and edit"
        : [
            settings.addProjectBaseDirectory && `Repositories: ${settings.addProjectBaseDirectory}`,
            supportsWorktreeDirectory &&
              settings.worktreeBaseDirectory &&
              `Worktrees: ${settings.worktreeBaseDirectory}`,
          ]
            .filter(Boolean)
            .join(" · ") || "Using server defaults";

    return (
      <Collapsible className="mt-3 border-t border-border/50">
        <CollapsibleTrigger
          className="group flex w-full min-w-0 items-center gap-2 py-3 text-left"
          aria-label={`Default directories for ${environment.label}`}
        >
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-data-panel-open:rotate-90" />
          <span className="shrink-0 text-xs font-medium">Default directories</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <p className="pb-2 text-xs text-muted-foreground">{description}</p>
          <div className="-mx-3 divide-y divide-border/50 sm:-mx-4 [&>[data-slot=settings-row]]:rounded-none">
            {fields}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    );
  }

  return (
    <div>
      <div className="px-3 pt-3 pb-1 sm:px-4">
        <h3 className="text-sm font-medium">Default directories</h3>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="divide-y divide-border/50 [&>[data-slot=settings-row]]:rounded-none">
        {fields}
      </div>
    </div>
  );
}
