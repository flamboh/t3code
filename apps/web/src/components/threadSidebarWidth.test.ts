import { describe, expect, it } from "vite-plus/test";

import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
} from "./threadSidebarWidth";

describe("thread sidebar width", () => {
  it("clamps the maximum and initial width to a raised minimum", () => {
    const minimumWidth = 244;

    expect(resolveThreadSidebarMaximumWidth(900, minimumWidth)).toBe(260);
    expect(resolveThreadSidebarMaximumWidth(600, minimumWidth)).toBe(minimumWidth);
    expect(resolveInitialThreadSidebarWidth(220, 900, minimumWidth)).toBe(minimumWidth);
    expect(resolveInitialThreadSidebarWidth(null, 900, minimumWidth)).toBe(256);
    expect(resolveInitialThreadSidebarWidth(null, 900, 300)).toBe(300);
  });
});
