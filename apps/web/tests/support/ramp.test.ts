/**
 * Issue #10 -- the Implied Chance ramp, measured rather than admired.
 *
 * The parent spec rejected red/green for gain and loss on a number: the pair separates
 * by dE 5.5 under deuteranopia, against a threshold of 8. Nothing was holding the
 * replacement to the same bar, and the first thing this test did when it was written
 * was fail -- the original translucent fill separated by dE 2.2, worse than the palette
 * that had been rejected. The ramp and the Card's structure were both changed to pass.
 *
 * It reads `globals.css` rather than a copy of the values, so editing the palette runs
 * the measurement. A ramp that stops being distinguishable is a failing test, not a
 * regression someone notices in a demo.
 *
 * Issue #26 brought the call/put pair under the same bar. That pair is the first thing
 * on the surface rendered as colour ALONE -- the rail's split bar has no text on it --
 * so it is the one place where failing this measurement means information is simply
 * gone rather than merely harder to read.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast, deltaE, over, parseHex, simulate, type RGB } from "./colour.js";

/** The bar red/green was held to and failed. */
const MIN_DELTA_E = 8;
/** WCAG AA for text that is not large. */
const MIN_CONTRAST = 4.5;

const css = readFileSync(fileURLToPath(new URL("../../app/globals.css", import.meta.url)), "utf8");

/**
 * Read a token out of a theme block.
 *
 * Light is the first definition in the file; dark is the last, because it is redefined
 * once for `prefers-color-scheme` and once for the explicit `[data-theme]` override and
 * both must agree with each other anyway.
 */
function token(name: string, theme: "light" | "dark"): string {
  const all = [...css.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8}|[0-9.]+)\\s*;`, "g"))].map((m) => m[1]!);
  expect(all.length, `--${name} is not defined`).toBeGreaterThan(0);
  return theme === "light" ? all[0]! : all[all.length - 1]!;
}

interface Theme {
  name: "light" | "dark";
  ramp: RGB[];
  surface: RGB;
  tintA: number;
  /** Every colour that text is actually painted in on a Card. */
  inks: RGB[];
  /** The call/put pair, and the two grounds it is painted on. */
  call: RGB;
  put: RGB;
  ground: RGB;
}

const themes: Theme[] = (["light", "dark"] as const).map((name) => ({
  name,
  ramp: [0, 1, 2, 3, 4, 5].map((i) => parseHex(token(`r${i}`, name))),
  surface: parseHex(token("surface", name)),
  tintA: Number(token("tintA", name)),
  inks: [parseHex(token("ink", name)), parseHex(token("ink-2", name))],
  call: parseHex(token("call", name)),
  put: parseHex(token("put", name)),
  ground: parseHex(token("ground", name)),
}));

describe.each(themes)("the Implied Chance ramp ($name)", (theme) => {
  it("defines all six steps and a tint alpha", () => {
    expect(theme.ramp).toHaveLength(6);
    expect(theme.tintA).toBeGreaterThan(0);
    expect(theme.tintA).toBeLessThan(1);
  });

  it.each(["deuteranopia", "protanopia"] as const)("separates adjacent steps under %s", (cvd) => {
    for (let i = 1; i < theme.ramp.length; i++) {
      const seen = deltaE(simulate(theme.ramp[i - 1]!, cvd), simulate(theme.ramp[i]!, cvd));
      expect(seen, `steps ${i - 1} and ${i} are ${seen.toFixed(1)} apart under ${cvd}`).toBeGreaterThanOrEqual(
        MIN_DELTA_E
      );
    }
  });

  it("separates adjacent steps for a viewer with typical colour vision too", () => {
    // Stated separately because it is a different failure: a ramp that only works for
    // dichromats would be an odd thing to ship, and the original one failed here first.
    for (let i = 1; i < theme.ramp.length; i++) {
      expect(deltaE(theme.ramp[i - 1]!, theme.ramp[i]!)).toBeGreaterThanOrEqual(MIN_DELTA_E);
    }
  });

  it("keeps every step visible against the Card it sits on", () => {
    // A rail that reads as "not drawn" would make a Card look broken rather than
    // unlikely -- and in the dark theme the step at risk is the deepest one, not the
    // palest, because the ramp runs towards the background rather than away from it.
    for (const [i, step] of theme.ramp.entries()) {
      const seen = deltaE(step, theme.surface);
      expect(seen, `step ${i} is only ${seen.toFixed(1)} from the Card`).toBeGreaterThanOrEqual(MIN_DELTA_E);
    }
  });

  it("runs in one direction, so the Deck reads as a gradient", () => {
    // Sequential, not diverging: each step is further from the FIRST step than the one
    // before it. Measuring from the background instead would be theme-dependent -- the
    // light ramp runs away from its surface and the dark ramp runs towards its own --
    // whereas doubling back, which is the actual failure, looks the same in both.
    const distances = theme.ramp.map((step) => deltaE(theme.ramp[0]!, step));
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]!, `step ${i} is not further along than step ${i - 1}`).toBeGreaterThan(distances[i - 1]!);
    }
  });

  it("stays readable under every text colour a Card paints on the tint", () => {
    for (const [i, step] of theme.ramp.entries()) {
      const tinted = over(step, theme.surface, theme.tintA);
      for (const ink of theme.inks) {
        const ratio = contrast(ink, tinted);
        expect(ratio, `text on the step-${i} tint is only ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
    }
  });
});

