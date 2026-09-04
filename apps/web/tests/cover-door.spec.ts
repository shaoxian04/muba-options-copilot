/**
 * The door: "Cover this loan", its confirmation, and the two signatures behind it.
 *
 * Driven through the network seam against the checked-in Cover fixtures. The dialog is
 * the same shape `ConfirmModal`/`RfqModal` already use on the trading surface -- this
 * suite checks the Cover-specific content (the belief, the cap, the gate, the Coverage)
 * and the invariants ADR-0008 and ADR-0017 exist to enforce:
 *
 *   - no request reaches `/rfq` before a deliberate click;
 *   - no premium is shown until a maker has actually answered;
 *   - the money is spent by a SECOND press on a button that names the price, never as a
 *     continuation of the first;
 *   - and a request nobody answers says so, rather than hanging.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { stubApi, installFakeWallet, advanceOffers, signIn, COVER_ADDRESSES } from "./stub";
import coverHealthy from "./fixtures/cover-healthy.json" with { type: "json" };

type Page = import("@playwright/test").Page;

async function readHealthyLoan(page: Page) {
  await page.goto("/cover");
  await page.fill("#addr", COVER_ADDRESSES.healthy);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".cvr-disclosure");
}

/**
 * The Loan the fake wallet actually holds.
 *
 * A Cover is bought by the wallet that holds the Loan and only that wallet -- a put pays
 * whoever holds it, so any other wallet would be buying protection for itself. The fake
 * wallet is therefore installed AT the healthy fixture's address, and the mismatch case
 * gets its own test below.
 */
async function connectAsBorrower(page: Page) {
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-picker")).toBeVisible();
  // installFakeWallet always registers rdns "test.fakewallet0" as its one extension --
  // picking it is what every journey means by "connect the wallet" (see journeys.spec.ts).
  await page.getByTestId("wallet-option-test.fakewallet0").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible();
}

/** Open a request and wait out the stub's two polls until a maker answers. */
async function openRequestAndWait(page: Page) {
  await page.getByTestId("cover-submit").click();
  await expect(page.getByTestId("cover-wait")).toBeVisible();
  await advanceOffers(page, () => page.getByTestId("cover-accept").isVisible());
  await expect(page.getByTestId("cover-accept")).toBeVisible();
}

