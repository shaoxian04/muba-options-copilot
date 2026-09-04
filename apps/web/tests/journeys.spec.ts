/**
 * Issues #11-#14 and #30 -- the surface walked end to end.
 *
 * The API suite already proves a Card's premium equals the Trade Proposal's for the same
 * cardRef. That test cannot see the failure that actually reaches a Trader: React
 * rounding, truncating or reformatting on the way to the screen. So the equality is
 * asserted HERE, in the DOM, character for character.
 *
 * Issue #30 removed the persistent commit bar: the only Confirm in the product now lives
 * inside a modal a Trader arrives at by clicking a Card. That reshapes most of the
 * journeys below -- anything that used to read Max Loss, the Risk Budget, the agent gate
 * or Confirm/Practice Run off a bar that was always on screen now has to open the
 * confirmation first, the same deliberate step a Trader has to take.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  advanceOffers, cards, fixtures, FIXTURE_USER_ID, FORBIDDEN, installFakeWallet, installFakeWallets,
  signIn, stubApi, TEST_API_TOKEN,
} from "./stub";
import { LAST_CONNECTION_KEY } from "../lib/wallet";

const agentCard = fixtures.proposeAgent.cardRef;
const overrideCard = cards.find((c) => c.cardRef !== agentCard)!;
const overrideProposal = fixtures.proposeByCard[overrideCard.cardRef];

/**
 * Click a Card and wait for the confirmation to open (issue #30). This is the only way
 * to reach Max Loss, the payoff curve, the size control, the agent gate, or Confirm and
 * Practice Run -- there is nowhere else on the surface any of them render.
 */
const openConfirm = async (page: Page, cardRef: string) => {
  await page.locator(`[data-card-ref="${cardRef}"]`).click();
  await expect(page.getByTestId("confirm-modal")).toBeVisible();
};

/**
 * A thin, longstanding alias for `openConfirm(page, agentCard)` -- kept under this name
 * for continuity with the many existing callers below. `agentCard` names a fixed Card
 * ref most tests below open, not evidence of an agent having chosen it: issue #30 means
 * a proposal only ever exists once a Card is picked directly, which also opens the
 * confirmation. Unrelated to `Surface.deal()` (the Trade tab's seed prompts, exercised in
 * `insights.spec.ts`'s Suggestion-Accept test) -- an unfortunate name collision between
 * two features built independently, not the same mechanism.
 */
const deal = async (page: Page) => {
  await openConfirm(page, agentCard);
};

/**
 * Signs in (ADR-0014) and connects the fake wallet through the picker (the multi-wallet
 * connector). `AccountControl` is a persistent, always-visible control -- NOT inside
 * `ConfirmModal` -- so this must run before any confirmation opens: the modal's
 * `.scrim` covers the full viewport at a higher z-index, and would make the button
 * underneath unclickable once one is open.
 */
const connectWallet = async (page: Page) => {
  await signIn(page);
  await page.reload();
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-picker")).toBeVisible();
  // installFakeWallet always registers rdns "test.fakewallet0" as its one extension --
  // picking it is what every existing single-wallet journey means by "connect the wallet."
  await page.getByTestId("wallet-option-test.fakewallet0").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible();
};

test.describe("selection, and who chose", () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page);
  });

  test("marks a picked Card as the Trader's, not the agent's", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, overrideCard.cardRef);

    await expect(page.getByTestId("chosen-by")).toContainText("your pick, not the agent's");
    await expect(page.getByTestId("chosen-by")).not.toContainText("the agent picked this");
  });

  test("asks the server for the numbers rather than reading the Card in the browser", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await openConfirm(page, agentCard);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("confirm-modal")).toHaveCount(0);

    // The Deck is covered while a confirmation is open (issue #30), so reaching a
    // SECOND Card's own numbers means closing the first before opening the next.
    await openConfirm(page, overrideCard.cardRef);
    await expect(page.getByTestId("premium")).toBeVisible();

    const proposals = traffic.all.filter((r) => new URL(r.url()).pathname === "/propose");
    expect(proposals.length).toBeGreaterThanOrEqual(2);
    expect(proposals.at(-1)!.postDataJSON()).toMatchObject({ cardRef: overrideCard.cardRef });

    // What is on screen is the server's answer, not the Card object already in the page.
    await expect(page.getByTestId("premium")).toHaveText(overrideProposal.proposal.figures.premiumUsdc.display);
    await expect(page.getByTestId("breakeven")).toHaveText(overrideProposal.proposal.figures.breakevenPrice.display);
  });

  test("draws the payoff curve and a crosshair that reads at any price", async ({ page }) => {
    await page.goto("/");
    await deal(page);
    await expect(page.getByTestId("payoff-plot")).toBeVisible();

    const plot = page.getByTestId("payoff-plot");
    const box = (await plot.boundingBox())!;

    await plot.hover({ position: { x: box.width * 0.15, y: box.height / 2 } });
    const low = await page.getByTestId("crosshair").textContent();

    await plot.hover({ position: { x: box.width * 0.85, y: box.height / 2 } });
    const high = await page.getByTestId("crosshair").textContent();

    expect(low).toBeTruthy();
    expect(high).toBeTruthy();
    expect(low).not.toBe(high);

    // Every readout is one of the server's own points, never a value between two.
    const curve = fixtures.proposeAgent.proposal.payoffCurve;
    const readouts = curve.map((p: any) => `${p.settlementPrice.display} → ${p.returnUsdc.display}`);
    expect(readouts).toContain(low);
    expect(readouts).toContain(high);
  });

  test("lets a keyboard sweep the same curve a mouse can", async ({ page }) => {
    await page.goto("/");
    await deal(page);

    const plot = page.getByTestId("payoff-plot");
    await plot.focus();
    await expect(plot).toBeFocused();
    await expect(page.getByTestId("crosshair")).toBeVisible();

    const middle = await plot.getAttribute("aria-valuenow");
    await page.keyboard.press("ArrowRight");
    await expect(plot).not.toHaveAttribute("aria-valuenow", middle!);

    // Home and End reach the ends of the plotted range, so "any price" really is any
    // price the curve covers -- not the nine a summary list would have offered.
    const curve = fixtures.proposeAgent.proposal.payoffCurve;
    await page.keyboard.press("Home");
    await expect(page.getByTestId("crosshair")).toHaveText(
      `${curve[0].settlementPrice.display} → ${curve[0].returnUsdc.display}`
    );
    await page.keyboard.press("End");
    await expect(page.getByTestId("crosshair")).toHaveText(
      `${curve.at(-1)!.settlementPrice.display} → ${curve.at(-1)!.returnUsdc.display}`
    );

    // And a screen reader is told the same two figures, not a bare index.
    const spoken = await plot.getAttribute("aria-valuetext");
    expect(spoken).toContain(curve.at(-1)!.settlementPrice.display);
    expect(spoken).toContain(curve.at(-1)!.returnUsdc.display);
  });

  test("shows breakeven, premium and the asset a payout arrives in", async ({ page }) => {
    await page.goto("/");
    await deal(page);

    const f = fixtures.proposeAgent.proposal.figures;
    await expect(page.getByTestId("premium")).toHaveText(f.premiumUsdc.display);
    await expect(page.getByTestId("breakeven")).toHaveText(f.breakevenPrice.display);
    await expect(page.getByTestId("payout-asset")).toHaveText(fixtures.proposeAgent.proposal.payoutAsset);
  });

  test("shows the agent gate as three states, with the human last", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, agentCard);

    const gate = page.getByRole("list", { name: "Who has to agree before anything is signed" });
    const chips = gate.getByRole("listitem");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toContainText("Trade Agent");
    await expect(chips.nth(1)).toContainText("Review");
    await expect(chips.nth(2)).toContainText("You");
    await expect(chips.nth(2)).toHaveClass(/wait/);
  });

  test("says the Review Agent ran on a Trader's own pick", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, overrideCard.cardRef);

    await expect(page.getByRole("listitem").filter({ hasText: "Review" })).toContainText("your override");
  });

  test("draws the pending Fill on the Risk Budget as a ghost segment", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, agentCard);

    const width = await page.getByTestId("risk-pending").evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(0);
  });

  test("shows no Forecast anywhere on the surface", async ({ page }) => {
    await page.goto("/");
    await deal(page);

    // ADR-0005: Implied Chance and Implied Move are observations and may appear. A
    // model-produced expectation may not, and nothing on this surface produces one.
    const body = (await page.locator("body").innerText()).toLowerCase();
    for (const word of ["forecast", "we expect", "likely to reach", "target price", "prediction", "we think"]) {
      expect(body).not.toContain(word);
    }
  });
});

