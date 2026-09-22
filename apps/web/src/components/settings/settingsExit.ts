import type { AnyRouter } from "@tanstack/react-router";

const SETTINGS_ENTRY_INDEX_KEY = "t3code:settings-entry-index";

type EntryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function historyIndex(router: AnyRouter): number {
  return router.history.location.state.__TSR_index;
}

function isSettingsPath(pathname: string): boolean {
  return /^\/settings(?:\/|$)/.test(pathname);
}

function readEntryIndex(storage: EntryStorage): number | null {
  const raw = storage.getItem(SETTINGS_ENTRY_INDEX_KEY);
  const index = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(index) ? index : null;
}

export function recordSettingsEntry(
  router: AnyRouter,
  storage: EntryStorage = window.sessionStorage,
): () => void {
  const current = historyIndex(router);
  const stored = readEntryIndex(storage);
  if (stored === null || stored > current) {
    storage.setItem(SETTINGS_ENTRY_INDEX_KEY, String(current));
  }
  return () => {
    if (!isSettingsPath(router.history.location.pathname)) {
      storage.removeItem(SETTINGS_ENTRY_INDEX_KEY);
    }
  };
}

export function exitSettings(router: AnyRouter, storage: EntryStorage = window.sessionStorage) {
  const entry = readEntryIndex(storage);
  const current = historyIndex(router);
  if (entry !== null && entry > 0 && entry <= current) {
    router.history.go(entry - current - 1);
    return;
  }
  void router.navigate({ to: "/" });
}
