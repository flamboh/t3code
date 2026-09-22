import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { exitSettings, recordSettingsEntry } from "./settingsExit";

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

function createTestRouter(initialEntry: string) {
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: "/" });
  const thread = createRoute({ getParentRoute: () => root, path: "thread" });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "settings",
    validateSearch: (raw: Record<string, unknown>) => ({
      machine: typeof raw.machine === "string" ? raw.machine : undefined,
    }),
  });
  const general = createRoute({ getParentRoute: () => settings, path: "general" });
  const providers = createRoute({ getParentRoute: () => settings, path: "providers" });
  return createRouter({
    routeTree: root.addChildren([home, thread, settings.addChildren([general, providers])]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

describe("exitSettings", () => {
  it("returns to the page that opened settings past every page and scope change", async () => {
    const router = createTestRouter("/thread");
    const storage = createStorage();
    await router.load();
    await router.navigate({ to: "/settings/general" });
    recordSettingsEntry(router, storage);
    await router.navigate({ to: "/settings/general", search: { machine: "a" } });
    await router.navigate({ to: "/settings/providers", search: { machine: "b" } });

    exitSettings(router, storage);
    await router.load();

    expect(router.state.location.pathname).toBe("/thread");
  });

  it("keeps the opening page across a reload inside settings", async () => {
    const router = createTestRouter("/thread");
    const storage = createStorage();
    await router.load();
    await router.navigate({ to: "/settings/general" });
    const cleanup = recordSettingsEntry(router, storage);
    await router.navigate({ to: "/settings/providers", search: { machine: "a" } });
    cleanup();
    recordSettingsEntry(router, storage);

    exitSettings(router, storage);
    await router.load();

    expect(router.state.location.pathname).toBe("/thread");
  });

  it("forgets the opening page after leaving settings", async () => {
    const router = createTestRouter("/thread");
    const storage = createStorage();
    await router.load();
    await router.navigate({ to: "/settings/general" });
    const cleanup = recordSettingsEntry(router, storage);
    await router.navigate({ to: "/" });
    cleanup();
    await router.navigate({ to: "/settings/providers" });
    recordSettingsEntry(router, storage);

    exitSettings(router, storage);
    await router.load();

    expect(router.state.location.pathname).toBe("/");
  });

  it("goes home when settings was the first page", async () => {
    const router = createTestRouter("/settings/general");
    const storage = createStorage();
    await router.load();
    recordSettingsEntry(router, storage);
    await router.navigate({ to: "/settings/general", search: { machine: "a" } });

    exitSettings(router, storage);
    await router.load();

    expect(router.state.location.pathname).toBe("/");
  });
});
