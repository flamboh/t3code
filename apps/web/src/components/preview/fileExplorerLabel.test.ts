import { describe, expect, it } from "vite-plus/test";

import {
  fileManagerOpenNameForOs,
  fileManagerRevealNameForKind,
  fileManagerRevealNameForOs,
  revealInFileExplorerLabel,
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
  revealInFileExplorerLabelForManager,
} from "./fileExplorerLabel";

describe("file manager names", () => {
  it.each([
    ["darwin", "Finder", "Finder"],
    ["windows", "File Explorer", "File Explorer"],
    ["linux", "File Manager", "Files"],
  ] as const)("maps %s", (os, openName, revealName) => {
    expect(fileManagerOpenNameForOs(os)).toBe(openName);
    expect(fileManagerRevealNameForOs(os)).toBe(revealName);
  });

  it.each([
    ["finder", "Finder", "Reveal in Finder"],
    ["file-explorer", "File Explorer", "Reveal in File Explorer"],
    ["files", "Files", "Open Containing Folder"],
  ] as const)("maps %s kind", (kind, revealName, label) => {
    expect(fileManagerRevealNameForKind(kind)).toBe(revealName);
    expect(revealInFileExplorerLabelForManager(revealName)).toBe(label);
  });
});

describe("revealInFileExplorerLabel", () => {
  it.each([
    ["MacIntel", "Reveal in Finder"],
    ["Win32", "Reveal in File Explorer"],
    ["Linux x86_64", "Reveal in Files"],
  ])("maps %s to %s", (platform, expected) => {
    expect(revealInFileExplorerLabel(platform)).toBe(expected);
  });
});

describe("revealInFileExplorerLabelForOs", () => {
  it.each([
    ["darwin", "Reveal in Finder"],
    ["windows", "Reveal in File Explorer"],
    ["linux", "Reveal in Files"],
    ["unknown", "Reveal in Files"],
  ] as const)("maps %s to %s", (os, expected) => {
    expect(revealInFileExplorerLabelForOs(os)).toBe(expected);
  });
});

describe("revealInFileExplorerLabelForKind", () => {
  it.each([
    ["finder", "Reveal in Finder"],
    ["file-explorer", "Reveal in File Explorer"],
    ["files", "Reveal in Files"],
  ] as const)("maps %s to %s", (kind, expected) => {
    expect(revealInFileExplorerLabelForKind(kind)).toBe(expected);
  });
});
