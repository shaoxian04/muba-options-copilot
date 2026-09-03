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
  await expect(page.getByRole("radio", { name: /Balanced/ })).toHaveAttribute("aria-checked", "true");
};

test.describe("not signed in", () => {
  test("shows a sign-in prompt instead of the picker, and calls /risk-profile never", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await page.getByRole("tab", { name: "Insights" }).click();

    await expect(page.getByText("Sign in to save a Risk Profile.")).toBeVisible();
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
    await expect(page.getByRole("radio", { name: /Balanced/ })).toHaveAttribute("aria-checked", "true");
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
    // nothing.
    await expect(page.getByRole("radiogroup", { name: "Choose a Risk Profile" })).toBeVisible();
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
