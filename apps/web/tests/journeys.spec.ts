/**
 * Issues #11-#14 -- the surface walked end to end.
 *
 * The API suite already proves a Card's premium equals the Trade Proposal's for the same
 * cardRef. That test cannot see the failure that actually reaches a Trader: React
 * rounding, truncating or reformatting on the way to the screen. So the equality is
 * asserted HERE, in the DOM, character for character.
 *
 * Everything else in this file is a journey rather than a unit: deal, override, confirm;
 * the same walk ending in a Practice Run with the network watched; Max Loss holding
 * still while a Trader flicks; the Risk Budget refusing; and the two halt states.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { cards, fixtures, FORBIDDEN, installFakeWallet, stubApi, TEST_API_TOKEN } from "./stub";

const agentCard = fixtures.proposeAgent.cardRef;
const overrideCard = cards.find((c) => c.cardRef !== agentCard)!;
const overrideProposal = fixtures.proposeByCard[overrideCard.cardRef];

/** The Copilot deals. The seed on the left is the only way to ask it to. */
const deal = async (page: Page) => {
  await page.getByRole("button", { name: "I think ETH drops before Friday" }).click();
  await expect(page.getByTestId("chosen-by")).toBeVisible();
};

/** Connects the fake wallet -- every journey that reaches Confirm needs this first. */
const connectWallet = async (page: Page) => {
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toBeVisible();
};

test.describe("selection, and who chose", () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page);
  });

  test("marks the dealt Card as the agent's, and lifts it", async ({ page }) => {
    await page.goto("/");
    await deal(page);

    await expect(page.getByTestId("chosen-by")).toContainText("the agent picked this");
    const dealt = page.locator(`[data-card-ref="${agentCard}"]`);
    await expect(dealt).toHaveClass(/dealt/);
    await expect(dealt).toHaveAttribute("aria-pressed", "true");
  });

  test("marks an override as the Trader's, not the agent's", async ({ page }) => {
    await page.goto("/");
    await deal(page);

    await page.locator(`[data-card-ref="${overrideCard.cardRef}"]`).click();

    await expect(page.getByTestId("chosen-by")).toContainText("your pick, not the agent's");
    await expect(page.getByTestId("chosen-by")).not.toContainText("the agent picked this");
  });

  test("asks the server for the numbers rather than reading the Card in the browser", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await deal(page);
    await page.locator(`[data-card-ref="${overrideCard.cardRef}"]`).click();
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
    await deal(page);

    const gate = page.getByRole("list", { name: "Who has to agree before anything is signed" });
    const chips = gate.getByRole("listitem");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toContainText("Trade Agent");
    await expect(chips.nth(1)).toContainText("Review");
    await expect(chips.nth(2)).toContainText("You");
    await expect(chips.nth(2)).toHaveClass(/wait/);
  });

  test("says the Review Agent ran even when the Trader overrode it", async ({ page }) => {
    await page.goto("/");
    await deal(page);
    await page.locator(`[data-card-ref="${overrideCard.cardRef}"]`).click();

    await expect(page.getByRole("listitem").filter({ hasText: "Review" })).toContainText("your override");
  });

  test("draws the pending Fill on the Risk Budget as a ghost segment", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("risk-pending")).toHaveCSS("width", "0px");

    await deal(page);
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

