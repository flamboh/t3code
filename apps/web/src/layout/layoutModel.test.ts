import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resizeLayoutColumnEdge,
  selectLayoutPaneSlots,
  moveLayoutTab,
  shareLayoutBeside,
  THREAD_TERMINAL_SURFACE_ID,
  type LayoutState,
} from "./layoutModel";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread"));
const otherRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("other"));

describe("moveLayoutTab", () => {
  it("gives a pane's height back to the pane in its column it moves into", () => {
    const base: LayoutState = {
      focusedWorkspaceId: "workspace",
      workspaces: [
        {
          id: "workspace",
          name: null,
          focusedPaneId: "chat-pane",
          cameraWidth: 1200,
          columns: [
            {
              id: "column",
              width: 1,
              panes: [
                {
                  id: "chat-pane",
                  size: 0.55,
                  activeTabId: "chat",
                  tabs: [
                    {
                      id: "chat",
                      content: { kind: "chat", target: { kind: "server", threadRef } },
                    },
                    {
                      id: "terminal",
                      content: {
                        kind: "surface",
                        threadRef,
                        surfaceId: THREAD_TERMINAL_SURFACE_ID,
                      },
                    },
                  ],
                },
                {
                  id: "other-pane",
                  size: 0.45,
                  activeTabId: "other-terminal",
                  tabs: [
                    {
                      id: "other-terminal",
                      content: {
                        kind: "surface",
                        threadRef: otherRef,
                        surfaceId: THREAD_TERMINAL_SURFACE_ID,
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const shown = shareLayoutBeside(
      moveLayoutTab(base, "terminal", { kind: "split", paneId: "chat-pane", side: "down" }),
      "terminal",
      "chat",
      "terminal",
      1 / 3,
      "shrink-then-scroll",
      0,
    );
    const hidden = moveLayoutTab(shown, "terminal", {
      kind: "pane",
      paneId: "chat-pane",
      index: 1,
    });
    const sizes = hidden.workspaces[0]!.columns[0]!.panes.map((pane) => [pane.id, pane.size]);
    expect(sizes).toEqual([
      ["chat-pane", expect.closeTo(0.55)],
      ["other-pane", expect.closeTo(0.45)],
    ]);
  });
});



const column = (id: string, width: number) => ({
  id,
  width,
  panes: [{ id: `${id}-pane`, tabs: [], activeTabId: null, size: 1 }],
});

function drawnRightEdges(state: LayoutState, viewportWidth: number): number[] {
  const { slots, stripWidth } = selectLayoutPaneSlots(state.workspaces[0]!, {
    width: viewportWidth,
    whenNoRoom: "shrink-then-scroll",
  });
  return slots.map((slot) =>
    Math.round((slot.rect.left + slot.rect.width) * stripWidth * viewportWidth),
  );
}

describe("resizeLayoutColumnEdge", () => {
  it("keeps the dragged edge under the pointer when the strip was arranged wider than the window", () => {
    const viewportWidth = 1000;
    const base: LayoutState = {
      focusedWorkspaceId: "workspace",
      workspaces: [
        {
          id: "workspace",
          name: null,
          focusedPaneId: null,
          cameraWidth: 1200,
          columns: [column("chat", 0.5), column("terminal", 0.55)],
        },
      ],
    };
    const { unitWidth } = selectLayoutPaneSlots(base.workspaces[0]!, {
      width: viewportWidth,
      whenNoRoom: "shrink-then-scroll",
    });
    expect(drawnRightEdges(base, viewportWidth)).toEqual([600, 1260]);

    const pointers = Array.from({ length: 41 }, (_, index) => 300 + index * 10);
    const drawn = pointers.map((pointer) =>
      drawnRightEdges(
        resizeLayoutColumnEdge(base, "chat", pointer / viewportWidth, viewportWidth, unitWidth),
        viewportWidth,
      ),
    );
    expect(drawn).toEqual(pointers.map((pointer) => [pointer, pointer + 660]));
  });
});
