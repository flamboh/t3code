import {
  PrimaryConnectionTarget,
  type EnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "./test/reactHookHarness";

const testState = vi.hoisted(() => ({
  command: vi.fn(),
  openInEditor: Symbol("openInEditor"),
  presentationsAtom: Symbol("presentations"),
  presentations: null as ReadonlyMap<EnvironmentId, EnvironmentPresentation> | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("./test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: <T>(factory: () => T) => factory(),
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.presentations,
}));

vi.mock("./state/presentation", () => ({
  environmentPresentations: {
    presentationsAtom: testState.presentationsAtom,
  },
}));

vi.mock("./state/shell", () => ({
  shellEnvironment: {
    openInEditor: testState.openInEditor,
  },
}));

vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: () => testState.command,
}));

import { useFileManagerAction } from "./fileManagerReveal";

const localEnvironmentId = EnvironmentId.make("local-environment");
const secondLocalEnvironmentId = EnvironmentId.make("second-local-environment");
const remoteEnvironmentId = EnvironmentId.make("remote-environment");

function serverConfig(input: {
  readonly os: "darwin" | "linux" | "windows";
  readonly kind?: "finder" | "file-explorer" | "files";
  readonly enabled?: boolean;
  readonly availableEditors?: ReadonlyArray<"file-manager">;
  readonly remoteOpenTargets?: ReadonlyArray<{ readonly kind: "tailscale"; readonly host: string }>;
}): ServerConfig {
  return {
    availableEditors: input.availableEditors ?? ["file-manager"],
    environment: { platform: { os: input.os } },
    shellRevealInFileManager: input.enabled ?? true,
    ...(input.kind === undefined ? {} : { shellRevealInFileManagerKind: input.kind }),
    ...(input.remoteOpenTargets === undefined
      ? {}
      : { remoteOpenTargets: input.remoteOpenTargets }),
  } as ServerConfig;
}

function presentation(
  environmentId: EnvironmentId,
  input: {
    readonly target?: "local" | "remote";
    readonly os?: "darwin" | "linux" | "windows";
    readonly kind?: "finder" | "file-explorer" | "files";
    readonly enabled?: boolean;
    readonly availableEditors?: ReadonlyArray<"file-manager">;
  } = {},
): EnvironmentPresentation {
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
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: serverConfig({
      os: input.os ?? "darwin",
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.availableEditors === undefined ? {} : { availableEditors: input.availableEditors }),
      ...(input.target === "remote"
        ? { remoteOpenTargets: [{ kind: "tailscale", host: "remote.example" }] }
        : {}),
    }),
  };
}

function beginResolverRender(
  values: ReadonlyMap<EnvironmentId, EnvironmentPresentation> | null,
): ReturnType<typeof useFileManagerAction> {
  testState.presentations = values;
  hooks.beginRender();
  return useFileManagerAction();
}

describe("useFileManagerAction", () => {
  beforeEach(() => {
    testState.command.mockReset();
    testState.presentations = null;
    hooks.reset();
  });

  it("opens or reveals a local path through the environment shell command", async () => {
    const result = { _tag: "Success", value: undefined } as const;
    testState.command.mockResolvedValue(result);
    const resolveReveal = beginResolverRender(
      new Map([[localEnvironmentId, presentation(localEnvironmentId)]]),
    );

    const action = resolveReveal(localEnvironmentId);

    expect(action?.revealLabel).toBe("Reveal in Finder");
    await expect(action?.open("/workspace/project")).resolves.toBe(result);
    expect(testState.command).toHaveBeenCalledWith({
      environmentId: localEnvironmentId,
      input: {
        cwd: "/workspace/project",
        editor: "file-manager",
      },
    });
    await expect(action?.reveal("/workspace/project/src/main.ts")).resolves.toBe(result);
    expect(testState.command).toHaveBeenNthCalledWith(2, {
      environmentId: localEnvironmentId,
      input: {
        cwd: "/workspace/project/src/main.ts",
        editor: "file-manager",
        reveal: true,
      },
    });
  });

  it("resolves environments at action time", () => {
    const resolveReveal = beginResolverRender(
      new Map([
        [localEnvironmentId, presentation(localEnvironmentId, { os: "darwin" })],
        [secondLocalEnvironmentId, presentation(secondLocalEnvironmentId, { os: "windows" })],
      ]),
    );

    expect(resolveReveal(localEnvironmentId)?.revealLabel).toBe("Reveal in Finder");
    expect(resolveReveal(secondLocalEnvironmentId)?.revealLabel).toBe("Reveal in File Explorer");
  });

  it("uses the server-selected label when one is available", () => {
    const resolveReveal = beginResolverRender(
      new Map([
        [
          localEnvironmentId,
          presentation(localEnvironmentId, { os: "darwin", kind: "file-explorer" }),
        ],
      ]),
    );

    expect(resolveReveal(localEnvironmentId)?.revealLabel).toBe("Reveal in File Explorer");
  });

  it("returns null for a remote environment", () => {
    const resolveReveal = beginResolverRender(
      new Map([[remoteEnvironmentId, presentation(remoteEnvironmentId, { target: "remote" })]]),
    );

    expect(resolveReveal(remoteEnvironmentId)).toBeNull();
  });

  it.each([
    ["the server capability", { enabled: false }],
    ["the file-manager editor", { availableEditors: [] as const }],
  ])("returns null when %s is unavailable", (_reason, input) => {
    const resolveReveal = beginResolverRender(
      new Map([[localEnvironmentId, presentation(localEnvironmentId, input)]]),
    );

    expect(resolveReveal(localEnvironmentId)).toBeNull();
  });
});