test.describe("the confirmation replaces the commit bar", () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page);
  });

  test("no standing Confirm control exists anywhere until a Card is clicked", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();

    // Not disabled -- ABSENT. There is nowhere on the surface a Trader can even find
    // a Confirm button before they have clicked a Card.
    await expect(page.getByTestId("confirm")).toHaveCount(0);
    await expect(page.getByTestId("practice")).toHaveCount(0);
    await expect(page.getByTestId("confirm-modal")).toHaveCount(0);
  });

  test("clicking a Card opens the confirmation, and it holds the only Confirm in the product", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, agentCard);

    const modal = page.getByTestId("confirm-modal");
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(modal).toHaveAttribute("aria-modal", "true");
    await expect(page.getByTestId("confirm")).toHaveCount(1);
    await expect(page.getByTestId("practice")).toHaveCount(1);
  });

  test("restates the trade as a belief in plain language, and never names the instrument", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, agentCard);

    const belief = page.getByTestId("belief");
    await expect(belief).toContainText("You believe");
    await expect(belief).toContainText("ETH");
    await expect(belief).toContainText("below");
    await expect(belief).toContainText(fixtures.proposeAgent.proposal.figures.strike.display);

    // Not just the belief block -- nowhere in the whole dialog does the instrument
    // appear. "Chance" contains no forbidden substring, so this is safe as a whole-word
    // check against the modal's full text.
    const modalText = await page.getByTestId("confirm-modal").innerText();
    for (const word of ["CALL", "PUT", "call option", "put option"]) {
      expect(modalText).not.toContain(word);
    }
  });

  test("the countdown runs in hours, minutes and seconds", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, agentCard);

    const clock = page.getByTestId("belief-countdown");
    await expect(clock).toHaveText(/^\d+:\d{2}:\d{2}$/);
    const first = await clock.textContent();
    await page.clock.runFor(3000);
    await expect(clock).not.toHaveText(first!);
  });

  test("Max Loss is the largest figure, and equals the premium", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, agentCard);

    const f = fixtures.proposeAgent.proposal.figures;
    await expect(page.getByTestId("max-loss")).toHaveText(f.maxLossUsdc.display);
    expect(f.maxLossUsdc.display).toBe(f.premiumUsdc.display);

    const maxLossSize = await page.getByTestId("max-loss").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const chanceSize = await page.getByTestId("chance-pays").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const depthSize = await page.getByTestId("depth-here").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(maxLossSize).toBeGreaterThan(chanceSize);
    expect(maxLossSize).toBeGreaterThan(depthSize);
  });

  test("shows chance it pays and Maker Depth from the picked Card", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, agentCard);

    const card = cards.find((c) => c.cardRef === agentCard)!;
    await expect(page.getByTestId("chance-pays")).toContainText(card.impliedChance.display);
    await expect(page.getByTestId("chance-pays")).toContainText(card.chanceLabel);
    await expect(page.getByTestId("depth-here")).toContainText(card.depthUsdc.display);
  });

  test("Escape dismisses, and returns focus to the Card that opened it", async ({ page }) => {
    await page.goto("/");
    const opener = page.locator(`[data-card-ref="${agentCard}"]`);
    await opener.click();
    await expect(page.getByTestId("confirm-modal")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("confirm-modal")).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("a backdrop click dismisses", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, agentCard);

    await page.getByTestId("scrim").click({ position: { x: 2, y: 2 } });
    await expect(page.getByTestId("confirm-modal")).toHaveCount(0);
  });

  test("traps focus inside the dialog", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, agentCard);

    const dialog = page.getByTestId("confirm-modal");
    const focusable = dialog.locator('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const count = await focusable.count();
    expect(count).toBeGreaterThan(1);

    // Shift+Tab off the first focusable element wraps to the last, never escaping to
    // the Deck behind it.
    await focusable.first().focus();
    await page.keyboard.press("Shift+Tab");
    await expect(focusable.last()).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(focusable.first()).toBeFocused();
  });

  test("has no critical or serious accessibility violations", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, agentCard);

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id)).toEqual([]);
  });
});

test.describe("size: presets, the stepper, and the cap", () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page);
  });

  test("a preset recomputes every figure via a real server round trip", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await openConfirm(page, agentCard);

    const before = await page.getByTestId("max-loss").textContent();

    await page.getByTestId("size-preset-5").click();

    await expect.poll(() => traffic.all.filter((r) => new URL(r.url()).pathname === "/propose").length).toBeGreaterThanOrEqual(2);
    const last = traffic.all.filter((r) => new URL(r.url()).pathname === "/propose").at(-1)!;
    expect(last.postDataJSON()).toMatchObject({ cardRef: agentCard, sizeUsdc: 5 });

    // Every figure that depends on size moved together -- not adjusted in the
    // browser, re-read off the server's fresh answer.
    await expect(page.getByTestId("max-loss")).not.toHaveText(before!);
    await expect(page.getByTestId("max-loss")).toHaveText("$5.00");
    await expect(page.getByTestId("size-value")).toHaveText("$5.00");
  });

  test("the stepper recomputes every figure the same way", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await openConfirm(page, agentCard);

    await page.getByTestId("size-increase").click();

    await expect.poll(() => traffic.all.filter((r) => new URL(r.url()).pathname === "/propose").length).toBeGreaterThanOrEqual(2);
    const last = traffic.all.filter((r) => new URL(r.url()).pathname === "/propose").at(-1)!;
    expect(last.postDataJSON()).toMatchObject({ cardRef: agentCard, sizeUsdc: 2.5 });
    await expect(page.getByTestId("max-loss")).toHaveText("$2.50");
  });

  test("Max binds on the Risk Budget when it is the tighter of the two", async ({ page }) => {
    // The default session's Risk Budget against every fixture Card's $500 Maker Depth --
    // the budget is always the smaller of the two here. Read off the fixture rather than
    // written down, because the default moved once already (a Cover's $8 Reserve Price
    // has to fit inside it) and a literal here would have to move with it every time.
    const budget = fixtures.session.riskBudgetUsdc;
    const traffic = await stubApi(page, "normal");
    await page.goto("/");
    await openConfirm(page, agentCard);

    // No preset is disabled at the default any more: the budget rose to $10 to leave room
    // for a Cover's $8 Reserve Price, and the largest preset is exactly $10. What this
    // test is actually about survives that -- Max lands on the budget rather than on
    // Maker Depth, which is the branch the "deep-budget" test below takes the other way.
    await page.getByTestId("size-max").click();
    const last = traffic.all.filter((r) => new URL(r.url()).pathname === "/propose").at(-1)!;
    expect(last.postDataJSON()).toMatchObject({ sizeUsdc: budget });
    await expect(page.getByTestId("max-loss")).toHaveText(fixtures.session.figures.riskBudgetUsdc.display);
  });

  test("Max binds on Maker Depth when it is the tighter of the two", async ({ page }) => {
    // "deep-budget" raises the Risk Budget to $1,000, well past every fixture Card's
    // $500 Maker Depth -- the OTHER branch of "whichever binds first".
    const traffic = await stubApi(page, "deep-budget");
    await page.goto("/");
    await openConfirm(page, agentCard);

    // $10 is now comfortably inside the (much larger) budget, so it is pressable --
    // proof the ceiling actually moved rather than a preset merely being disabled.
    await expect(page.getByTestId("size-preset-10")).toBeEnabled();

    await page.getByTestId("size-max").click();
    const last = traffic.all.filter((r) => new URL(r.url()).pathname === "/propose").at(-1)!;
    expect(last.postDataJSON()).toMatchObject({ sizeUsdc: 500 });
    await expect(page.getByTestId("max-loss")).toHaveText("$500.00");
  });

  test("shows the share of the Risk Budget the size consumes", async ({ page }) => {
    await page.goto("/");
    await openConfirm(page, agentCard);

    await expect(page.getByTestId("risk-remaining")).toContainText("of");
    await expect(page.getByTestId("risk-remaining")).toContainText(fixtures.session.figures.riskBudgetUsdc.display);
  });
});