test.describe("Max Loss holds still", () => {
  test("does not change as the Trader flicks across every Card", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    const maxLoss = page.getByTestId("max-loss");
    await expect(maxLoss).not.toHaveText("—");
    const before = await maxLoss.textContent();

    for (const card of cards) {
      await page.locator(`[data-card-ref="${card.cardRef}"]`).click();
      await expect(page.getByTestId("chosen-by")).toBeVisible();
      expect(await maxLoss.textContent()).toBe(before);
    }
  });

  test("stays on screen when the page is scrolled", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await deal(page);

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
     * are compared as RENDERED, from the Card the Trader clicked to the commit bar they
     * are about to press.
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
  test("makes Confirm and Practice Run unmistakable from each other", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await deal(page);

    const confirm = page.getByTestId("confirm");
    const practice = page.getByTestId("practice");

    await expect(practice).toContainText("no money");
    await expect(confirm).toContainText("Confirm");

    // Not colour alone: one is a solid slab, the other a dashed outline.
    const styles = await Promise.all(
      [confirm, practice].map((b) =>
        b.evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, border: s.borderStyle, weight: s.fontWeight };
        })
      )
    );
    expect(styles[0]!.bg).not.toBe(styles[1]!.bg);
    expect(styles[1]!.border).toContain("dashed");
  });

  test("a Practice Run issues no request to /fill/prepare", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await deal(page);

    await page.getByTestId("practice").click();
    await expect(page.getByTestId("holding")).toHaveCount(1);

    // Asserted on captured traffic, not on code shape: the surface may not even try.
    expect(traffic.paths()).toContain("/practice");
    expect(traffic.paths()).not.toContain("/fill/prepare");
  });

  test("labels a practice holding as practice, three ways", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await deal(page);
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

    await deal(page);
    await page.getByTestId("practice").click();

    await expect(page.getByTestId("board-empty")).toHaveCount(0);
    await expect(page.getByTestId("board")).toBeVisible();
  });

  test("shows a draining bar, a running countdown and a current value on each holding", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await deal(page);
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

  test("Confirm spends only on the Trader's own press", async ({ page }) => {
    const traffic = await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await connectWallet(page);
    await deal(page);

    // Everything up to this point priced a real Order. Nothing has been signed.
    expect(traffic.paths()).not.toContain("/fill/prepare");

    await page.getByTestId("confirm").click();
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/prepare").length).toBe(1);
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/settle").length).toBe(1);
  });

  test("Confirm stays disabled until a wallet is connected", async ({ page }) => {
    const traffic = await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await deal(page);

    await expect(page.getByTestId("confirm")).toBeDisabled();
    await expect(page.getByTestId("wallet-gate")).toBeVisible();
    // Practice Run never needs a wallet, and stays pressable throughout.
    await expect(page.getByTestId("practice")).toBeEnabled();

    await page.getByTestId("confirm").click({ force: true }).catch(() => {});
    expect(traffic.paths()).not.toContain("/fill/prepare");

    await connectWallet(page);
    await expect(page.getByTestId("confirm")).toBeEnabled();
    await expect(page.getByTestId("wallet-gate")).toHaveCount(0);
  });

  test("shows a connecting state, then the connected address", async ({ page }) => {
    await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");

    const connect = page.getByTestId("connect-wallet");
    await expect(connect).toHaveText("Connect wallet");
    await connect.click();
    await expect(page.getByTestId("wallet-address")).toBeVisible();
    await expect(page.getByTestId("connect-wallet")).toHaveCount(0);
  });

  test("hands the Trader the transaction once real money has moved", async ({ page }) => {
    await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await connectWallet(page);
    await deal(page);
    await expect(page.getByTestId("receipt")).toHaveCount(0);

    await page.getByTestId("confirm").click();

    // Being told "bought" and given nothing to check is being asked to take our word
    // for it at the one moment a Trader should not have to.
    const receipt = page.getByTestId("receipt");
    await expect(receipt).toBeVisible();
    await expect(receipt.getByRole("link")).toHaveAttribute("href", /^https?:\/\//);
  });

  test("still shows the receipt when reporting success back to the server fails", async ({ page }) => {
    // The wallet has already broadcast and mined the transaction by the time the app
    // tells the backend about it -- real money has moved, so a failure of THAT report
    // must never be shown to the Trader as if their fill itself had failed.
    await stubApi(page, "settle-fails");
    await installFakeWallet(page);
    await page.goto("/");
    await connectWallet(page);
    await deal(page);

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
    await deal(page);

    const before = await page.getByTestId("risk-remaining").textContent();

    await page.getByTestId("confirm").click();

    await expect(page.getByTestId("receipt")).toHaveCount(0);
    await expect(page.getByTestId("refusal")).toBeVisible();
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/settle").length).toBe(1);
    const settleBody = traffic.all.find((r) => new URL(r.url()).pathname === "/fill/settle")!.postDataJSON();
    expect(settleBody.succeeded).toBe(false);

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
    await deal(page);
    await page.getByTestId("confirm").click();
    await expect.poll(() => traffic.paths().includes("/fill/prepare")).toBe(true);

    const request = traffic.all.find((r) => new URL(r.url()).pathname === "/fill/prepare")!;
    expect(await request.headerValue("authorization")).toBe(`Bearer ${TEST_API_TOKEN}`);
  });

  test("surfaces a moved quote before the Trader confirms, not after", async ({ page }) => {
    const traffic = await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await connectWallet(page);
    await deal(page);
    await expect(page.getByTestId("confirm")).toBeEnabled();

    // The book reprices under them while the proposal is on screen.
    traffic.moveTheQuote();
    await page.clock.runFor(7000);

    await expect(page.getByTestId("quote-moved")).toBeVisible();
    await expect(page.getByTestId("confirm")).toBeDisabled();
    await expect(page.getByTestId("practice")).toBeDisabled();
    // Story 30: never filled at a price they did not see.
    expect(traffic.paths()).not.toContain("/fill/prepare");
  });

  test("neither button is pressable before a Card is picked", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("card").first()).toBeVisible();

    await expect(page.getByTestId("confirm")).toBeDisabled();
    await expect(page.getByTestId("practice")).toBeDisabled();
  });
});

