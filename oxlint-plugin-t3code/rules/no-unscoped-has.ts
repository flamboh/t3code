import { defineRule } from "@oxlint/plugins";

const COMBINATOR_PATTERN = /[\s>+~]/u;
// A class, id, attribute, or leading tag narrows a compound. Negated ones don't,
// so `:not(...)` is removed before this check.
const NARROWING_PATTERN = /[.#[]|^[a-z]/iu;
const ROOT_COMPOUND_PATTERN = /^(?:html|body|:root)(?![\w-])/iu;

/** Tailwind arbitrary variants in a class token: top-level `[...]` groups followed by `:`. */
function variantGroups(token: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < token.length; index++) {
    const char = token[index];
    if (char === "[") {
      if (depth === 0) start = index + 1;
      depth++;
    } else if (char === "]" && depth > 0) {
      depth--;
      if (depth === 0 && token[index + 1] === ":") groups.push(token.slice(start, index));
    }
  }
  return groups;
}

/** The compound selector each `:has(` in `selector` is attached to. */
function hasCompounds(selector: string): string[] {
  const compounds: string[] = [];
  let index = selector.indexOf(":has(");
  while (index !== -1) {
    let start = index - 1;
    let depth = 0;
    // An unbalanced "(" means the :has() sits inside :not()/:is()/:where(),
    // so the compound outside that wrapper still applies.
    for (; start >= 0; start--) {
      const char = selector[start];
      if (char === ")") depth++;
      else if (char === "(") {
        if (depth > 0) depth--;
      } else if (depth === 0 && COMBINATOR_PATTERN.test(char ?? "")) break;
    }
    compounds.push(selector.slice(start + 1, index));
    index = selector.indexOf(":has(", index + 1);
  }
  return compounds;
}

/** `compound` without any `:not(...)`, including one left open around the `:has()`. */
function withoutNegations(compound: string): string {
  let result = "";
  let index = 0;
  while (index < compound.length) {
    if (!compound.startsWith(":not(", index)) {
      result += compound[index];
      index++;
      continue;
    }
    let depth = 0;
    for (index += ":not".length; index < compound.length; index++) {
      if (compound[index] === "(") depth++;
      else if (compound[index] === ")" && --depth === 0) break;
    }
    index++;
  }
  return result;
}

/** Arbitrary variants in `text` whose `:has()` is unanchored or anchored to the document root. */
function findUnscopedHasVariants(text: string): string[] {
  // Selectors are ASCII case-insensitive.
  if (!text.toLowerCase().includes(":has(")) return [];
  const offenders: string[] = [];
  for (const token of text.split(/\s+/u)) {
    for (const group of variantGroups(token)) {
      // Tailwind writes spaces as "_", and "&" is the element carrying the class.
      const selector = group.toLowerCase().replaceAll("_", " ").replaceAll("&", ".self");
      const unscoped = hasCompounds(selector).some((compound) => {
        const anchor = withoutNegations(compound);
        return !NARROWING_PATTERN.test(anchor) || ROOT_COMPOUND_PATTERN.test(anchor);
      });
      if (unscoped) offenders.push(`[${group}]`);
    }
  }
  return offenders;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Tailwind arbitrary variants with a :has() that is not anchored to a class, attribute, id, or tag.",
    },
  },
  create(context) {
    const message = (variant: string) =>
      `Anchor the :has() in ${variant} to a class, attribute, or tag below the document root, e.g. [&+[data-x]_…] or a has-* variant. Chrome evaluates an unanchored :has() on every ancestor, so any DOM change then restyles the whole page.`;
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        for (const variant of findUnscopedHasVariants(node.value)) {
          context.report({ node, message: message(variant) });
        }
      },
      TemplateElement(node) {
        for (const variant of findUnscopedHasVariants(node.value.cooked ?? node.value.raw)) {
          context.report({ node, message: message(variant) });
        }
      },
    };
  },
});