test.describe("Max Loss holds still", () => {
  test("does not change as the Trader flicks across every Card", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    // Issue #30: the confirmation covers the Deck, so flicking across Cards now means
    // opening one, reading it, and closing it before the next -- there is no longer a
    // way to click a second Card while the first Card's confirmation sits open on top
    // of it.
    const maxLoss = page.getByTestId("max-loss");
    let before: string | null = null;

    for (const card of cards) {
      await openConfirm(page, card.cardRef);
      await expect(page.getByTestId("chosen-by")).toBeVisible();
      await expect(maxLoss).not.toHaveText("—");
      const text = await maxLoss.textContent();
      before ??= text;
      expect(text).toBe(before);

      await page.keyboard.press("Escape");
      await expect(page.getByTestId("confirm-modal")).toHaveCount(0);
    }
  });

  test("stays visible when the page behind it is scrolled", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await openConfirm(page, agentCard);

    await page.mouse.wheel(0, 3000);
    await expect(page.getByTestId("max-loss")).toBeInViewport();
    await expect(page.getByTestId("risk-remaining")).toBeInViewport();
  });
});

test.describe("the confirmation says what the Card said", () => {
  test("matches the picked Card character for character", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    await page.locator(`[data-card-ref="${overrideCard.cardRef}"]`).click();
    await expect(page.getByTestId("premium")).toBeVisible();

    /*
     * The reason this test exists.
     *
     * The API suite proves the Card and the proposal carry the same figures. It cannot
     * see a component rounding one of them on the way to the screen -- so the strings
     * are compared as RENDERED, from the Card the Trader clicked to the confirmation
     * that opened for it.
     */
    const tile = page.locator(`[data-card-ref="${overrideCard.cardRef}"]`);
    const shown = await tile.innerText();

    expect(shown).toContain(overrideCard.strike.display);
    expect(shown).toContain(overrideCard.contracts.display);
    expect(shown).toContain(overrideCard.premiumUsdc.display);

    await expect(page.getByTestId("premium")).toHaveText(overrideCard.premiumUsdc.display);
    await expect(page.getByTestId("contracts")).toHaveText(overrideCard.contracts.display);
    await expect(page.getByTestId("breakeven")).toHaveText(overrideCard.breakevenPrice.display);
    await expect(page.getByTestId("max-loss")).toHaveText(overrideCard.maxLossUsdc.display);
    await expect(page.getByTestId("confirm")).toContainText(overrideCard.maxLossUsdc.display);
  });
});

test.describe("finishing, for real and for practice", () => {
  test("makes Confirm and Practice Run unmistakable from each other, Practice Run the prominent one", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await openConfirm(page, agentCard);

    const confirm = page.getByTestId("confirm");
    const practice = page.getByTestId("practice");

    await expect(practice).toContainText("spends nothing");
    await expect(confirm).toContainText("Confirm");

    // Not colour alone: one is a solid slab, the other a dashed outline -- and issue
    // #30 flips which is which. Practice Run, the button that costs nothing, is now
    // the solid one; Confirm is the quiet, outlined one.
    const styles = await Promise.all(
      [confirm, practice].map((b) =>
        b.evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, border: s.borderStyle, weight: s.fontWeight };
        })
      )
    );
    expect(styles[0]!.bg).not.toBe(styles[1]!.bg);
    expect(styles[0]!.border).toContain("dashed");
    expect(styles[1]!.border).not.toContain("dashed");
  });

  test("a Practice Run issues no request to /fill/prepare", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await openConfirm(page, agentCard);

    await page.getByTestId("practice").click();
    await expect(page.getByTestId("holding")).toHaveCount(1);

    // Asserted on captured traffic, not on code shape: the surface may not even try.
    expect(traffic.paths()).toContain("/practice");
    expect(traffic.paths()).not.toContain("/fill/prepare");
  });

  test("labels a practice holding as practice, three ways", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await openConfirm(page, agentCard);
    await page.getByTestId("practice").click();

    const holding = page.getByTestId("holding").first();
    await expect(holding).toHaveAttribute("data-kind", "PRACTICE");
    await expect(holding.getByTestId("holding-kind")).toHaveText("Practice");
    // A dashed border says it before the word does, and says it without colour.
    await expect(holding).toHaveCSS("border-style", "dashed");
    await expect(holding.locator(".sr")).toContainText("no money at stake");
  });

  test("the board is never empty once a Practice Run exists", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("board-empty")).toBeVisible();

    await openConfirm(page, agentCard);
    await page.getByTestId("practice").click();

    await expect(page.getByTestId("board-empty")).toHaveCount(0);
    await expect(page.getByTestId("board")).toBeVisible();
  });

  test("shows a draining bar, a running countdown and a current value on each holding", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await openConfirm(page, agentCard);
    await page.getByTestId("practice").click();

    const holding = page.getByTestId("holding").first();
    await expect(holding.locator(".rail i")).toBeVisible();
    await expect(holding.getByTestId("holding-value")).not.toHaveText("—");

    const clock = holding.getByTestId("holding-countdown");
    await expect(clock).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
    const first = await clock.textContent();
    await page.clock.runFor(3000);
    await expect(clock).not.toHaveText(first!);
  });

  test("a Practice Run shows no celebration -- no confetti, streak, leaderboard or animation", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await openConfirm(page, agentCard);
    await page.getByTestId("practice").click();

    await expect(page.getByTestId("practice-receipt")).toBeVisible();
    const modalText = (await page.getByTestId("confirm-modal").innerText()).toLowerCase();
    for (const word of ["streak", "leaderboard", "congrat", "🎉", "confetti", "win", "nearly"]) {
      expect(modalText).not.toContain(word);
    }
  });

  test("Confirm spends only on the Trader's own press", async ({ page }) => {
    const traffic = await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await connectWallet(page);
    await openConfirm(page, agentCard);

    // Everything up to this point priced a real Order. Nothing has been signed.
    expect(traffic.paths()).not.toContain("/fill/prepare");

    await page.getByTestId("confirm").click();
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/prepare").length).toBe(1);
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/settle").length).toBe(1);
  });

  test("Confirm refuses without a connected wallet, and sends nothing", async ({ page }) => {
    const traffic = await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await openConfirm(page, agentCard);

    // Confirm's enabled state depends only on the proposal, not the wallet -- pressing
    // it without one is a real, deliberate click that must be refused, not a button
    // that was never reachable.
    await expect(page.getByTestId("confirm")).toBeEnabled();
    // Practice Run never needs a wallet, and stays pressable throughout.
    await expect(page.getByTestId("practice")).toBeEnabled();

    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("refusal")).toBeVisible();
    expect(traffic.paths()).not.toContain("/fill/prepare");
  });

  test("shows a connecting state, then the connected address", async ({ page }) => {
    await stubApi(page);
    await installFakeWallet(page);
    await signIn(page);
    await page.goto("/");

    const connect = page.getByTestId("connect-wallet");
    await expect(connect).toHaveText("Connect wallet");
    await connect.click();
    await page.getByTestId("wallet-option-test.fakewallet0").click();
    await expect(page.getByTestId("wallet-address")).toBeVisible();
    await expect(page.getByTestId("connect-wallet")).toHaveCount(0);
  });

  test("recovers from a transaction the chain hasn't shown it yet", async ({ page }) => {
    const traffic = await stubApi(page, "settle-pending-once");
    await installFakeWallet(page);
    await page.goto("/");
    // The retry delay is a real setTimeout in confirm() -- let the page's clock run
    // instead of the frozen one stubApi installs for the countdown timers, the same
    // fix needed for the wallet-signing flow itself.
    await page.clock.resume();
    await connectWallet(page);
    await openConfirm(page, agentCard);

    await page.getByTestId("confirm").click();

    await expect(page.getByTestId("receipt")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/settle").length).toBe(2);
  });

  test("hands the Trader the transaction once real money has moved, with no celebration", async ({ page }) => {
    await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await connectWallet(page);
    await openConfirm(page, agentCard);
    await expect(page.getByTestId("receipt")).toHaveCount(0);

    await page.getByTestId("confirm").click();

    // Being told "bought" and given nothing to check is being asked to take our word
    // for it at the one moment a Trader should not have to.
    const receipt = page.getByTestId("receipt");
    await expect(receipt).toBeVisible();
    await expect(receipt.getByRole("link")).toHaveAttribute("href", /^https?:\/\//);

    const modalText = (await page.getByTestId("confirm-modal").innerText()).toLowerCase();
    for (const word of ["streak", "leaderboard", "congrat", "🎉", "confetti", "win", "nearly"]) {
      expect(modalText).not.toContain(word);
    }
  });

  test("still shows the receipt when reporting success back to the server fails", async ({ page }) => {
    // The wallet has already broadcast and mined the transaction by the time the app
    // tells the backend about it -- real money has moved, so a failure of THAT report
    // must never be shown to the Trader as if their fill itself had failed.
    await stubApi(page, "settle-fails");
    await installFakeWallet(page);
    await page.goto("/");
    await connectWallet(page);
    await openConfirm(page, agentCard);

    await page.getByTestId("confirm").click();

    await expect(page.getByTestId("receipt")).toBeVisible();
    await expect(page.getByTestId("refusal")).toHaveCount(0);
  });

  test("shows a failure and releases the reservation when the wallet's transaction fails on-chain", async ({
    page,
  }) => {
    const traffic = await stubApi(page);
    await installFakeWallet(page, { fail: true });
    await page.goto("/");
    await connectWallet(page);
    await openConfirm(page, agentCard);

    const before = await page.getByTestId("risk-remaining").textContent();

    await page.getByTestId("confirm").click();

    await expect(page.getByTestId("receipt")).toHaveCount(0);
    await expect(page.getByTestId("refusal")).toBeVisible();
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/settle").length).toBe(1);
    const settleBody = traffic.all.find((r) => new URL(r.url()).pathname === "/fill/settle")!.postDataJSON();
    expect(settleBody.txHash).toBeUndefined(); // nothing to check -- the send itself never returned a hash

    // The reservation was released -- the Risk Budget reads the same as before Confirm.
    await expect(page.getByTestId("risk-remaining")).toHaveText(before!);
  });

  test("sends the bearer token /fill/prepare is gated on", async ({ page }) => {
    // `.env.example` states the contract: "The frontend sends it as `Authorization:
    // Bearer ...`". Without the header, Confirm answers 401 for anyone who followed the
    // documented security posture -- and it only breaks once a token is set, which is
    // exactly the configuration that most needs to work.
    const traffic = await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await connectWallet(page);
    await openConfirm(page, agentCard);
    await page.getByTestId("confirm").click();
    await expect.poll(() => traffic.paths().includes("/fill/prepare")).toBe(true);

    const request = traffic.all.find((r) => new URL(r.url()).pathname === "/fill/prepare")!;
    expect(await request.headerValue("authorization")).toBe(`Bearer ${TEST_API_TOKEN}`);
  });

  test("auto-refreshes a moved quote instead of a dead end, and is never fillable while it does", async ({
    page,
  }) => {
    const traffic = await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await connectWallet(page);
    await openConfirm(page, agentCard);
    await expect(page.getByTestId("confirm")).toBeEnabled();

    // The book reprices under them while the proposal is on screen. Held open so the
    // refresh itself -- not just its before/after -- can be asserted on.
    traffic.moveTheQuote();
    const release = traffic.hold("/propose");
    await page.clock.runFor(7000);

    await expect(page.getByTestId("quote-moved")).toBeVisible();
    await expect(page.getByTestId("confirm")).toBeDisabled();
    await expect(page.getByTestId("practice")).toBeDisabled();
    // Story 30: never filled at a price they did not see -- true whether the price is
    // moved or the refresh chasing it is still in flight.
    expect(traffic.paths()).not.toContain("/fill/prepare");

    release();
    await expect(page.getByTestId("quote-refreshed")).toBeVisible();
    await expect(page.getByTestId("quote-moved")).toHaveCount(0);
    await expect(page.getByTestId("confirm")).toBeEnabled();
    expect(traffic.paths()).not.toContain("/fill/prepare");
  });

  test("issue #32: a moved quote (and its refresh) does not follow the Trader when they close and reopen for a different Card", async ({
    page,
  }) => {
    const traffic = await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await connectWallet(page);
    await openConfirm(page, agentCard);

    traffic.moveTheQuote();
    const release = traffic.hold("/propose");
    await page.clock.runFor(7000);
    await expect(page.getByTestId("quote-moved")).toBeVisible();

    // Closed mid-refresh -- the still-in-flight re-price must not leak its answer into
    // whatever gets picked next.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("confirm-modal")).toHaveCount(0);
    release();

    // A different Card, freshly priced -- `quoteMoved` (and the refresh chasing it) is
    // about the ONE proposal a Trader was shown going stale, not a flag that sticks to
    // the confirmation itself.
    await openConfirm(page, overrideCard.cardRef);
    await expect(page.getByTestId("quote-moved")).toHaveCount(0);
    await expect(page.getByTestId("quote-refreshed")).toHaveCount(0);
    await expect(page.getByTestId("confirm")).toBeEnabled();
  });
});

