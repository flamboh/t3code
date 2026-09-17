import type { ExecutionEnvironmentPlatformOs, FileManagerRevealKind } from "@t3tools/contracts";

export type FileManagerRevealName = "Finder" | "File Explorer" | "Files";
export type FileManagerOpenName = "Finder" | "File Explorer" | "File Manager";

export function fileManagerOpenNameForOs(os: ExecutionEnvironmentPlatformOs): FileManagerOpenName {
  if (os === "darwin") return "Finder";
  if (os === "windows") return "File Explorer";
  return "File Manager";
}

export function fileManagerRevealNameForOs(
  os: ExecutionEnvironmentPlatformOs,
): FileManagerRevealName {
  if (os === "darwin") return "Finder";
  if (os === "windows") return "File Explorer";
  return "Files";
}

export function fileManagerRevealNameForKind(kind: FileManagerRevealKind): FileManagerRevealName {
  if (kind === "finder") return "Finder";
  if (kind === "file-explorer") return "File Explorer";
  return "Files";
}

export function revealInFileExplorerLabelForManager(name: FileManagerRevealName): string {
  return name === "Files" ? "Open Containing Folder" : `Reveal in ${name}`;
}

export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Reveal in Finder";
  if (normalized.includes("win")) return "Reveal in File Explorer";
  return "Reveal in Files";
}

/** Same wording keyed by an environment's reported OS rather than a
    navigator platform string, for actions that reveal on the server machine. */
export function revealInFileExplorerLabelForOs(os: ExecutionEnvironmentPlatformOs): string {
  if (os === "darwin") return "Reveal in Finder";
  if (os === "windows") return "Reveal in File Explorer";
  return "Reveal in Files";
}

/** Server-selected wording, including Windows File Explorer reached from WSL. */
export function revealInFileExplorerLabelForKind(kind: FileManagerRevealKind): string {
  if (kind === "finder") return "Reveal in Finder";
  if (kind === "file-explorer") return "Reveal in File Explorer";
  return "Reveal in Files";
}
