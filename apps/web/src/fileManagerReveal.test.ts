import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { fileManagerActionForPresentation, resolveLiteralFilePath } from "./fileManagerReveal";

const localEnvironmentId = EnvironmentId.make("local-environment");
const remoteEnvironmentId = EnvironmentId.make("remote-environment");

describe("resolveLiteralFilePath", () => {
  it.each([
    ["POSIX absolute", "/workspace/file.txt", "/project", "/workspace/file.txt"],
    [
      "Windows drive absolute",
      String.raw`C:\workspace\file.txt`,
      "/project",
      String.raw`C:\workspace\file.txt`,
    ],
    [
      "Windows drive absolute with POSIX separators",
      "C:/workspace/file.txt",
      "/project",
      "C:/workspace/file.txt",
    ],
    [
      "UNC absolute",
      String.raw`\\server\share\file.txt`,
      "/project",
      String.raw`\\server\share\file.txt`,
    ],
    ["POSIX relative path", "src/file.txt", "/project", "/project/src/file.txt"],
    ["literal tilde on POSIX", "~/config.json", "/project", "/project/~/config.json"],
    ["literal colon on POSIX", "notes:1", "/project", "/project/notes:1"],
    [
      "literal backslash on POSIX",
      String.raw`notes\config.json`,
      "/project",
      String.raw`/project/notes\config.json`,
    ],
    [
      "Windows root with POSIX separators",
      "src/file.txt",
      "C:/project",
      String.raw`C:\project\src\file.txt`,
    ],
    [
      "UNC root with POSIX separators",
      "src/file.txt",
      String.raw`\\server\share\project`,
      String.raw`\\server\share\project\src\file.txt`,
    ],
  ] as const)("resolves %s", (_case, path, workspaceRoot, expected) => {
    expect(resolveLiteralFilePath(path, workspaceRoot)).toBe(expected);
  });
});

function presentation(
  environmentId: EnvironmentId,
  input: {
    readonly target?: "local" | "remote";
    readonly os?: "darwin" | "linux" | "windows" | "unknown";
    readonly kind?: "finder" | "file-explorer" | "files";
    readonly enabled?: boolean;
    readonly availableEditors?: ReadonlyArray<"file-manager">;
  } = {},
): Parameters<typeof fileManagerActionForPresentation>[1] {
  const target =
    input.target === "remote"
      ? new PrimaryConnectionTarget({
          environmentId,
          label: "remote",
          httpBaseUrl: "https://remote.example",
          wsBaseUrl: "wss://remote.example",
        })
      : new PrimaryConnectionTarget({
          environmentId,
          label: "local",
          httpBaseUrl: "http://127.0.0.1",
          wsBaseUrl: "ws://127.0.0.1",
        });
  return {
    entry: { target, profile: Option.none() },
    serverConfig: {
      availableEditors: input.availableEditors ?? ["file-manager"],
      environment: { platform: { os: input.os ?? "darwin" } },
      shellRevealInFileManager: input.enabled ?? true,
      ...(input.kind === undefined ? {} : { shellRevealInFileManagerKind: input.kind }),
      ...(input.target === "remote"
        ? { remoteOpenTargets: [{ kind: "tailscale", host: "remote.example" }] }
        : {}),
    },
  };
}

describe("fileManagerActionForPresentation", () => {
  it("opens or reveals a local path through the environment shell command", async () => {
    const result = AsyncResult.success(undefined);
    const command = vi.fn<Parameters<typeof fileManagerActionForPresentation>[2]>();
    command.mockResolvedValue(result);
    const action = fileManagerActionForPresentation(
      localEnvironmentId,
      presentation(localEnvironmentId),
      command,
    );

    await expect(action?.open("/workspace/project")).resolves.toBe(result);
    expect(command).toHaveBeenCalledWith({
      environmentId: localEnvironmentId,
      input: {
        cwd: "/workspace/project",
        editor: "file-manager",
      },
    });
    await expect(action?.reveal("/workspace/project/src/main.ts")).resolves.toBe(result);
    expect(command).toHaveBeenNthCalledWith(2, {
      environmentId: localEnvironmentId,
      input: {
        cwd: "/workspace/project/src/main.ts",
        editor: "file-manager",
        reveal: true,
      },
    });
  });

  it("labels a local Linux files action as opening the containing folder", () => {
    const command = vi.fn<Parameters<typeof fileManagerActionForPresentation>[2]>();
    const action = fileManagerActionForPresentation(
      localEnvironmentId,
      presentation(localEnvironmentId, { os: "linux", kind: "files" }),
      command,
    );

    expect(action).toMatchObject({
      fileManagerName: "Files",
      revealLabel: "Open Containing Folder",
    });
  });

  it.each([
    [
      "the environment is remote",
      remoteEnvironmentId,
      presentation(remoteEnvironmentId, { target: "remote" }),
    ],
    [
      "the server capability is unavailable",
      localEnvironmentId,
      presentation(localEnvironmentId, { enabled: false }),
    ],
    [
      "the file-manager editor is unavailable",
      localEnvironmentId,
      presentation(localEnvironmentId, { availableEditors: [] }),
    ],
  ] as const)("returns null when %s", (_reason, environmentId, environmentPresentation) => {
    const command = vi.fn<Parameters<typeof fileManagerActionForPresentation>[2]>();

    expect(
      fileManagerActionForPresentation(environmentId, environmentPresentation, command),
    ).toBeNull();
  });
});