test.describe("sign-in gates the wallet, not the Deck (ADR-0014)", () => {
  test("Deck browsing and Practice Run work with no account at all", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    await openConfirm(page, agentCard);
    await page.getByTestId("practice").click();

    await expect(page.getByTestId("practice-receipt")).toBeVisible();
  });

  test("Connect wallet is unreachable until signed in", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    await expect(page.getByTestId("signin-link")).toBeVisible();
    await expect(page.getByTestId("connect-wallet")).toHaveCount(0);
  });

  test("signing in reveals Connect wallet in the same persistent spot", async ({ page }) => {
    await stubApi(page);
    await signIn(page);
    await page.goto("/");

    await expect(page.getByTestId("signin-link")).toHaveCount(0);
    await expect(page.getByTestId("connect-wallet")).toBeVisible();
  });

  test("the Copilot chat is locked with a sign-in prompt until signed in, on both tabs", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    await expect(page.getByTestId("chat-signin-gate")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Say something to the Copilot" })).toBeDisabled();

    await page.getByRole("tab", { name: "Insights" }).click();
    await expect(page.getByTestId("chat-signin-gate")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Ask a question" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Ask" })).toBeDisabled();

    await signIn(page);
    await page.reload();

    await expect(page.getByTestId("chat-signin-gate")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Ask a question" })).toBeEnabled();
    await page.getByRole("tab", { name: "Trade" }).click();
    await expect(page.getByRole("textbox", { name: "Say something to the Copilot" })).toBeEnabled();
  });
});

test.describe("the wallet picker (multi-wallet connector)", () => {
  test("lists every detected extension by its own name, and connects to the one clicked", async ({ page }) => {
    await stubApi(page);
    await installFakeWallets(page, [
      { rdns: "io.metamask", name: "MetaMask" },
      { rdns: "com.coinbase.wallet", name: "Coinbase Wallet" },
    ]);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("wallet-option-io.metamask")).toContainText("MetaMask");
    await expect(page.getByTestId("wallet-option-com.coinbase.wallet")).toContainText("Coinbase Wallet");

    await page.getByTestId("wallet-option-io.metamask").click();
    await expect(page.getByTestId("wallet-address")).toBeVisible();
    await expect(page.getByTestId("wallet-picker")).toHaveCount(0);
  });

  test("shows WalletConnect even with no extension installed at all", async ({ page }) => {
    await stubApi(page);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("wallet-option-walletConnect")).toContainText("WalletConnect");
    await expect(page.getByTestId("wallet-picker-empty")).toHaveCount(0); // WalletConnect alone still means "something to pick"
  });

  test("closing the picker without choosing connects nothing", async ({ page }) => {
    const traffic = await stubApi(page);
    await installFakeWallets(page, [{ rdns: "io.metamask", name: "MetaMask" }]);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("wallet-picker")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("wallet-picker")).toHaveCount(0);
    await expect(page.getByTestId("wallet-address")).toHaveCount(0);
    expect(traffic.paths()).not.toContain("/auth/challenge");
  });

  test("a backdrop click also dismisses the picker", async ({ page }) => {
    await stubApi(page);
    await installFakeWallets(page, [{ rdns: "io.metamask", name: "MetaMask" }]);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("connect-wallet").click();
    await page.getByTestId("wallet-picker-scrim").click({ position: { x: 2, y: 2 } });
    await expect(page.getByTestId("wallet-picker")).toHaveCount(0);
  });

  test("has no critical or serious accessibility violations", async ({ page }) => {
    await stubApi(page);
    await installFakeWallets(page, [{ rdns: "io.metamask", name: "MetaMask" }]);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("wallet-picker")).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id)).toEqual([]);
  });

  test("traps focus inside the dialog", async ({ page }) => {
    await stubApi(page);
    await installFakeWallets(page, [
      { rdns: "io.metamask", name: "MetaMask" },
      { rdns: "com.coinbase.wallet", name: "Coinbase Wallet" },
    ]);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("connect-wallet").click();
    const dialog = page.getByTestId("wallet-picker");
    const focusable = dialog.locator('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const count = await focusable.count();
    expect(count).toBeGreaterThan(1);

    await focusable.first().focus();
    await page.keyboard.press("Shift+Tab");
    await expect(focusable.last()).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(focusable.first()).toBeFocused();
  });
});