test.describe("the door on a quoted Loan", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeWallet(page, { address: COVER_ADDRESSES.healthy });
  });

  test("appears unaccompanied, and no request reaches /rfq on page load or on reading a Loan", async ({
    page,
  }) => {
    const traffic = await stubApi(page);
    await readHealthyLoan(page);

    await expect(page.getByTestId("cover-door")).toBeVisible();
    await expect(page.getByTestId("cover-door")).toHaveText("Cover this loan");

    // The caption beside it is gone on purpose: it promised the Trader would see what
    // they were agreeing to first, which the WHAT IT COSTS panel above already says
    // ("you approve it before anything is signed"). The promise itself is asserted
    // there, and the gate it described is asserted in "who may buy" below -- so what is
    // checked here is that the duplicate has not crept back in.
    await expect(page.locator(".cvr .cta .note")).toHaveCount(0);
    await expect(page.locator(".cvr")).toContainText("you approve it before anything is signed");

    expect(traffic.paths()).not.toContain("/rfq");
  });

  test("opens the confirmation only on a click, and it is announced as a modal dialog with focus moved in", async ({
    page,
  }) => {
    await stubApi(page);
    await readHealthyLoan(page);

    await expect(page.getByTestId("cover-confirm-modal")).toHaveCount(0);
    await page.getByTestId("cover-door").click();

    const modal = page.getByTestId("cover-confirm-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(modal).toHaveAttribute("aria-modal", "true");

    const focused = await page.evaluate(
      () => document.activeElement?.closest('[data-testid="cover-confirm-modal"]') !== null
    );
    expect(focused).toBe(true);
  });

  test("restates the trade as a belief, with the premium cap as the largest figure", async ({ page }) => {
    await stubApi(page);
    await readHealthyLoan(page);
    await page.getByTestId("cover-door").click();

    const q = coverHealthy.quote;
    await expect(page.getByTestId("cover-belief")).toContainText(q.cover.targetStrike.display);
    await expect(page.getByTestId("cover-cap")).toHaveText(q.cover.premiumCapUsdc.display);
    await expect(page.getByTestId("cover-ends")).toHaveText(q.cover.expiry.display);
  });

  /**
   * ADR-0008's central promise, and the thing this whole dialog exists to make true. The
   * cap is a ceiling; a premium is what a maker charges. Until one answers, showing
   * anything in the premium's place would be an invention.
   */
  test("shows the cap as a cap, and no premium at all, before any maker has answered", async ({ page }) => {
    await stubApi(page);
    await readHealthyLoan(page);
    await page.getByTestId("cover-door").click();

    await expect(page.getByTestId("cover-confirm-modal")).toContainText("Most you can pay");
    await expect(page.getByTestId("cover-confirm-modal")).not.toContainText("You pay");
  });

  test("states the four gate steps, naming that a maker must bid and the Borrower confirms again", async ({
    page,
  }) => {
    await stubApi(page);
    await readHealthyLoan(page);
    await page.getByTestId("cover-door").click();

    const gate = page.locator('.modal .gate[aria-label="What still has to happen"] li');
    await expect(gate).toHaveCount(4);
    await expect(gate.nth(0)).toContainText("You ask for the cover");
    await expect(gate.nth(1)).toContainText(/makers bid/i);
    await expect(gate.nth(2)).toContainText(/confirm again/i);
    await expect(gate.nth(3)).toContainText(/signed/i);

    // Nothing has happened yet, so nothing is marked done.
    await expect(page.locator(".modal .gate li.pass")).toHaveCount(0);
  });

  for (const [name, action] of [
    ["Escape", async (page: Page) => page.keyboard.press("Escape")],
    [
      "a scrim click",
      // A corner, not the centre: the scrim spans the full viewport and the dialog sits
      // centred within it, so clicking dead centre lands on the dialog itself.
      async (page: Page) => page.getByTestId("cover-scrim").click({ position: { x: 2, y: 2 } }),
    ],
    ["the header close control", async (page: Page) => page.getByRole("button", { name: "Close" }).click()],
    ["Not now", async (page: Page) => page.getByTestId("cover-close").click()],
  ] as const) {
    test(`${name} dismisses the confirmation`, async ({ page }) => {
      await stubApi(page);
      await readHealthyLoan(page);
      await page.getByTestId("cover-door").click();
      await expect(page.getByTestId("cover-confirm-modal")).toBeVisible();

      await action(page);
      await expect(page.getByTestId("cover-confirm-modal")).toHaveCount(0);
    });
  }

  test("an uncoverable Loan never grows a door at all", async ({ page }) => {
    await stubApi(page);
    await page.goto("/cover");
    await page.fill("#addr", COVER_ADDRESSES.multiCollateral);
    await page.click('button[type="submit"]');
    await expect(page.locator(".cvr-declined")).toBeVisible();

    await expect(page.getByTestId("cover-door")).toHaveCount(0);
  });

  test("focus returns to the door that opened it, once closed", async ({ page }) => {
    await stubApi(page);
    await readHealthyLoan(page);

    const door = page.getByTestId("cover-door");
    await door.click();
    await page.keyboard.press("Escape");
    await expect(door).toBeFocused();
  });
});

/**
 * The wallet gate.
 *
 * Reading is open to anyone -- a Borrower who learns their liquidation price and walks
 * away has been served, and that must keep working with no wallet at all. Buying is not.
 */
