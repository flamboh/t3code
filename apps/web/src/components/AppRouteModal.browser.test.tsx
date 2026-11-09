import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal } from "./AppRouteModal";

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });
});

function ModalLauncher() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Settings launcher</button>
      {open ? (
        <AppRouteModal label="Settings">
          <CommitOnBlurField onCommit={() => {}} />
        </AppRouteModal>
      ) : null}
    </>
  );
}

it("returns focus to the launcher on close", async () => {
  await using screen = await render(<ModalLauncher />);
  const launcher = screen.getByRole("button", { name: "Settings launcher" });
  await launcher.click();
  await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(launcher).toHaveFocus();
});
