import { describe, expect, it } from "vite-plus/test";
import { formatUsageLimitReset, usageLimitPresentation } from "./usageLimitPresentation";

describe("usage limit presentation", () => {
  it("includes provider message and localized reset", () => {
    const notice = {
      occurrenceId: "abc",
      provider: "claudeAgent",
      message: "Your plan is at its limit.",
      resetsAt: Date.UTC(2026, 0, 2, 15, 30),
    };
    expect(usageLimitPresentation(notice)).toEqual({
      title: "Claude usage limit reached",
      detail: `Your plan is at its limit. Resets ${formatUsageLimitReset(notice.resetsAt)}.`,
    });
  });
});