test.describe("who may buy", () => {
  test("reads any Loan with no wallet connected, and says why it cannot buy one", async ({ page }) => {
    await stubApi(page);
    await readHealthyLoan(page);

    // The read worked without a wallet: the quote is on screen.
    await expect(page.locator(".cvr-disclosure")).toBeVisible();

    await page.getByTestId("cover-door").click();
    await expect(page.getByTestId("cover-submit")).toBeDisabled();
    await expect(page.getByTestId("cover-gate-wallet")).toContainText(/same wallet/i);
  });

  test("refuses to buy for a Loan the connected wallet does not hold", async ({ page }) => {
    // A wallet that is not the Borrower. A Cover it bought would pay IT, leaving the
    // Borrower exactly as exposed as before -- a Cover in name only.
    await installFakeWallet(page, { address: "0x9999999999999999999999999999999999999999" });
    await stubApi(page);
    await signIn(page);
    await readHealthyLoan(page);
    await connectAsBorrower(page);

    await page.getByTestId("cover-door").click();
    await expect(page.getByTestId("cover-submit")).toBeDisabled();
    await expect(page.getByTestId("cover-gate-wallet")).toBeVisible();
  });
});

/**
 * The money path itself: two signatures, and a real wait in between.
 */
test.describe("requesting, waiting and paying", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeWallet(page, { address: COVER_ADDRESSES.healthy });
  });

  test("the first press opens a request and buys nothing -- still no premium anywhere", async ({ page }) => {
    const traffic = await stubApi(page);
    await signIn(page);
    await readHealthyLoan(page);
    await connectAsBorrower(page);
    await page.getByTestId("cover-door").click();

    await page.getByTestId("cover-submit").click();

    const wait = page.getByTestId("cover-wait");
    await expect(wait).toBeVisible();
    await expect(wait).toHaveAttribute("role", "status");
    await expect(wait).toHaveAttribute("data-phase", "OPEN");
    await expect(page.getByTestId("cover-wait-sentence")).toContainText(/Nothing is owed unless you accept/i);

    // The cap is still a cap, and the first gate step is the only one done.
    await expect(page.getByTestId("cover-confirm-modal")).toContainText("Most you can pay");
    await expect(page.locator(".modal .gate li.pass")).toHaveCount(1);

    expect(traffic.paths()).toContain("/rfq");
    expect(traffic.paths()).toContain("/rfq/confirm");
    expect(traffic.paths()).not.toContain("/rfq/settle/prepare");
  });

  test("states the Coverage beside the cap, so 'cover' is never left to imply 'fully covered'", async ({
    page,
  }) => {
    await stubApi(page);
    await signIn(page);
    await readHealthyLoan(page);
    await connectAsBorrower(page);
    await page.getByTestId("cover-door").click();
    await page.getByTestId("cover-submit").click();

    await expect(page.getByTestId("cover-coverage")).toContainText("100%");
  });

  test("a maker's answer is the first price shown, and paying it takes a second press that names it", async ({
    page,
  }) => {
    const traffic = await stubApi(page);
    await signIn(page);
    await readHealthyLoan(page);
    await connectAsBorrower(page);
    await page.getByTestId("cover-door").click();
    await openRequestAndWait(page);

    // The button that spends money names the amount, so nobody presses it unread.
    const accept = page.getByTestId("cover-accept");
    await expect(accept).toContainText("$1.25");
    await expect(page.getByTestId("cover-cap")).toHaveText("$1.25");
    await expect(page.getByTestId("cover-confirm-modal")).toContainText("You pay");

    // Requesting alone never reached the settle routes: paying is a separate act.
    expect(traffic.paths()).not.toContain("/rfq/settle/prepare");

    await accept.click();
    await expect(page.getByTestId("cover-wait")).toHaveAttribute("data-phase", "SETTLED");
    await expect(page.getByTestId("cover-receipt")).toBeVisible();
    expect(traffic.paths()).toContain("/rfq/settle/prepare");
    expect(traffic.paths()).toContain("/rfq/settle");
  });

  test("every gate step is lit once the Cover is bought, and the Lapse is restated", async ({ page }) => {
    await stubApi(page);
    await signIn(page);
    await readHealthyLoan(page);
    await connectAsBorrower(page);
    await page.getByTestId("cover-door").click();
    await openRequestAndWait(page);
    await page.getByTestId("cover-accept").click();

    await expect(page.locator(".modal .gate li.pass")).toHaveCount(4);
    await expect(page.getByTestId("cover-wait-sentence")).toContainText(/nothing renews on its own/i);
    await expect(page.getByTestId("cover-wait-sentence")).toContainText(coverHealthy.quote.cover.expiry.display);

    // Nothing left to press but the exit -- a bought Cover cannot be bought again.
    await expect(page.getByTestId("cover-accept")).toHaveCount(0);
    await expect(page.getByTestId("cover-submit")).toHaveCount(0);
    await expect(page.getByTestId("cover-close")).toHaveText("Close");
  });

  test("an unanswered request says so and offers a withdrawal, rather than hanging", async ({ page }) => {
    await stubApi(page, "rfq-unanswered");
    await signIn(page);
    await readHealthyLoan(page);
    await connectAsBorrower(page);
    await page.getByTestId("cover-door").click();
    await page.getByTestId("cover-submit").click();

    const wait = page.getByTestId("cover-wait");
    await advanceOffers(page, async () => (await wait.getAttribute("data-phase")) === "NO_OFFERS");
    await expect(wait).toHaveAttribute("data-phase", "NO_OFFERS");
    await expect(page.getByTestId("cover-wait-sentence")).toContainText(/nobody answered/i);
    await expect(page.getByTestId("cover-wait-sentence")).toContainText(/No USDC moved/i);

    // Never a price: nobody quoted one.
    await expect(page.getByTestId("cover-confirm-modal")).toContainText("Most you can pay");
    await expect(page.getByTestId("cover-accept")).toHaveCount(0);
    await expect(page.getByTestId("cover-withdraw")).toContainText("Withdraw request");
  });

  test("closing and reopening the door starts a fresh dialog, not the previous request", async ({ page }) => {
    await stubApi(page);
    await signIn(page);
    await readHealthyLoan(page);
    await connectAsBorrower(page);

    await page.getByTestId("cover-door").click();
    await page.getByTestId("cover-submit").click();
    await expect(page.getByTestId("cover-wait")).toBeVisible();
    await page.getByTestId("cover-close").click();
    await expect(page.getByTestId("cover-confirm-modal")).toHaveCount(0);

    await page.getByTestId("cover-door").click();
    await expect(page.getByTestId("cover-belief")).toBeVisible();
    await expect(page.getByTestId("cover-wait")).toHaveCount(0);
    await expect(page.getByTestId("cover-submit")).toBeVisible();
  });

  test("is reachable and fully operable by keyboard alone", async ({ page }) => {
    await stubApi(page);
    await signIn(page);
    await readHealthyLoan(page);
    await connectAsBorrower(page);

    await page.getByTestId("cover-door").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("cover-confirm-modal")).toBeVisible();

    // Tab wraps within the dialog -- a focus trap, not an escape into the page behind it.
    const focusableCount = await page.getByTestId("cover-confirm-modal").locator("button").count();
    for (let i = 0; i < focusableCount + 1; i++) await page.keyboard.press("Tab");
    const stillInDialog = await page.evaluate(
      () => document.activeElement?.closest('[data-testid="cover-confirm-modal"]') !== null
    );
    expect(stillInDialog).toBe(true);

    await page.getByTestId("cover-submit").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("cover-wait")).toBeVisible();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`is axe-core clean in ${colorScheme} theme, asking, waiting and bought`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await stubApi(page);
      await signIn(page);
      await readHealthyLoan(page);
      await connectAsBorrower(page);
      await page.getByTestId("cover-door").click();

      const serious = async () => {
        const results = await new AxeBuilder({ page }).include('[data-testid="cover-confirm-modal"]').analyze();
        return results.violations
          .filter((v) => v.impact === "critical" || v.impact === "serious")
          .map((v) => `${v.id}: ${v.description}`);
      };

      expect(await serious()).toEqual([]);

      await openRequestAndWait(page);
      expect(await serious()).toEqual([]);

      await page.getByTestId("cover-accept").click();
      await expect(page.getByTestId("cover-receipt")).toBeVisible();
      expect(await serious()).toEqual([]);
    });
  }
});
