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

export function recordSettingsEntry(router: AnyRouter, storage?: EntryStorage): () => void {
  try {
    const entryStorage = storage ?? window.sessionStorage;
    const current = historyIndex(router);
    const stored = readEntryIndex(entryStorage);
    if (stored === null || stored > current) {
      entryStorage.setItem(SETTINGS_ENTRY_INDEX_KEY, String(current));
    }
    return () => {
      if (isSettingsPath(router.history.location.pathname)) return;
      try {
        entryStorage.removeItem(SETTINGS_ENTRY_INDEX_KEY);
      } catch {}
    };
  } catch {
    return () => {};
  }
}

export function exitSettings(router: AnyRouter, storage?: EntryStorage) {
  let entry: number | null = null;
  try {
    entry = readEntryIndex(storage ?? window.sessionStorage);
  } catch {}
  const current = historyIndex(router);
  if (entry !== null && entry > 0 && entry <= current) {
    router.history.go(entry - current - 1);
    return;
  }
  void router.navigate({ to: "/" });
}
