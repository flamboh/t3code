import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentOperateAccess } from "../../hooks/useEnvironmentOperateAccess";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { type EnvironmentPresentation, usePrimaryEnvironmentId } from "../../state/environments";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function DirectoryFields({ environment }: { environment: EnvironmentPresentation }) {
  const settings = useEnvironmentSettings(environment.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  const operateAccess = useEnvironmentOperateAccess(environment.environmentId);
  const disabled = environment.connection.phase !== "connected" || operateAccess !== "granted";
  const supportsWorktreeDirectory =
    environment.serverConfig?.environment.capabilities.worktreeBaseDirectory === true;

  return (
    <>
      {disabled ? (
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          {environment.connection.phase !== "connected"
            ? "Connect to this environment to change its directories."
            : operateAccess === "pending"
              ? "Checking access to this environment."
              : "Your session on this environment cannot change its settings."}
        </p>
      ) : null}
      <SettingsRow
        title="Repositories directory"
        description='Where Add Project and Clone Repository start browsing on this server. Leave empty to use "~/".'
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={settings.addProjectBaseDirectory}
            onCommit={(addProjectBaseDirectory) => updateSettings({ addProjectBaseDirectory })}
            disabled={disabled}
            placeholder="~/"
            spellCheck={false}
            aria-label="Repositories directory"
          />
        }
      />
      <SettingsRow
        title="Worktrees directory"
        description={
          supportsWorktreeDirectory
            ? "Use an absolute path or ~/ on this server. Applies to new worktrees; existing worktrees stay in place. Leave empty for the T3 home worktrees directory."
            : "Update this server to configure where new worktrees are created."
        }
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={settings.worktreeBaseDirectory}
            onCommit={(worktreeBaseDirectory) => updateSettings({ worktreeBaseDirectory })}
            disabled={disabled || !supportsWorktreeDirectory}
            placeholder="T3 home worktrees directory"
            spellCheck={false}
            aria-label="Worktrees directory"
          />
        }
      />
    </>
  );
}

export function EnvironmentDirectorySettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const selected =
    environments.find((environment) => environment.environmentId === selectedId) ??
    environments.find((environment) => environment.environmentId === primaryEnvironmentId) ??
    environments[0];

  return (
    <SettingsSection {...searchableSetting("environment-directories")}>
      {selected ? (
        <>
          <SettingsRow
            title="Environment"
            description="Directory defaults are saved on this server and used by every client connected to it."
            control={
              <Select
                value={selected.environmentId}
                onValueChange={(value) => {
                  const environment = environments.find((entry) => entry.environmentId === value);
                  if (environment) setSelectedId(environment.environmentId);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-72"
                  aria-label="Directory environment"
                >
                  <SelectValue>{selected.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {environments.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <DirectoryFields key={selected.environmentId} environment={selected} />
        </>
      ) : (
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
          Connect an environment to configure its directories.
        </p>
      )}
    </SettingsSection>
  );
}
