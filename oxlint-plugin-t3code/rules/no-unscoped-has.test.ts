/* oxlint-disable t3code/no-unscoped-has -- the fixtures are invalid on purpose */
import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-unscoped-has", {
  filename: "fixture.tsx",
});

describe("t3code/no-unscoped-has", () => {
  rule.valid(
    "allows :has() on the element itself",
    `const className = "[&:has([data-slot=icon])]:ps-2";`,
  );

  rule.valid(
    "allows :has() anchored to an attribute",
    `const className = "[&+[data-chat-composer-form]:has(>[data-slot=banner])]:mt-0";`,
  );

  rule.valid(
    "allows :has() inside :not() on the element itself",
    `const className = "[&:not(:has(+[data-slot=footer]))]:rounded-b-2xl";`,
  );

  rule.valid(
    "allows built-in has-* variants",
    `const className = "has-[>[data-slot=icon]]:ps-2 group-has-[:checked]:opacity-100";`,
  );

  rule.valid(
    "allows a sibling selector without :has()",
    `const className = "[&+*_[data-chat-composer-form]>[data-slot=attachment]]:before:rounded-none";`,
  );

  rule.valid("ignores prose mentioning :has()", `const note = "uses :has( for styling";`);

  rule.invalid(
    "reports a sibling :has() with nothing anchoring it",
    `const className = "[&+:has([data-chat-composer-form])_[data-chat-composer-form]]:before:rounded-none";`,
    (output) => {
      assert.match(output, /Anchor the :has\(\)/);
    },
  );

  rule.invalid(
    "reports a descendant :has() with nothing anchoring it",
    `const className = cn("p-2", "[&_:has(>input)]:gap-1");`,
  );

  rule.invalid(
    "reports a universal :has() ancestor",
    "const className = `flex [*:has([data-open])_&]:hidden`;",
  );

  rule.invalid(
    "reports :has() anchored to the document root",
    `const className = "[body:has([data-dialog-open])_&]:overflow-hidden";`,
  );
});