test.describe("wallet connection survives a refresh, within a TTL", () => {
  /**
   * Backdates the stored connection's timestamp directly, rather than advancing the
   * page's clock -- advancing the clock also ages the fake Supabase session token
   * (whose `expires_at` was computed off the same clock) and every other timer on the
   * page, none of which this feature is about. This isolates exactly the one piece of
   * state `recentConnectionWithinTtl` reads.
   */
  const backdateStoredConnection = (page: Page, ageMs: number) =>
    page.evaluate(
      ({ key, ageMs }) => {
        const raw = window.localStorage.getItem(key);
        if (!raw) throw new Error("no stored connection to backdate");
        const parsed = JSON.parse(raw) as { id: string; connectedAt: number };
        parsed.connectedAt = Date.now() - ageMs;
        window.localStorage.setItem(key, JSON.stringify(parsed));
      },
      // `wallet.ts` scopes this key by the signed-in account id (`setWalletMemoryScope`) --
      // the bare LAST_CONNECTION_KEY was never written to directly since that scoping
      // landed, only `${LAST_CONNECTION_KEY}:${accountId}`.
      { key: `${LAST_CONNECTION_KEY}:${FIXTURE_USER_ID}`, ageMs }
    );

  test("disconnecting stops the silent reconnect from retrying, even well within the window", async ({ page }) => {
    await stubApi(page);
    await installFakeWallet(page);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("connect-wallet").click();
    await page.getByTestId("wallet-option-test.fakewallet0").click();
    await expect(page.getByTestId("wallet-address")).toBeVisible();

    await page.getByTestId("account-avatar").click();
    await page.getByTestId("account-disconnect-wallet").click();
    await expect(page.getByTestId("connect-wallet")).toBeVisible();

    // No backdating here, deliberately: this is seconds-old, deep inside the TTL window
    // -- if disconnecting hadn't cleared the "last used" pointer, the silent reconnect
    // would fire right back on this very reload. It must not.
    await page.reload();

    await expect(page.getByTestId("connect-wallet")).toBeVisible();
    await expect(page.getByTestId("connect-wallet")).toBeEnabled();
    await expect(page.getByTestId("wallet-address")).toHaveCount(0);
  });

  test("reconnects and re-verifies silently within the window -- no picker, no Verify click", async ({ page }) => {
    await stubApi(page);
    await installFakeWallet(page);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("connect-wallet").click();
    await page.getByTestId("wallet-option-test.fakewallet0").click();
    await expect(page.getByTestId("wallet-address")).toBeVisible();
    const address = await page.getByTestId("wallet-address").innerText();

    // Just under the 3-hour TTL.
    await backdateStoredConnection(page, 2 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000);
    await page.reload();

    // Straight to the verified address -- no Connect wallet, no picker, no Verify
    // button, and no extra signature: the session already proved this exact address.
    await expect(page.getByTestId("wallet-address")).toHaveText(address);
    await expect(page.getByTestId("connect-wallet")).toHaveCount(0);
    await expect(page.getByTestId("wallet-picker")).toHaveCount(0);
    await expect(page.getByTestId("verify-wallet")).toHaveCount(0);
  });

  test("falls back to the normal Connect wallet once the TTL has lapsed", async ({ page }) => {
    await stubApi(page);
    await installFakeWallet(page);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("connect-wallet").click();
    await page.getByTestId("wallet-option-test.fakewallet0").click();
    await expect(page.getByTestId("wallet-address")).toBeVisible();

    // One second past the 3-hour TTL.
    await backdateStoredConnection(page, 3 * 60 * 60 * 1000 + 1000);
    await page.reload();

    await expect(page.getByTestId("connect-wallet")).toBeVisible();
    await expect(page.getByTestId("wallet-address")).toHaveCount(0);
  });

  test("offers the lapsed wallet as the picker's one-press 'last used' option", async ({ page }) => {
    await stubApi(page);
    await installFakeWallet(page);
    await signIn(page);
    await page.goto("/");

    await page.getByTestId("connect-wallet").click();
    await page.getByTestId("wallet-option-test.fakewallet0").click();
    await expect(page.getByTestId("wallet-address")).toBeVisible();

    await backdateStoredConnection(page, 3 * 60 * 60 * 1000 + 1000);
    await page.reload();

    await page.getByTestId("connect-wallet").click();
    await expect(page.getByTestId("wallet-picker")).toBeVisible();
    const recent = page.getByTestId("wallet-option-recent");
    await expect(recent).toBeVisible();
    await expect(recent).toContainText("Fake Wallet 1");
    // The full picker is still there too, for choosing a different wallet.
    await expect(page.getByTestId("wallet-option-test.fakewallet0")).toBeVisible();

    await recent.click();
    await expect(page.getByTestId("wallet-address")).toBeVisible();
  });
});

test.describe("the Risk Budget refusing", () => {
  test("refuses at the surface, in the server's own words, and cannot be pressed through", async ({ page }) => {
    await stubApi(page, "over-budget");
    await page.goto("/");
    await openConfirm(page, cards[0]!.cardRef);

    await expect(page.getByTestId("refusal")).toBeVisible();
    await expect(page.getByTestId("refusal")).toContainText("Risk Budget");
    await expect(page.getByTestId("confirm")).toBeDisabled();
    await expect(page.getByTestId("practice")).toBeDisabled();
  });

  test("issues no fill after a refusal, however hard it is clicked", async ({ page }) => {
    const traffic = await stubApi(page, "over-budget");
    await page.goto("/");
    await openConfirm(page, cards[0]!.cardRef);
    await expect(page.getByTestId("refusal")).toBeVisible();

    await page.getByTestId("confirm").click({ force: true }).catch(() => {});
    await page.getByTestId("practice").click({ force: true }).catch(() => {});

    expect(traffic.paths()).not.toContain("/fill/prepare");
    expect(traffic.paths()).not.toContain("/practice");
  });
});

