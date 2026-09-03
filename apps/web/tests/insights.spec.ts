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
import { FORBIDDEN, fixtures, installFakeWallet, stubApi } from "./stub";
import noOrder from "./fixtures/no-order.json" with { type: "json" };

const agentCard = fixtures.proposeAgent.cardRef;

/**
 * The Risk Profile is now keyed by the wallet address a session proved under
 * ADR-0012, not the old forgeable owner header -- so every journey below has to
 * connect and verify a wallet before the picker will do anything. WalletConnect
 * only lives inside ConfirmModal (issue #30), so this deals a Card, opens the
 * confirmation to reach it, connects, then closes back out -- `walletVerified` is
 * surface state, so it survives the modal closing.
 */
const connectWallet = async (page: Page) => {
  await page.getByRole("button", { name: "I think ETH drops before Friday" }).click();
  await expect(page.getByTestId("chosen-by")).toBeVisible();
  await page.locator(`[data-card-ref="${agentCard}"]`).click();
  await expect(page.getByTestId("confirm-modal")).toBeVisible();
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("confirm-modal")).toHaveCount(0);
};

/** Opens the Insights tab. The profile picker (and, once a profile exists, the
 * Suggestion body) render under this same tab -- no navigation, just a local switch. */
const openInsights = async (page: Page) => {
  // installFakeWallet must run before the first navigation -- it's an init script.
  await installFakeWallet(page);
  await page.goto("/");
  await connectWallet(page);
  await page.getByRole("tab", { name: "Insights" }).click();
  await expect(page.getByRole("radiogroup", { name: "Choose a Risk Profile" })).toBeVisible();
};

const pickBalanced = async (page: Page) => {
  await page.getByRole("radio", { name: /Balanced/ }).click();
  await expect(page.getByRole("radio", { name: /Balanced/ })).toHaveAttribute("aria-checked", "true");
};

test.describe("no wallet connected", () => {
  test("shows a connect prompt instead of the picker, and calls /risk-profile never", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await page.getByRole("tab", { name: "Insights" }).click();

    await expect(page.getByText("Connect your wallet to save a Risk Profile.")).toBeVisible();
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

    // /auth/challenge and /auth/verify are exempt from the scan, not from being fetched:
    // they echo the TRADER'S OWN address back to prove sign-in, which is the same 40-hex
    // shape FORBIDDEN watches for. journeys.spec.ts exempts the same two for the same
    // reason. Every other body still carries none of it.
    const exempt = new Set(["/auth/challenge", "/auth/verify"]);
    const exemptIndexes = new Set(
      traffic.all.flatMap((r, i) => (exempt.has(new URL(r.url()).pathname) ? [i] : []))
    );
    expect(exemptIndexes.size).toBeGreaterThanOrEqual(2);
    for (const [i, body] of traffic.bodies.entries()) {
      if (exemptIndexes.has(i)) continue;
      for (const forbidden of FORBIDDEN) expect(body).not.toMatch(forbidden);
    }
  });
});
