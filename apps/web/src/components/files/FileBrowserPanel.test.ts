import { describe, expect, it } from "vite-plus/test";

import { fileBrowserEntryTargetPath } from "./FileBrowserPanel";

describe("file browser reveal paths", () => {
  it("resolves directory rows without passing their tree slash to the shell", () => {
    expect(fileBrowserEntryTargetPath("/Users/olive/project", "src/components/")).toBe(
      "/Users/olive/project/src/components",
    );
  });
});
