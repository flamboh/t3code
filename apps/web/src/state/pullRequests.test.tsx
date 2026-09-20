import {
  EnvironmentId,
  ProjectId,
  type PullRequestListEntry,
  type PullRequestListResult,
  type PullRequestSummary,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry, AppAtomRegistryProvider } from "../rpc/atomRegistry";
import {
  pullRequestEnvironment,
  pullRequestListEntryToSummary,
  usePullRequestList,
  useSharedPullRequestSummary,
} from "./pullRequests";

vi.mock("@t3tools/client-runtime/state/pull-requests", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@t3tools/client-runtime/state/pull-requests")>();
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const list = Atom.make<AsyncResult.AsyncResult<PullRequestListResult>>(
    AsyncResult.initial(false),
  );
  return { ...original, createPullRequestEnvironmentAtoms: () => ({ list: () => list }) };
});

const environmentId = EnvironmentId.make("cache-test");
const target = { environmentId, input: { state: "open" as const } };
const projectId = ProjectId.make("pull-request-cache-test");
let renderer: ReactTestRenderer | undefined;

function entry(overrides: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  return {
    provider: "github",
    host: "github.com",
    projectId,
    projectTitle: "Cache test",
    repository: "acme/widget",
    number: 7,
    title: "Improve widget",
    url: "https://github.com/acme/widget/pull/7",
    author: { login: "oliver", name: null, avatarUrl: null },
    headBranch: "improve-widget",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 4,
    deletions: 2,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    ...overrides,
  };
}

function answer(...entries: PullRequestListEntry[]): PullRequestListResult {
  return {
    viewers: { "github.com": "oliver" },
    providers: [],
    entries,
    errors: [],
    truncated: false,
    nextCursors: {},
  };
}

const row = entry();
let observed: PullRequestSummary | null = null;

function ListProbe() {
  usePullRequestList([target]);
  return null;
}

function SidebarProbe({
  current = null,
  observedAt,
}: {
  current?: PullRequestSummary | null;
  observedAt?: number | null;
}) {
  const summary = useSharedPullRequestSummary(environmentId, row, current, observedAt);
  useLayoutEffect(() => {
    observed = summary;
  }, [summary]);
  return null;
}

async function mount(element: React.ReactElement) {
  await act(() => {
    renderer?.unmount();
    renderer = create(<AppAtomRegistryProvider>{element}</AppAtomRegistryProvider>);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observed = null;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("pull request summary cache", () => {
  it("uses observation time for same-dated status changes without replaying stale queries", async () => {
    const first = entry({ mergeability: "mergeable", checksState: "passing", observedAt: 200 });
    const listAtom = pullRequestEnvironment.list(target) as Atom.Writable<
      AsyncResult.AsyncResult<PullRequestListResult>
    >;
    appAtomRegistry.set(listAtom, AsyncResult.success(answer(first), { timestamp: 200 }));
    await mount(<ListProbe />);

    const updated = entry({
      mergeability: "conflicting",
      checksState: "failing",
      updatedAt: first.updatedAt,
      observedAt: 300,
    });
    await mount(
      <SidebarProbe
        current={{ ...pullRequestListEntryToSummary(updated), observedAt: 100 }}
        observedAt={100}
      />,
    );
    expect(observed?.mergeability).toBe("mergeable");
    expect(observed?.checksState).toBe("passing");
    appAtomRegistry.set(listAtom, AsyncResult.success(answer(updated), { timestamp: 300 }));
    await mount(<ListProbe />);
    await mount(<SidebarProbe />);
    expect(observed?.mergeability).toBe("conflicting");
    expect(observed?.checksState).toBe("failing");

    // An older filtered/server-cached response finishes last but must not roll status back.
    appAtomRegistry.set(listAtom, AsyncResult.success(answer(first), { timestamp: 500 }));
    await mount(<ListProbe />);
    await mount(<SidebarProbe />);
    expect(observed?.mergeability).toBe("conflicting");
    expect(observed?.checksState).toBe("failing");

    await mount(
      <SidebarProbe
        current={{ ...pullRequestListEntryToSummary(first), checksState: null, observedAt: 400 }}
        observedAt={400}
      />,
    );
    expect(observed?.mergeability).toBe("mergeable");
    expect(observed?.checksState).toBeNull();
    await mount(<ListProbe />);
    await mount(<SidebarProbe />);
    expect(observed?.mergeability).toBe("mergeable");
    expect(observed?.checksState).toBeNull();
  });
});
