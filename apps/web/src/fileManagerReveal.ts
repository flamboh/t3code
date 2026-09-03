import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useCallback, useMemo } from "react";

import { resolveRemoteOpenState } from "./remoteOpen";
import {
  fileManagerNameForKind,
  fileManagerNameForOs,
  type FileManagerName,
  revealInFileExplorerLabelForManager,
} from "./components/preview/fileExplorerLabel";
import { environmentPresentations } from "./state/presentation";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";

export type FileManagerActionResult = Awaited<ReturnType<typeof shellEnvironment.openInEditor.run>>;

export interface FileManagerAction {
  readonly fileManagerName: FileManagerName;
  readonly revealLabel: string;
  readonly open: (targetPath: string) => Promise<FileManagerActionResult>;
  readonly reveal: (targetPath: string) => Promise<FileManagerActionResult>;
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function usesWindowsSeparators(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith("\\\\") || path.startsWith("//");
}

function trimTrailingSeparators(path: string, separator: "/" | "\\"): string {
  const trimmed = separator === "/" ? path.replace(/\/+$/, "") : path.replace(/[\\/]+$/, "");
  return trimmed || separator;
}

/** Resolves a literal file-tree path without interpreting terminal-link syntax. */
export function resolveLiteralFilePath(path: string, workspaceRoot: string): string {
  if (isAbsoluteFilePath(path)) return path;

  const separator: "/" | "\\" = usesWindowsSeparators(workspaceRoot) ? "\\" : "/";
  const root = trimTrailingSeparators(workspaceRoot, separator).replaceAll("/", separator);
  const relativePath = separator === "\\" ? path.replaceAll("/", "\\") : path;
  return root === separator ? `${root}${relativePath}` : `${root}${separator}${relativePath}`;
}

const EMPTY_FILE_MANAGER_NAME_ATOM = Atom.make<FileManagerName | null>(null).pipe(
  Atom.withLabel("web-file-manager-name:empty"),
);

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

function fileManagerNameForPresentation(
  presentation: FileManagerPresentation,
): FileManagerName | null {
  const serverConfig = presentation.serverConfig;
  if (
    serverConfig === null ||
    serverConfig.shellRevealInFileManager !== true ||
    !serverConfig.availableEditors.includes("file-manager") ||
    !isLocalEnvironment(presentation)
  ) {
    return null;
  }

  return serverConfig.shellRevealInFileManagerKind === undefined
    ? fileManagerNameForOs(serverConfig.environment.platform.os)
    : fileManagerNameForKind(serverConfig.shellRevealInFileManagerKind);
}

function createFileManagerAction(
  environmentId: EnvironmentId,
  fileManagerName: FileManagerName,
  openInEditor: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly cwd: string;
      readonly editor: "file-manager";
      readonly reveal?: true;
    };
  }) => Promise<FileManagerActionResult>,
): FileManagerAction {
  return {
    fileManagerName,
    revealLabel: revealInFileExplorerLabelForManager(fileManagerName),
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
  const fileManagerName = fileManagerNameForPresentation(presentation);
  return fileManagerName === null
    ? null
    : createFileManagerAction(environmentId, fileManagerName, openInEditor);
}

const fileManagerNameAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const presentation = get(environmentPresentations.presentationAtom(environmentId));
    return presentation === null ? null : fileManagerNameForPresentation(presentation);
  }).pipe(Atom.withLabel(`web-file-manager-name:${environmentId}`)),
);

export function useFileManagerActionForEnvironment(
  environmentId: EnvironmentId | null,
): FileManagerAction | null {
  const fileManagerName = useAtomValue(
    environmentId === null ? EMPTY_FILE_MANAGER_NAME_ATOM : fileManagerNameAtom(environmentId),
  );
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });

  return useMemo(
    () =>
      environmentId === null || fileManagerName === null
        ? null
        : createFileManagerAction(environmentId, fileManagerName, openInEditor),
    [environmentId, fileManagerName, openInEditor],
  );
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