test.describe("the halt states", () => {
  test("a Veto stops the flow and shows both readings side by side", async ({ page }) => {
    const traffic = await stubApi(page, "veto");
    await page.goto("/");
    await deal(page).catch(() => {});

    const veto = page.getByTestId("veto");
    await expect(veto).toBeVisible();
    await expect(veto).toContainText("Nothing was signed");
    await expect(veto).toContainText("Trade Agent");
    await expect(veto).toContainText("Review Agent");

    // The clashing field is marked, and marked in text as well as in colour.
    const clashing = veto.locator("dd.bad");
    await expect(clashing).toHaveCount(fixtures.veto.clashingFields.length * 2);
    await expect(clashing.first()).toContainText("they disagree");

    expect(traffic.paths()).not.toContain("/fill/prepare");
    expect(traffic.paths()).not.toContain("/practice");
  });

  test("the Veto reads across a room", async ({ page }) => {
    await stubApi(page, "veto");
    await page.goto("/");
    await deal(page).catch(() => {});
    await expect(page.getByTestId("veto")).toBeVisible();

    // There is no Deck left to scroll past, and the headline is set at display size.
    await expect(page.getByTestId("deck")).toHaveCount(0);
    const size = await page.getByRole("heading", { level: 2 }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(20);
  });

  test("issue #32: replaces the board, the confirmation and the payoff curve too -- but not the book's own standing state", async ({ page }) => {
    await stubApi(page, "veto");
    await page.goto("/");
    await deal(page).catch(() => {});
    await expect(page.getByTestId("veto")).toBeVisible();

    // Nothing that lets a Trader act on a proposal survives a Veto: no board (real or
    // practised), no confirmation, no payoff curve for a proposal that was never made.
    await expect(page.getByTestId("board")).toHaveCount(0);
    await expect(page.getByTestId("board-empty")).toHaveCount(0);
    await expect(page.getByTestId("confirm-modal")).toHaveCount(0);
    await expect(page.getByTestId("payoff-plot")).toHaveCount(0);

    // But the rail, the tape and the Maker Depth chart -- the book's own standing
    // state, not a proposal -- stay up, so a Trader is not stranded with no way back
    // to the market they were just looking at (see the comment in `page.tsx`).
    await expect(page.getByTestId("rail-ETH")).toBeVisible();
    await expect(page.getByTestId("depth-chart")).toBeVisible();
  });

  test("the Veto survives colour being removed", async ({ page }) => {
    await stubApi(page, "veto");
    await page.goto("/");
    await deal(page).catch(() => {});
    await page.addStyleTag({ content: "* { color: #000 !important; border-color: #000 !important; }" });

    await expect(page.getByTestId("veto")).toContainText("Nothing was signed");
    await expect(page.getByTestId("veto")).toContainText("They read you differently");
  });

  test("an empty Deck reads as a market condition and names when liquidity reloads", async ({ page }) => {
    await stubApi(page, "empty");
    await page.goto("/");

    await expect(page.getByTestId("empty-deck")).toBeVisible();
    await expect(page.getByTestId("empty-deck-message")).toContainText("09:00 UTC");
    await expect(page.getByTestId("empty-deck")).not.toContainText("error");
  });

  test("offers RFQ, and the empty Deck is a way forward rather than a dead end", async ({ page }) => {
    await installFakeWallet(page);
    await stubApi(page, "empty");
    await page.goto("/");
    await connectWallet(page);

    // The empty-Deck button opens the same RFQ dialog the chips-row door does, and that
    // dialog now goes somewhere: a real request, a real wait, and a real price if a maker
    // answers. An empty book is exactly the situation the door exists for.
    await expect(page.getByTestId("empty-rfq")).toBeEnabled();
    await page.getByTestId("empty-rfq").click();
    await expect(page.getByTestId("rfq-modal")).toBeVisible();

    await page.getByTestId("rfq-submit").click();
    await expect(page.getByTestId("rfq-wait")).toHaveAttribute("data-phase", "OPEN");
    // Still nothing priced -- an empty book does not become a price by being asked.
    await expect(page.getByTestId("rfq-premium")).toHaveText("not priced yet");
  });

  test("both halt states are reachable without the agents service", async ({ page }) => {
    // The Review Agent is a Python service that has not been started. Both states came
    // out of the API's own development fixture, which is the point of ADR-0007's
    // contract-before-producer split.
    for (const scenario of ["veto", "empty"] as const) {
      await stubApi(page, scenario);
      await page.goto("/");
      if (scenario === "veto") await deal(page).catch(() => {});
      await expect(page.getByTestId(scenario === "veto" ? "veto" : "empty-deck")).toBeVisible();
    }
  });

  test("neither halt state has critical or serious accessibility violations", async ({ page }) => {
    for (const scenario of ["veto", "empty"] as const) {
      await stubApi(page, scenario);
      await page.goto("/");
      if (scenario === "veto") await deal(page).catch(() => {});
      await expect(page.getByTestId(scenario === "veto" ? "veto" : "empty-deck")).toBeVisible();

      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(
        violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${scenario}: ${v.id}`)
      ).toEqual([]);
    }
  });
});

test.describe("the golden path", () => {
  test("pick, confirm -- and nothing leaks on the way", async ({ page }) => {
    const traffic = await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await connectWallet(page);

    // Picked, and the confirmation opens for it.
    await openConfirm(page, overrideCard.cardRef);
    await expect(page.getByTestId("chosen-by")).toContainText("your pick, not the agent's");

    // The numbers came from the server, and they are the Card's.
    await expect(page.getByTestId("premium")).toHaveText(overrideCard.premiumUsdc.display);
    await expect(page.getByTestId("max-loss")).toHaveText(overrideCard.maxLossUsdc.display);

    // Confirmed, by a press inside the confirmation -- the only Confirm in the product.
    await page.getByTestId("confirm").click();
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/prepare").length).toBe(1);
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/settle").length).toBe(1);

    // Every response EXCEPT /fill/prepare's own -- which legitimately carries the real
    // transaction calldata the Trader's own wallet has to see to sign it (ADR-0011) --
    // still carries none of this. /auth/challenge, /auth/verify and /session are
    // exempted too, for a different, narrower reason: they legitimately echo the
    // TRADER'S OWN wallet address back (proving sign-in, or reporting the session's own
    // proof of it -- ADR-0012 -- not naming an Order), which happens to be the same
    // 40-hex-character shape FORBIDDEN's generic address pattern watches for. None of
    // these four are exempted from having been fetched -- only from the scan itself.
    const exemptPaths = new Set(["/fill/prepare", "/auth/challenge", "/auth/verify", "/session"]);
    const exemptIndexes = new Set(
      traffic.all.flatMap((r, i) => (exemptPaths.has(new URL(r.url()).pathname) ? [i] : []))
    );
    expect(exemptIndexes.size).toBeGreaterThanOrEqual(4);
    for (const [i, body] of traffic.bodies.entries()) {
      if (exemptIndexes.has(i)) continue;
      for (const forbidden of FORBIDDEN) expect(body).not.toMatch(forbidden);
    }
    // And /fill/prepare's body is exactly the fixture the real API produced -- not a
    // hand-widened stub standing in for a contract nobody checked.
    const prepareIndex = traffic.all.findIndex((r) => new URL(r.url()).pathname === "/fill/prepare");
    expect(traffic.bodies[prepareIndex]).toBe(JSON.stringify(fixtures.fillPrepare));
  });

  test("the same walk, ending in practice, never touches /fill/prepare", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");

    await openConfirm(page, overrideCard.cardRef);
    await expect(page.getByTestId("chosen-by")).toContainText("your pick");
    await page.getByTestId("practice").click();
    await expect(page.getByTestId("holding")).toHaveCount(1);

    expect(traffic.paths()).not.toContain("/fill/prepare");
  });
});

/**
 * The RFQ door: naming a strike the book does not offer, and buying it.
 *
 * Unlike the Card confirmation, this journey has a WAIT in the middle: an RFQ opens a
 * sealed-bid auction, so there are two signatures with a real pause between them and no
 * price at all until a maker answers (ADR-0017). What these tests hold is that the pause
 * is told truthfully -- no invented premium, no fake pending trade, a clear answer when
 * nobody bids -- alongside the same shape and accessibility bar every other dialog on
 * this surface is held to.
 */
test.describe("the RFQ door", () => {
  test.beforeEach(async ({ page }) => {
    await installFakeWallet(page);
    await stubApi(page);
  });

  test("sits above the Deck's own cards, reachable without scrolling past them", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();

    const door = page.getByTestId("rfq-door");
    await expect(door).toBeVisible();
    await expect(door).toContainText("Name your own strike");

    // The claim is about POSITION relative to the card grid a Deck can grow to any
    // length -- not about the page's initial fold, which issue #32 (not yet landed)
    // owns. The door sits in the chips row, above every Card, so reaching it never
    // means scrolling past them the way a control placed after the grid would.
    const doorBox = (await door.boundingBox())!;
    const firstCardBox = (await page.getByTestId("card").first().boundingBox())!;
    expect(doorBox.y).toBeLessThan(firstCardBox.y);
  });

  test("is styled distinctly from a Card -- dashed, not a filled tile", async ({ page }) => {
    await page.goto("/");
    const borderStyle = await page.getByTestId("rfq-door").evaluate((el) => getComputedStyle(el).borderStyle);
    expect(borderStyle).toBe("dashed");
  });

  test("opens the same shape of confirmation a Card opens", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("rfq-door").click();

    const modal = page.getByTestId("rfq-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(modal).toHaveAttribute("aria-modal", "true");
    await expect(page.getByTestId("rfq-submit")).toHaveCount(1);
    await expect(page.getByTestId("rfq-cancel")).toHaveCount(1);
  });

  test("the strike slider is a percentage from spot, and the belief sentence updates as it is dragged", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("rfq-door").click();

    const slider = page.getByTestId("rfq-strike-slider");
    await expect(slider).toHaveAttribute("min", "-30");
    await expect(slider).toHaveAttribute("max", "30");
    await expect(slider).toHaveAttribute("step", "0.5");
    await expect(slider).toHaveAttribute("aria-label", "Strike, as a percentage from spot");

    const before = await page.getByTestId("rfq-belief").innerText();
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    const after = await page.getByTestId("rfq-belief").innerText();
    expect(after).not.toBe(before);
    await expect(page.getByTestId("rfq-offset-readout")).toContainText("%");
  });

  test("never prints a dollar strike while dragging -- only the percentage the slider itself names", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("rfq-door").click();

    const slider = page.getByTestId("rfq-strike-slider");
    await slider.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");

    // Nobody has priced this strike -- server included -- so nothing in the belief
    // sentence or the live offset readout may be a dollar figure, dragging or not.
    await expect(page.getByTestId("rfq-belief")).not.toContainText("$");
    await expect(page.getByTestId("rfq-offset-readout")).not.toContainText("$");
  });

  test("expiry is offered in tenors longer than the book, under a note that the book stops at 3 days", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("rfq-door").click();

    for (const days of [7, 14, 30, 60]) {
      await expect(page.getByTestId(`rfq-tenor-${days}`)).toBeVisible();
    }
    await expect(page.getByTestId("rfq-modal")).toContainText("book stops at 3 days");

    await page.getByTestId("rfq-tenor-30").click();
    await expect(page.getByTestId("rfq-tenor-30")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("rfq-belief")).toContainText("30 days");
  });

  test("shows no premium and no Implied Chance -- both explicitly unpriced, never simply absent", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("rfq-door").click();

    await expect(page.getByTestId("rfq-premium")).toBeVisible();
    await expect(page.getByTestId("rfq-premium")).toHaveText("not priced yet");
    await expect(page.getByTestId("rfq-chance")).toBeVisible();
    await expect(page.getByTestId("rfq-chance")).toHaveText("not priced yet");
  });

  test("shows Max Loss, and states the size is a reserve price enforced on-chain", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("rfq-door").click();

    await expect(page.getByTestId("rfq-max-loss")).toBeVisible();
    await expect(page.getByTestId("rfq-max-loss")).toHaveText("$2");
    await expect(page.getByTestId("rfq-reserve-note")).toContainText("reserve price");
    await expect(page.getByTestId("rfq-reserve-note")).toContainText("enforced on-chain");
  });

  test("cannot be opened without a verified wallet, and says so rather than failing on press", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rfq-door").click();

    await expect(page.getByTestId("rfq-submit")).toBeDisabled();
    await expect(page.getByTestId("rfq-gate")).toContainText(/connect and verify/i);
    expect(traffic.paths()).not.toContain("/rfq");
  });

  test("the first press opens a request and buys nothing -- still no premium anywhere", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await connectWallet(page);
    await page.getByTestId("rfq-door").click();
    await page.getByTestId("rfq-submit").click();

    const wait = page.getByTestId("rfq-wait");
    await expect(wait).toBeVisible();
    await expect(wait).toHaveAttribute("role", "status");
    await expect(wait).toHaveAttribute("data-phase", "OPEN");
    await expect(page.getByTestId("rfq-wait-sentence")).toContainText(/Nothing is owed unless you accept/i);

    // Still unpriced: an RFQ nobody has answered has no premium, and the ceiling above it
    // is not a substitute for one.
    await expect(page.getByTestId("rfq-premium")).toHaveText("not priced yet");
    await expect(page.getByTestId("rfq-chance")).toHaveText("not priced yet");

    expect(traffic.paths()).toContain("/rfq");
    expect(traffic.paths()).toContain("/rfq/confirm");
    expect(traffic.paths()).not.toContain("/rfq/settle/prepare");
    // The RFQ path never touches the routes that fill a resting Order or practise one.
    expect(traffic.paths()).not.toContain("/fill");
    expect(traffic.paths()).not.toContain("/practice");
  });

  test("the request restates the strike as the server's own dollar figure, off what was asked", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await connectWallet(page);
    await page.getByTestId("rfq-door").click();

    await page.getByTestId("rfq-tenor-14").click();
    await page.getByTestId("rfq-size-preset-2").click();
    await page.getByTestId("rfq-submit").click();
    await expect(page.getByTestId("rfq-wait")).toBeVisible();

    // ETH falls by default (direction DOWN), so the door opens 10% below the fixture's
    // $2,445.49 spot -- $2,200.94, formatted the way `apps/api/src/format.ts` formats it.
    // The browser never computed it: it arrived as a string on the Ask.
    await expect(page.getByTestId("rfq-belief")).toContainText("$2,200.94");
    await expect(page.getByTestId("rfq-max-loss")).toHaveText("$2.00");
  });

  test("freezes the controls once a request is on-chain -- what was signed cannot be edited", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await connectWallet(page);
    await page.getByTestId("rfq-door").click();
    await page.getByTestId("rfq-submit").click();
    await expect(page.getByTestId("rfq-wait")).toBeVisible();

    await expect(page.getByTestId("rfq-strike-slider")).toBeDisabled();
    await expect(page.getByTestId("rfq-tenor-30")).toBeDisabled();
    await expect(page.getByTestId("rfq-size-preset-2")).toBeDisabled();
    await expect(page.getByTestId("rfq-submit")).toHaveCount(0);
  });

  test("a maker's answer is the first price shown, and paying takes a second press that names it", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await connectWallet(page);
    await page.getByTestId("rfq-door").click();
    await page.getByTestId("rfq-submit").click();
    await expect(page.getByTestId("rfq-wait")).toBeVisible();

    await advanceOffers(page, async () => (await page.getByTestId("rfq-wait").getAttribute("data-phase")) === "OFFERED");
    await expect(page.getByTestId("rfq-wait")).toHaveAttribute("data-phase", "OFFERED");
    await expect(page.getByTestId("rfq-premium")).toHaveText("$1.25");

    // The button that spends money names the amount, so nobody presses it unread -- and
    // requesting alone never reached the settle routes.
    const accept = page.getByTestId("rfq-accept");
    await expect(accept).toContainText("$1.25");
    expect(traffic.paths()).not.toContain("/rfq/settle/prepare");

    await accept.click();
    await expect(page.getByTestId("rfq-wait")).toHaveAttribute("data-phase", "SETTLED");
    await expect(page.getByTestId("rfq-receipt")).toBeVisible();
    expect(traffic.paths()).toContain("/rfq/settle");
  });

  test("an unanswered request says nobody bid and offers a withdrawal, rather than hanging", async ({ page }) => {
    await stubApi(page, "rfq-unanswered");
    await page.goto("/");
    await connectWallet(page);
    await page.getByTestId("rfq-door").click();
    await page.getByTestId("rfq-submit").click();
    await expect(page.getByTestId("rfq-wait")).toBeVisible();

    await advanceOffers(page, async () => (await page.getByTestId("rfq-wait").getAttribute("data-phase")) === "NO_OFFERS");
    await expect(page.getByTestId("rfq-wait")).toHaveAttribute("data-phase", "NO_OFFERS");
    await expect(page.getByTestId("rfq-wait-sentence")).toContainText(/nobody answered/i);
    await expect(page.getByTestId("rfq-wait-sentence")).toContainText(/No USDC moved/i);

    // Never a price: nobody quoted one.
    await expect(page.getByTestId("rfq-premium")).toHaveText("not priced yet");
    await expect(page.getByTestId("rfq-accept")).toHaveCount(0);
    await expect(page.getByTestId("rfq-withdraw")).toContainText("Withdraw request");
  });

  test("opens exactly one request, and there is no second Request quotes to press", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await connectWallet(page);
    await page.getByTestId("rfq-door").click();
    await page.getByTestId("rfq-submit").click();
    await expect(page.getByTestId("rfq-wait")).toBeVisible();

    // The button is GONE rather than merely inert -- a stronger guarantee than a disabled
    // control, and the reason a double-press cannot open two requests against one budget.
    await expect(page.getByTestId("rfq-submit")).toHaveCount(0);
    expect(traffic.paths().filter((p) => p === "/rfq").length).toBe(1);
  });

  test("Escape dismisses, and returns focus to the door that opened it", async ({ page }) => {
    await page.goto("/");
    const door = page.getByTestId("rfq-door");
    await door.click();
    await expect(page.getByTestId("rfq-modal")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("rfq-modal")).toHaveCount(0);
    await expect(door).toBeFocused();
  });

  test("a backdrop click dismisses", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("rfq-door").click();

    await page.getByTestId("rfq-scrim").click({ position: { x: 2, y: 2 } });
    await expect(page.getByTestId("rfq-modal")).toHaveCount(0);
  });

  test("the empty-Deck message points at this door and opens the same dialog", async ({ page }) => {
    await stubApi(page, "empty");
    await page.goto("/");
    await expect(page.getByTestId("empty-rfq")).toBeEnabled();

    await page.getByTestId("empty-rfq").click();
    await expect(page.getByTestId("rfq-modal")).toBeVisible();
  });

  test("traps focus inside the dialog, the slider included", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("rfq-door").click();

    const dialog = page.getByTestId("rfq-modal");
    const focusable = dialog.locator('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const count = await focusable.count();
    expect(count).toBeGreaterThan(1);

    await focusable.first().focus();
    await page.keyboard.press("Shift+Tab");
    await expect(focusable.last()).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(focusable.first()).toBeFocused();
  });

  test("issue #32: has no 'quote moved' state -- nothing is priced here for the book to move out from under", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await page.getByTestId("rfq-door").click();

    // The same reprice that flips the Card confirmation's `quote-moved` banner, held
    // open across a full poll interval -- but inside the RFQ dialog instead.
    traffic.moveTheQuote();
    await page.clock.runFor(7000);

    await expect(page.locator('[data-testid="quote-moved"]')).toHaveCount(0);
    await expect(page.getByTestId("rfq-modal")).not.toContainText("price moved");
    // Still the asking state -- a moved book has nothing to move here.
    await expect(page.getByTestId("rfq-submit")).toHaveCount(1);
    await expect(page.getByTestId("rfq-wait")).toHaveCount(0);
  });

  test("has no critical or serious accessibility violations, open or refused", async ({ page }) => {
    // connectWallet() reloads the page, so the first real navigation has to happen
    // before it runs -- and it has to run before the door is opened, since the modal
    // itself is not what's under test here, just its two states once reachable.
    await page.goto("/");
    await connectWallet(page);
    await page.getByTestId("rfq-door").click();

    const opened = await new AxeBuilder({ page }).analyze();
    expect(
      opened.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id)
    ).toEqual([]);

    await page.getByTestId("rfq-submit").click();
    await expect(page.getByTestId("rfq-wait")).toBeVisible();

    const refused = await new AxeBuilder({ page }).analyze();
    expect(
      refused.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id)
    ).toEqual([]);
  });
});

/**
 * Issue #32 -- the board, and loading without blanking.
 *
 * A network stub answers instantly, which is exactly the width the ticket's own
 * loading states occupy in real life -- too narrow for a normal test to ever observe.
 * `traffic.hold(path)` (see `stub.ts`) widens that window on demand: the tests below
 * hold a request open, assert on the state while it is genuinely in flight, then
 * release it and assert the state that follows.
 */
test.describe("loading, without blanking the surface", () => {
  test("the board shows a loading state, not \"nothing open\", before positions have answered", async ({ page }) => {
    const traffic = await stubApi(page);
    const release = traffic.hold("/positions");
    await page.goto("/");

    await expect(page.getByTestId("board-loading")).toBeVisible();
    await expect(page.getByTestId("board-empty")).toHaveCount(0);

    release();
    await expect(page.getByTestId("board-empty")).toBeVisible();
    await expect(page.getByTestId("board-loading")).toHaveCount(0);
  });

  test("the board reads across every Underlying, not scoped to the one selected on the rail", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("board-empty")).toBeVisible();

    await page.getByTestId("rail-SOL").click();
    await expect(page.getByTestId("rail-SOL")).toHaveAttribute("aria-pressed", "true");

    // GET /positions carries no `asset` -- it is not re-fetched by, or scoped to, the
    // rail's own selection (`apps/api/src/app.ts`'s `/positions` prices every
    // Underlying's spot in the one read).
    const positionsRequests = traffic.all.filter((r) => new URL(r.url()).pathname === "/positions");
    expect(positionsRequests.length).toBe(1);
    expect(new URL(positionsRequests[0]!.url()).searchParams.get("asset")).toBeNull();
  });

  test("the rail shows a loading state before markets have answered", async ({ page }) => {
    const traffic = await stubApi(page);
    const release = traffic.hold("/markets");
    await page.goto("/");

    await expect(page.getByTestId("rail-loading")).toBeVisible();
    await expect(page.getByTestId("rail-loading")).toContainText("Reading the markets");
    await expect(page.getByTestId("rail-ETH")).toHaveCount(0);

    release();
    await expect(page.getByTestId("rail-ETH")).toBeVisible();
    await expect(page.getByTestId("rail-loading")).toHaveCount(0);
  });

  test("the Deck and the depth chart each show a loading state before the first read lands", async ({ page }) => {
    const traffic = await stubApi(page);
    const releaseDeck = traffic.hold("/deck");
    const releaseDepth = traffic.hold("/depth");
    await page.goto("/");

    await expect(page.getByTestId("deck-loading")).toBeVisible();
    await expect(page.getByTestId("depth-loading")).toBeVisible();
    await expect(page.getByTestId("deck")).toHaveCount(0);
    await expect(page.getByTestId("depth-chart")).toHaveCount(0);

    releaseDeck();
    await expect(page.getByTestId("deck")).toBeVisible();
    await expect(page.getByTestId("deck-loading")).toHaveCount(0);

    releaseDepth();
    await expect(page.getByTestId("depth-chart")).toBeVisible();
    await expect(page.getByTestId("depth-loading")).toHaveCount(0);
  });

  test("switching Underlying keeps the last Deck on screen, disabled, under an 'Updating' note -- not blanked", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();
    const priorCardCount = await page.getByTestId("card").count();

    const release = traffic.hold("/deck");
    await page.getByTestId("rail-SOL").click();

    // The ETH Deck stays on screen -- not replaced by a bare loading paragraph -- and
    // it is disabled: a stray click on a stale Card must not send the NEW asset
    // alongside a `cardRef` that only exists on the OLD one.
    await expect(page.getByTestId("deck-refreshing")).toBeVisible();
    await expect(page.getByTestId("card")).toHaveCount(priorCardCount);
    await expect(page.getByTestId("card").first()).toBeDisabled();

    release();
    await expect(page.getByTestId("deck-refreshing")).toHaveCount(0);
    await expect(page.getByTestId("card").first()).toBeEnabled();
  });

  test("switching Underlying keeps the last depth chart on screen under an 'Updating' note -- not blanked", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("depth-chart")).toBeVisible();

    // Both /deck and /depth are held. /deck's answer is what `fullestExpiry` in
    // `lib/surface.ts` uses to move a Trader onto the expiry with the most Cards --
    // left to resolve here, on an instantly-answering stub, it would change
    // `horizonDays` and drive a SECOND, un-held /depth request before this test ever
    // gets to observe the loading state. A genuinely slow network would not race like
    // that: both requests would still be in flight together.
    const releaseDeck = traffic.hold("/deck");
    const releaseDepth = traffic.hold("/depth");
    await page.getByTestId("rail-SOL").click();

    await expect(page.getByTestId("depth-refreshing")).toBeVisible();
    await expect(page.getByTestId("depth-chart")).toBeVisible();

    releaseDeck();
    releaseDepth();
    await expect(page.getByTestId("depth-refreshing")).toHaveCount(0);
  });

  test("has no critical or serious accessibility violations while the Deck, the depth chart, the rail and the board are all still loading", async ({ page }) => {
    const traffic = await stubApi(page);
    traffic.hold("/deck");
    traffic.hold("/depth");
    traffic.hold("/markets");
    traffic.hold("/positions");
    await page.goto("/");

    await expect(page.getByTestId("deck-loading")).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id)).toEqual([]);
  });
});