describe.each(themes)("call and put ($name)", (theme) => {
  it.each(["deuteranopia", "protanopia"] as const)("separate from each other under %s", (cvd) => {
    // The bar red/green was held to and failed. Blue/orange clears it by a wide margin:
    // 67.0 under deuteranopia and 59.5 under protanopia on the dark pair, which is why
    // it was chosen over five other candidates rather than for looking nicer.
    const seen = deltaE(simulate(theme.call, cvd), simulate(theme.put, cvd));
    expect(seen, `call and put are ${seen.toFixed(1)} apart under ${cvd}`).toBeGreaterThanOrEqual(MIN_DELTA_E);
  });

  it("separates for a viewer with typical colour vision too", () => {
    expect(deltaE(theme.call, theme.put)).toBeGreaterThanOrEqual(MIN_DELTA_E);
  });

  it.each(["ground", "surface"] as const)("clears WCAG AA against the %s", (where) => {
    // The split bar on the rail carries no text, so this is not about legible labels --
    // it is about the bar being visible at all as something other than the background.
    const behind = where === "ground" ? theme.ground : theme.surface;
    for (const [what, colour] of [["call", theme.call], ["put", theme.put]] as const) {
      const ratio = contrast(colour, behind);
      expect(ratio, `${what} on the ${where} is only ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it("is not red and green wearing other names", () => {
    // A cheap structural check beside the expensive perceptual one. Red/green passes a
    // naive "are these different colours" test easily; what it fails is the simulation
    // above. This catches the other direction -- someone reintroducing the hues.
    for (const [what, [r, g, b]] of [["call", theme.call], ["put", theme.put]] as const) {
      const green = g > r && g > b;
      expect(green, `${what} is a green`).toBe(false);
    }
  });
});

describe("the measurement itself", () => {
  it("reproduces the red/green failure the spec recorded", () => {
    // A self-check on the method: the pair this palette replaced must still measure as
    // the reason it was replaced. If this ever passes, the simulation has drifted and
    // every other assertion in this file is worthless.
    const green = parseHex("#0ca30c");
    const red = parseHex("#d03b3b");

    expect(deltaE(simulate(green, "deuteranopia"), simulate(red, "deuteranopia"))).toBeLessThan(MIN_DELTA_E);
  });

  it("agrees that two identical colours are zero apart", () => {
    expect(deltaE(parseHex("#3987e5"), parseHex("#3987e5"))).toBeCloseTo(0, 6);
  });

  it("computes a contrast ratio the WCAG examples agree with", () => {
    expect(contrast(parseHex("#000000"), parseHex("#ffffff"))).toBeCloseTo(21, 2);
    expect(contrast(parseHex("#777777"), parseHex("#ffffff"))).toBeCloseTo(4.48, 1);
  });
});
