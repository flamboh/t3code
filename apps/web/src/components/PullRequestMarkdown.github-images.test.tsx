import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  resources: [] as Array<unknown>,
  assetState: "success" as "success" | "loading" | "failure",
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.resources.push(resource);
    if (testState.assetState === "loading") return { _tag: "Loading" };
    if (testState.assetState === "failure") return { _tag: "Failure" };
    return { _tag: "Success", url: "https://signed.test/pr-image.png" };
  },
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

vi.mock("./media/MediaActions", () => ({
  MediaActions: ({ children }: { children: ReactNode }) => children,
}));

import { ChatMarkdownAssetImage } from "./ChatMarkdown";
import { PullRequestMarkdown } from "./pullRequest/PullRequestMarkdown";

const threadRef = {
  environmentId: EnvironmentId.make("env-pr"),
  threadId: ThreadId.make("thread-pr"),
};
const ATTACHMENT_URL =
  "https://github.com/user-attachments/assets/f1d65268-4213-47a5-864d-5067e8bf5918";

function render(text: string): string {
  testState.resources = [];
  return renderToStaticMarkup(
    <PullRequestMarkdown
      text={text}
      cwd="/repo"
      environmentId={threadRef.environmentId}
      threadRef={threadRef}
    />,
  );
}

describe("PullRequestMarkdown GitHub images", () => {
  beforeEach(() => {
    testState.assetState = "success";
  });

  it("routes attachment images through the authenticated media flow", () => {
    const html = render(`![screenshot](${ATTACHMENT_URL})`);

    // The renderer carries no GitHub session, so the bytes must come from the server flow
    // that fetches with the repository credential — never a direct load.
    expect(testState.resources).toEqual([
      { _tag: "github-media", cwd: "/repo", url: ATTACHMENT_URL },
    ]);
    expect(html).toContain('src="https://signed.test/pr-image.png"');
    expect(html).not.toContain("Image unavailable");
  });

  it("falls back to the original URL when the signed URL fails", () => {
    testState.assetState = "failure";
    const html = render(`![screenshot](${ATTACHMENT_URL})`);

    expect(testState.resources).toEqual([
      { _tag: "github-media", cwd: "/repo", url: ATTACHMENT_URL },
    ]);
    expect(html).toContain(`src="${ATTACHMENT_URL}"`);
    expect(html).not.toContain("Image unavailable");
  });

  it("routes bare attachment uploads through the same flow", () => {
    const html = render(`${ATTACHMENT_URL}`);

    expect(testState.resources).toEqual([
      { _tag: "github-media", cwd: "/repo", url: ATTACHMENT_URL },
    ]);
    expect(html).toContain("https://signed.test/pr-image.png");
  });

  it("keeps the loading slot through a signed-URL failure, then shows the original", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ChatMarkdownAssetImage
          environmentId={threadRef.environmentId}
          resource={{ _tag: "github-media", cwd: "/repo", url: ATTACHMENT_URL }}
          alt="Screenshot"
          framed={false}
          fallbackSrc={ATTACHMENT_URL}
          originalUrl={ATTACHMENT_URL}
        />,
      );
    });
    try {
      expect(renderer.root.findByType("img").props.src).toBe("https://signed.test/pr-image.png");
      await act(async () => renderer.root.findByType("img").props.onError());
      expect(renderer.root.findByType("img").props.src).toBe(ATTACHMENT_URL);
      expect(renderer.root.findByProps({ "aria-label": "Loading image" })).toBeDefined();
      await act(async () => renderer.root.findByType("img").props.onLoad());
      expect(renderer.root.findByType("img").props.src).toBe(ATTACHMENT_URL);
      expect(renderer.root.findAllByProps({ "aria-label": "Loading image" })).toHaveLength(0);
      await act(async () => renderer.root.findByType("img").props.onError());
      expect(renderer.root.findAllByType("img")).toHaveLength(0);
      expect(renderer.root.findByProps({ role: "alert" })).toBeDefined();
    } finally {
      await act(async () => renderer.unmount());
      vi.unstubAllGlobals();
    }
  });
});
