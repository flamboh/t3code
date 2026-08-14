import { describe, expect, it } from "vite-plus/test";
import {
  formatUsageLimitReset,
  readUsageLimit,
  usageLimitAutoContinueLabel,
  usageLimitBannerItem,
} from "./usageLimitBanner";

describe("usage limit banner", () => {
  it("shows provider, supplied message, and localized reset time", () => {
    const notice = {
      occurrenceId: "abc",
      provider: "claudeAgent",
      message: "Try again later.",
      resetsAt: Date.UTC(2026, 0, 2, 15, 30),
    };
    const item = usageLimitBannerItem(notice);

    expect(item.title).toBe("Claude usage limit reached");
    expect(item.description).toBe(
      `Try again later. Resets ${formatUsageLimitReset(notice.resetsAt)}.`,
    );
    expect(item.id).toBe("usage-limit:abc");
  });

  it("accepts notices without a reset and rejects malformed values", () => {
    expect(
      usageLimitBannerItem({ occurrenceId: "abc", provider: "Codex", message: "Limit hit." })
        .description,
    ).toBe("Limit hit.");
    expect(readUsageLimit(null)).toBeNull();
    expect(readUsageLimit({ provider: "Codex" })).toBeNull();
  });

  it("exposes a reversible auto-continue label from the server marker", () => {
    expect(
      usageLimitAutoContinueLabel({
        occurrenceId: "abc",
        provider: "claudeAgent",
        message: "Limit hit.",
        autoContinue: true,
      }),
    ).toBe("Disable auto-continue");
  });
});
