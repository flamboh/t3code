import type { ExecutionEnvironmentPlatformOs, FileManagerRevealKind } from "@t3tools/contracts";

export type FileManagerName = "Finder" | "File Explorer" | "Files";

function labelForFileManager(fileManagerName: FileManagerName): string {
  return fileManagerName === "Files" ? "Open Containing Folder" : `Reveal in ${fileManagerName}`;
}

export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Reveal in Finder";
  if (normalized.includes("win")) return "Reveal in File Explorer";
  return "Reveal in Files";
}

/** Environment-backed names use the server's reported OS rather than the navigator platform. */
export function fileManagerNameForOs(os: ExecutionEnvironmentPlatformOs): FileManagerName {
  if (os === "darwin") return "Finder";
  if (os === "windows") return "File Explorer";
  return "Files";
}

/** Server-selected file-manager name, including Windows File Explorer reached from WSL. */
export function fileManagerNameForKind(kind: FileManagerRevealKind): FileManagerName {
  if (kind === "finder") return "Finder";
  if (kind === "file-explorer") return "File Explorer";
  return "Files";
}

export function revealInFileExplorerLabelForManager(fileManagerName: FileManagerName): string {
  return labelForFileManager(fileManagerName);
}
