import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { fileManagerActionForPresentation } from "./fileManagerReveal";

const localEnvironmentId = EnvironmentId.make("local-environment");
const remoteEnvironmentId = EnvironmentId.make("remote-environment");

function presentation(
  environmentId: EnvironmentId,
  input: {
    readonly target?: "local" | "remote";
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
      environment: { platform: { os: "darwin" } },
      shellRevealInFileManager: input.enabled ?? true,
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
