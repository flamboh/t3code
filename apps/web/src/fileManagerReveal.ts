import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useMemo } from "react";

import { resolveRemoteOpenState } from "./remoteOpen";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "./components/preview/fileExplorerLabel";
import { environmentPresentations } from "./state/presentation";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";

export type FileManagerActionResult = Awaited<ReturnType<typeof shellEnvironment.openInEditor.run>>;

export interface FileManagerAction {
  readonly revealLabel: string;
  readonly open: (targetPath: string) => Promise<FileManagerActionResult>;
  readonly reveal: (targetPath: string) => Promise<FileManagerActionResult>;
}

type FileManagerPresentation = Pick<EnvironmentPresentation, "entry"> & {
  readonly serverConfig:
    | (Pick<
        ServerConfig,
        | "availableEditors"
        | "remoteOpenTargets"
        | "shellRevealInFileManager"
        | "shellRevealInFileManagerKind"
      > & {
        readonly environment: {
          readonly platform: Pick<ServerConfig["environment"]["platform"], "os">;
        };
      })
    | null;
};

function sshAliasForPresentation(presentation: FileManagerPresentation): string | null {
  const profile = Option.getOrNull(presentation.entry.profile);
  return profile !== null && profile._tag === "SshConnectionProfile" ? profile.target.alias : null;
}

function isLocalEnvironment(presentation: FileManagerPresentation): boolean {
  const remoteOpenState = resolveRemoteOpenState({
    target: presentation.entry.target,
    sshAlias: sshAliasForPresentation(presentation),
    remoteOpenTargets: presentation.serverConfig?.remoteOpenTargets,
    isDesktopRenderer: typeof window !== "undefined" && window.desktopBridge !== undefined,
  });
  return remoteOpenState.mode === "local-exec";
}

export function fileManagerActionForPresentation(
  environmentId: EnvironmentId,
  presentation: FileManagerPresentation,
  openInEditor: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly cwd: string;
      readonly editor: "file-manager";
      readonly reveal?: true;
    };
  }) => Promise<FileManagerActionResult>,
): FileManagerAction | null {
  const serverConfig = presentation.serverConfig;
  if (
    serverConfig === null ||
    serverConfig.shellRevealInFileManager !== true ||
    !serverConfig.availableEditors.includes("file-manager") ||
    !isLocalEnvironment(presentation)
  ) {
    return null;
  }

  const label =
    serverConfig.shellRevealInFileManagerKind === undefined
      ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
      : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind);

  return {
    revealLabel: label,
    open: (targetPath) =>
      openInEditor({
        environmentId,
        input: { cwd: targetPath, editor: "file-manager" },
      }),
    reveal: (targetPath) =>
      openInEditor({
        environmentId,
        input: { cwd: targetPath, editor: "file-manager", reveal: true },
      }),
  };
}

export function useFileManagerAction(): (environmentId: EnvironmentId) => FileManagerAction | null {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const actionsByEnvironment = useMemo(() => {
    const actions = new Map<EnvironmentId, FileManagerAction | null>();
    for (const [environmentId, presentation] of presentations ?? []) {
      actions.set(
        environmentId,
        fileManagerActionForPresentation(environmentId, presentation, openInEditor),
      );
    }
    return actions;
  }, [openInEditor, presentations]);

  return useCallback(
    (environmentId: EnvironmentId) => actionsByEnvironment.get(environmentId) ?? null,
    [actionsByEnvironment],
  );
}
