import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";

import { exitSettings, recordSettingsEntry } from "./settingsExit";

it("leaves settings in one step past every scope change", async () => {
  const root = createRootRoute();
  const thread = createRoute({ getParentRoute: () => root, path: "thread" });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "settings",
    validateSearch: (raw: Record<string, unknown>) => ({ machine: String(raw.machine) }),
  });
  const router = createRouter({
    routeTree: root.addChildren([thread, settings]),
    history: createMemoryHistory({ initialEntries: ["/thread"] }),
  });
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  await router.load();
  await router.navigate({ to: "/settings", search: { machine: "a" } });
  recordSettingsEntry(router, storage);
  await router.navigate({ to: "/settings", search: { machine: "b" } });
  await router.navigate({ to: "/settings", search: { machine: "c" } });

  exitSettings(router, storage);
  await router.load();

  expect(router.state.location.pathname).toBe("/thread");
});
