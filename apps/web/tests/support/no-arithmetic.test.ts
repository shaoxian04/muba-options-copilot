/**
 * The rule that a figure is never derived in React, made a failing test.
 *
 * "The server formats every number" is the invariant most likely to be broken by
 * accident, because breaking it looks like ordinary React. A `toFixed(2)` in a
 * component is one keystroke, reviews miss it, and the result is a number on screen
 * that no server ever vouched for -- ADR-0006 undone in the least visible place in the
 * codebase.
 *
 * So the rule is checked rather than remembered. Components and pages may not turn a
 * number into text at all. Two files may, each for a reason that is written down in it:
 *
 *   - `clock.ts` formats DURATIONS, which no response can carry because they are stale
 *     the moment they are sent.
 *   - `geometry.ts` produces COORDINATES and WIDTHS, which are never read as text.
 *
 * Test-only maths does not get an exemption, it gets moved: the colour measurement that
 * used to sit in `lib/` now lives beside this file, so shipped `lib/` is only shipped
 * code and the list stays at two.
 *
 * If this test fails, the fix is almost never to add a file to the exemptions. It is
 * either to move the arithmetic into `lib/`, or -- far more often -- to make the server
 * send the string.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const web = fileURLToPath(new URL("../..", import.meta.url));

/** Turning a number into text. Every one of these produces a string a Trader could read. */
const FORMATTERS = [
  /\btoFixed\s*\(/,
  /\btoPrecision\s*\(/,
  /\btoLocaleString\s*\(/,
  /\bIntl\.NumberFormat\b/,
  /\bnew\s+Intl\./,
];

/**
 * Deriving a figure. Rounding is the one that matters: a rounded value rendered as text
 * is exactly the drift this rule exists to stop, and it is the operation someone reaches
 * for when a display string is "nearly" what they wanted.
 */
const ROUNDERS = [/\bMath\.(round|floor|ceil|trunc)\s*\(/];

/** Files that may do arithmetic, each with the reason stated in the file itself. */
const EXEMPT = new Set(["lib/clock.ts", "lib/geometry.ts"]);

/**
 * The file with its comments removed.
 *
 * Every rule below is about what the code DOES, so prose that mentions `toFixed` or
 * quotes a price is not a violation -- and the alternative, banning the words, would
 * make it impossible to write down why these rules exist.
 */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === ".next") return [];
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

const sources = ["app", "components", "lib"]
  .flatMap((d) => walk(join(web, d)))
  .map((f) => {
    const raw = readFileSync(f, "utf8");
    return { path: relative(web, f).replace(/\\/g, "/"), raw, text: code(raw) };
  });

describe("no figure is derived in React", () => {
  it("finds the files it is meant to be guarding", () => {
    // A glob that silently matches nothing is a test that silently passes forever.
    expect(sources.length).toBeGreaterThan(6);
    expect(sources.map((s) => s.path)).toContain("components/DeckRow.tsx");
    expect(sources.map((s) => s.path)).toContain("app/page.tsx");
  });

  it.each(sources.filter((s) => !EXEMPT.has(s.path)))("$path formats no numbers", ({ path, text }) => {
    for (const pattern of FORMATTERS) {
      expect(pattern.test(text), `${path} formats a number with ${pattern}`).toBe(false);
    }
  });

  it.each(sources.filter((s) => !EXEMPT.has(s.path)))("$path rounds no numbers", ({ path, text }) => {
    for (const pattern of ROUNDERS) {
      expect(pattern.test(text), `${path} rounds a value with ${pattern}`).toBe(false);
    }
  });

  it("keeps the exemptions few, named, and real", () => {
    for (const path of EXEMPT) expect(sources.map((s) => s.path)).toContain(path);
    // Two, and the number is written into CLAUDE.md and the README. An exemption list
    // that quietly grows is the invariant dying without anyone deciding to kill it.
    expect(EXEMPT.size).toBe(2);
  });

  it("makes every exempt file explain itself", () => {
    // The exemption is only safe while the reason survives. A file that loses its
    // explanation has lost the argument for being on this list.
    for (const path of EXEMPT) {
      const file = sources.find((s) => s.path === path)!;
      expect(file.raw.slice(0, 2000), `${path} does not say why it may do arithmetic`).toMatch(
        /never .*(text|read)|coordinates|durations|test-only/i
      );
    }
  });
});

describe("no component invents a currency string", () => {
  it.each(sources.filter((s) => s.path.startsWith("components/") || s.path.startsWith("app/")))(
    "$path writes no dollar signs of its own",
    ({ path, text }) => {
      // Every price on this surface arrives with its "$" already attached. A "$" typed
      // into JSX means a component decided how money looks, which is the same mistake
      // as `toFixed` wearing different clothes.
      const jsxDollars = text.match(/\$(?!\{)/g) ?? [];
      expect(jsxDollars.length, `${path} contains a literal "$"`).toBe(0);
    }
  );
});
