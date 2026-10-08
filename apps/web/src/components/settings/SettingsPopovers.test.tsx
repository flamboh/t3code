// @vitest-environment jsdom

import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: unknown) => unknown }) =>
    select({ hash: "", state: {} }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "primary-settings",
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(["primary-settings"]),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { upsertKeybinding: vi.fn(), removeKeybinding: vi.fn() },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettingsAvailable: () => true }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
vi.mock("./useScopedSettings", () => ({
  useClearScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => null,
  useSettingsScope: () => {
    const environment = {
      environmentId: "primary-settings",
      serverConfig: { keybindings: [], keybindingsConfigPath: null, availableEditors: [] },
    };
    return { environment, connectedEnvironments: [environment] };
  },
}));

import { Tooltip, TooltipPopup } from "../ui/tooltip";
import { SettingInheritance } from "./SettingInheritance";
import { DiagnosticsTooltip, DiagnosticsTooltips } from "./DiagnosticsTooltip";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";
import { SettingsPageContainer } from "./settingsLayout";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("settings shared popover routing", () => {
  it("keeps inheritance tooltips connected beneath another tooltip root", async () => {
    await act(async () => {
      root.render(
        <SettingsPageContainer>
          <Tooltip>
            <SettingInheritance
              state="default"
              summary="Built-in default"
              targets={[
                {
                  environmentId: EnvironmentId.make("primary-settings"),
                  label: "Test environment",
                  projectId: null,
                  ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null),
                },
              ]}
              environments={[]}
              keys={["defaultAutoPull"]}
            />
            <TooltipPopup>Other tooltip content</TooltipPopup>
          </Tooltip>
        </SettingsPageContainer>,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>("button");
    if (!trigger) throw new Error("Missing inheritance trigger");

    await act(async () => trigger.focus());

    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
      "Built-in default",
    );
  });

  it("opens the when-expression builder inside the page's inheritance provider", async () => {
    await act(async () => root.render(<KeybindingsSettingsPanel />));
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Edit when clause for"]',
    );
    if (!trigger) throw new Error("Missing when-clause trigger");

    await act(async () => trigger.click());

    const expression = document.querySelector<HTMLInputElement>(
      'input[aria-label="When expression"]',
    );
    expect(expression).not.toBeNull();
    await act(async () => {
      expression?.focus();
      expression?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('input[aria-label="When expression"]')).toBeNull();
  });

  it("shows Diagnostics content inside the page's inheritance provider", async () => {
    await act(async () => {
      root.render(
        <DiagnosticsTooltips>
          <SettingsPageContainer>
            <DiagnosticsTooltip tooltip="CPU used by the server process">
              Server CPU
            </DiagnosticsTooltip>
          </SettingsPageContainer>
        </DiagnosticsTooltips>,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>("button");
    if (!trigger) throw new Error("Missing Diagnostics tooltip trigger");

    await act(async () => trigger.focus());

    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
      "CPU used by the server process",
    );
  });
});
