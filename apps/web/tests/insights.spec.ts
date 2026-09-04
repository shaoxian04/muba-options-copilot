/**
 * Task 6 -- the Insights tab's Risk Profile / Suggestion card, walked end to end.
 *
 * Nothing covered this before: `stub.ts` 404s anything unstubbed on purpose, so any
 * journey that opened the Insights tab was failing the moment `SuggestionCard` fetched
 * `/risk-profile` on mount. This file is that coverage.
 *
 * `/forecast/ask` stays deliberately unstubbed here -- typing into the ask-row is out of
 * scope for this file, same as the handoff scoped it.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { FORBIDDEN, signIn, stubApi } from "./stub";
import noOrder from "./fixtures/no-order.json" with { type: "json" };

/**
 * The Risk Profile is keyed on the signed-in account (ADR-0017), not a wallet -- so
 * every journey below only has to sign in. No wallet is connected anywhere in this
 * file.
 */
const openInsights = async (page: Page) => {
  await signIn(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Insights" }).click();
  await expect(page.getByRole("radiogroup", { name: "Choose a Risk Profile" })).toBeVisible();
};

const pickBalanced = async (page: Page) => {
  await page.getByRole("radio", { name: /Balanced/ }).click();
  // Choosing a profile closes the sheet (RiskProfileChip's `choose()` runs `close()` in its
  // `finally`), so the radio has already unmounted by the time this resolves -- the pick is
  // verified through the closed chip's own label instead.
  await expect(page.getByRole("radio", { name: /Balanced/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Balanced" })).toBeVisible();
};

test.describe("not signed in", () => {
  test("shows a sign-in prompt instead of the picker, and calls /risk-profile never", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await page.getByRole("tab", { name: "Insights" }).click();

    // The chip itself is disabled when signed out, so its sheet -- and the fuller
    // "Sign in to save a Risk Profile." sentence inside it -- can never open; the
    // chip's own collapsed label is the whole prompt a signed-out Trader ever sees.
    await expect(page.getByRole("button", { name: "Sign in for a Risk Profile" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Choose a Risk Profile" })).toHaveCount(0);
    expect(traffic.paths()).not.toContain("/risk-profile");
  });
});

test.describe("the Risk Profile picker", () => {
  test("opening Insights renders the picker and issues no 404", async ({ page }) => {
    const traffic = await stubApi(page);
    await openInsights(page);

    // Nothing was picked yet -- SuggestionCard does not call /suggestion until a
    // profile exists, so the only new request here is the GET /risk-profile probe.
    expect(traffic.paths()).toContain("/risk-profile");
    for (const body of traffic.bodies) expect(body).not.toContain('"not stubbed"');
  });

  test("picking a profile PUTs it, it persists, and a Suggestion request follows", async ({ page }) => {
    const traffic = await stubApi(page);
    await openInsights(page);

    await pickBalanced(page);

    const puts = traffic.all.filter((r) => new URL(r.url()).pathname === "/risk-profile" && r.method() === "PUT");
    expect(puts.length).toBeGreaterThanOrEqual(1);
    expect(puts.at(-1)!.postDataJSON()).toEqual({ profile: "balanced" });

    // The pick survives -- not just an optimistic click that reverts.
    await expect(page.getByRole("button", { name: "Balanced" })).toBeVisible();
    await expect.poll(() => traffic.paths().filter((p) => p === "/suggestion").length).toBeGreaterThanOrEqual(1);
  });
});

test.describe("a Suggestion", () => {
  test("renders its copy and both actions", async ({ page }) => {
    await stubApi(page);
    await openInsights(page);
    await pickBalanced(page);

    await expect(page.getByText("Protects ETH if the price drops")).toBeVisible();
    await expect(page.getByRole("button", { name: "See what this buys" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
  });

  test("Accept switches to the Trade tab, deals a Deck, records the Decision, and never touches /fill", async ({ page }) => {
    const traffic = await stubApi(page);
    await openInsights(page);
    await pickBalanced(page);
    await expect(page.getByRole("button", { name: "See what this buys" })).toBeVisible();

    await page.getByRole("button", { name: "See what this buys" }).click();

    // Accept is not a purchase (ADR-0008): it records a Decision and deals a fresh
    // Deck from the Suggestion's own intent -- a Card still has to be picked and
    // Confirm still has to be pressed before anything is signed.
    await expect(page.getByRole("tab", { name: "Trade", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("chosen-by")).toBeVisible();

    await expect.poll(() => traffic.paths()).toEqual(
      expect.arrayContaining(["/deck", "/propose"])
    );

    const decisions = traffic.all.filter((r) => new URL(r.url()).pathname === "/decisions");
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.postDataJSON()).toMatchObject({
      decision: "ACCEPTED",
      intent: { underlying: "ETH", direction: "DOWN", sizeUsdc: 2, horizonDays: 1 },
    });

    expect(traffic.paths()).not.toContain("/fill");
  });

  /*
    The regression this suite could not see before.

    `/propose` takes the NEAREST live expiry; `/deck` filters on the exact one. A
    Suggestion over 3 days is dealt the 2-day $2,380 put, so the Card it names is in
    `deck-down-2` -- not in the row the surface was showing. Until the answer carried
    its own `horizonDays`, the surface stayed on the wrong expiry and the ring landed
    on nothing a Trader could match to the tag above it.

    Note the fixtures number cardRefs per file, so `card-0` here is genuinely the
    2-day $2,380 Card in `deck-down-2` and a different Order than `deck-down-1`'s
    `card-0` -- which is exactly why the assertions below check the STRIKE, not the ref.
  */
  test("Accept follows the proposal to its own expiry and rings the Card it named", async ({ page }) => {
    await stubApi(page, "suggestion-off-horizon");
    await openInsights(page);
    await pickBalanced(page);
    await page.getByRole("button", { name: "See what this buys" }).click();

    await expect(page.getByRole("tab", { name: "Trade", exact: true })).toHaveAttribute("aria-selected", "true");

    // The Suggestion asked for 3 days; the Order dealt expires in 2, so that is the
    // chip that has to be live and selected. Given longer than the default: accept is
    // three round trips deep -- /suggestion, /propose, then the Deck reload the answer
    // triggers -- and the default 5s is tight for that under a full parallel run.
    await expect(page.getByTestId("horizon-2")).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });

    // Exactly one Card is ringed, and it is the one the tag names.
    await expect(page.getByTestId("chosen-by")).toContainText("the agent picked $2,380.00");
    const dealt = page.locator("[data-testid='card'].dealt");
    await expect(dealt).toHaveCount(1);
    await expect(dealt).toContainText("$2,380.00");
  });

  test("Dismiss collapses to the dismissed state and records the Decision", async ({ page }) => {
    const traffic = await stubApi(page);
    await openInsights(page);
    await pickBalanced(page);
    await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();

    await page.getByRole("button", { name: "Dismiss" }).click();

    await expect(page.getByText("Dismissed.")).toBeVisible();
    await expect(page.getByRole("button", { name: "See what this buys" })).toHaveCount(0);

    const decisions = traffic.all.filter((r) => new URL(r.url()).pathname === "/decisions");
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.postDataJSON()).toMatchObject({ decision: "DISMISSED" });
  });

  test("Accept logs no Decision when the Suggestion could not be dealt", async ({ page }) => {
    const traffic = await stubApi(page);
    await openInsights(page);
    await pickBalanced(page);
    await expect(page.getByRole("button", { name: "See what this buys" })).toBeVisible();

    // NO_ORDER is a 200, so `deal` resolves normally -- only its return value says the
    // Trader got nothing. Accept used to log ACCEPTED anyway, and a Trader who pressed
    // it again logged a second one, quietly inflating /decisions/stats.
    // Registered after stubApi's own route, which is what makes it win.
    await page.route("**/propose", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(noOrder) })
    );

    await page.getByRole("button", { name: "See what this buys" }).click();

    await expect(page.getByText("Could not deal that Suggestion", { exact: false })).toBeVisible();
    // Still on Insights, where they pressed -- not switched to a Trade tab holding
    // nothing. The radiogroup itself is a poor proxy for this: picking a profile
    // already closed its sheet, same as every other pick in this file.
    await expect(page.getByRole("tab", { name: "Insights" })).toHaveAttribute("aria-selected", "true");
    expect(traffic.all.filter((r) => new URL(r.url()).pathname === "/decisions")).toEqual([]);
  });
});

test.describe("no signal", () => {
  test("shows the 'nothing to suggest' copy and offers no Accept button", async ({ page }) => {
    await stubApi(page, "no-signal");
    await openInsights(page);
    await pickBalanced(page);

    await expect(page.getByText("Nothing to suggest right now.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "See what this buys" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  });
});

test.describe("quality bar", () => {
  test("no critical or serious accessibility violations with a Suggestion on screen", async ({ page }) => {
    await stubApi(page);
    await openInsights(page);
    await pickBalanced(page);
    await expect(page.getByRole("button", { name: "See what this buys" })).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id)).toEqual([]);
  });

  test("nothing that names an Order leaks through the Insights tab's traffic", async ({ page }) => {
    const traffic = await stubApi(page);
    await openInsights(page);
    await pickBalanced(page);
    await expect(page.getByRole("button", { name: "See what this buys" })).toBeVisible();
    await page.getByRole("button", { name: "See what this buys" }).click();
    await expect(page.getByTestId("chosen-by")).toBeVisible();

    // No wallet is ever connected in this file (the Risk Profile is account-keyed,
    // ADR-0017), so there is no proven-wallet-address exemption needed here the way
    // journeys.spec.ts needs one for /auth/challenge and /auth/verify.
    for (const body of traffic.bodies) {
      for (const forbidden of FORBIDDEN) expect(body).not.toMatch(forbidden);
    }
  });
});