test.describe("the Risk Budget refusing", () => {
  test("refuses at the surface, in the server's own words, and cannot be pressed through", async ({ page }) => {
    await stubApi(page, "over-budget");
    await page.goto("/");
    await page.getByTestId("card").first().click();

    await expect(page.getByTestId("refusal")).toBeVisible();
    await expect(page.getByTestId("refusal")).toContainText("Risk Budget");
    await expect(page.getByTestId("confirm")).toBeDisabled();
    await expect(page.getByTestId("practice")).toBeDisabled();
  });

  test("issues no fill after a refusal, however hard it is clicked", async ({ page }) => {
    const traffic = await stubApi(page, "over-budget");
    await page.goto("/");
    await page.getByTestId("card").first().click();
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

  test("offers RFQ without pretending it is wired", async ({ page }) => {
    await stubApi(page, "empty");
    await page.goto("/");

    await expect(page.getByTestId("empty-rfq")).toBeDisabled();
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
  test("deal, override, confirm -- and nothing leaks on the way", async ({ page }) => {
    const traffic = await stubApi(page);
    await installFakeWallet(page);
    await page.goto("/");
    await connectWallet(page);

    // Dealt.
    await deal(page);
    await expect(page.getByTestId("chosen-by")).toContainText("the agent picked this");

    // Overruled.
    await page.locator(`[data-card-ref="${overrideCard.cardRef}"]`).click();
    await expect(page.getByTestId("chosen-by")).toContainText("your pick, not the agent's");

    // The numbers came from the server, and they are the Card's.
    await expect(page.getByTestId("premium")).toHaveText(overrideCard.premiumUsdc.display);
    await expect(page.getByTestId("max-loss")).toHaveText(overrideCard.maxLossUsdc.display);

    // Confirmed, by a press.
    await page.getByTestId("confirm").click();
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/prepare").length).toBe(1);
    await expect.poll(() => traffic.paths().filter((p) => p === "/fill/settle").length).toBe(1);

    // Every response EXCEPT /fill/prepare's own -- which legitimately carries the real
    // transaction calldata the Trader's own wallet has to see to sign it (ADR-0009) --
    // still carries none of this. /fill/prepare's body is deliberately not exempted
    // from having been fetched; it is exempted from the FORBIDDEN scan alone.
    const prepareIndex = traffic.all.findIndex((r) => new URL(r.url()).pathname === "/fill/prepare");
    expect(prepareIndex).toBeGreaterThanOrEqual(0);
    for (const [i, body] of traffic.bodies.entries()) {
      if (i === prepareIndex) continue;
      for (const forbidden of FORBIDDEN) expect(body).not.toMatch(forbidden);
    }
    // And /fill/prepare's body is exactly the fixture the real API produced -- not a
    // hand-widened stub standing in for a contract nobody checked.
    expect(traffic.bodies[prepareIndex]).toBe(JSON.stringify(fixtures.fillPrepare));
  });

  test("the same walk, ending in practice, never touches /fill/prepare", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");

    await deal(page);
    await page.locator(`[data-card-ref="${overrideCard.cardRef}"]`).click();
    await expect(page.getByTestId("chosen-by")).toContainText("your pick");
    await page.getByTestId("practice").click();
    await expect(page.getByTestId("holding")).toHaveCount(1);

    expect(traffic.paths()).not.toContain("/fill/prepare");
  });
});
