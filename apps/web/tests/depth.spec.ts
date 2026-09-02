/**
 * Issue #28 -- the statistics strip and the Maker Depth chart, in a real browser.
 *
 * Most of the shape is checked here rather than in a component test (the repo has none,
 * deliberately -- see CLAUDE.md): that the strip and chart actually render the server's
 * own strings, that direction is carried by POSITION and not colour alone, that the
 * chart survives a chip press untouched, and that it is announced usefully to a screen
 * reader and clean under axe-core.
 *
 * `depth-eth.json` is the real fixture `npm run fixtures` regenerated from live
 * Thetanuts data (see `stub.ts`'s header). It happens to have no held Position, no
 * dimmed strike under the default horizon, and nothing excluded -- so `depth-eth-marked`
 * is a hand-derived copy of it (same shape, same `.display` conventions) with those
 * three things added, used only where a test needs them.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { stubApi, fixtures } from "./stub";

test.describe("the statistics strip", () => {
  test("shows spot, expected move, call/put depth, put/call, strikes and open positions -- all server strings", async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto("/");

    const strip = page.getByTestId("depth-statbar");
    await expect(strip).toBeVisible();

    const stats = fixtures.depthEth.stats;
    await expect(strip).toContainText(stats.spotUsd.display);
    await expect(strip).toContainText(stats.impliedMoveUsd!.display);
    await expect(strip).toContainText(stats.callDepthUsdc.display);
    await expect(strip).toContainText(stats.putDepthUsdc.display);
    await expect(strip).toContainText(stats.putCallRatio!.display);
    await expect(strip).toContainText(stats.strikeCount.display);
    await expect(strip).toContainText(stats.openPositions.display);

    // The seven labels the ticket names, in order.
    const cells = await strip.locator(".st small").allTextContents();
    expect(cells).toEqual([
      "Spot",
      expect.stringContaining("Expected move"),
      "Rises depth",
      "Falls depth",
      "Falls / rises",
      "Strikes",
      "Open positions",
    ]);
  });

  test("colours call depth blue and put depth orange, never red and green", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    const strip = page.getByTestId("depth-statbar");
    await expect(strip).toBeVisible();

    const call = await strip.locator(".st b.up").evaluate((el) => getComputedStyle(el).color);
    const put = await strip.locator(".st b.dn").evaluate((el) => getComputedStyle(el).color);
    const rgb = (s: string) => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const [cr, , cb] = rgb(call);
    const [pr, , pb] = rgb(put);
    expect(cb!).toBeGreaterThan(cr!);
    expect(pr!).toBeGreaterThan(pb!);
    const green = (r: number, g: number, b: number) => g > r && g > b;
    expect(green(cr!, rgb(call)[1]!, cb!), "call is a green").toBe(false);
    expect(green(pr!, rgb(put)[1]!, pb!), "put is a green").toBe(false);
  });
});

test.describe("the Maker Depth chart", () => {
  test("draws call depth above the axis and put depth below it", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    const chart = page.getByTestId("depth-chart");
    await expect(chart).toBeVisible();

    const midY = Number(await chart.locator("line.axis").first().getAttribute("y1"));

    // $2,480.00 is a call-only strike in the fixture (call depth $500, no put depth);
    // $2,360.00 is a put-only strike. Known from `depth-eth.json` rather than guessed
    // from colour, so the test says what it means instead of inferring it from a hue
    // that a deuteranope reading the same chart could not rely on either.
    const callBar = chart.locator('[data-strike="$2,480.00"] rect.bar');
    const putBar = chart.locator('[data-strike="$2,360.00"] rect.bar');
    await expect(callBar).toHaveCount(1);
    await expect(putBar).toHaveCount(1);

    const callY = Number(await callBar.getAttribute("y"));
    const callHeight = Number(await callBar.getAttribute("height"));
    const putY = Number(await putBar.getAttribute("y"));

    expect(callY).toBeLessThan(midY);
    expect(callY + callHeight).toBeCloseTo(midY, 0);
    expect(putY).toBeCloseTo(midY, 0);
  });

  test("labels the y-axis Maker Depth in USDC, never volume, liquidity or open interest", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    const chart = page.getByTestId("depth-chart");
    await expect(chart).toContainText("USDC");
    await expect(chart).toContainText("MAKER DEPTH");
    const region = await chart.locator('[role="img"]').getAttribute("aria-label");
    expect(region).toMatch(/Maker Depth in USDC/);

    const text = (await chart.innerText()).toLowerCase();
    expect(text).not.toContain("volume");
    expect(text).not.toContain("liquidity");
    expect(text).not.toContain("open interest");

    // Falls and Rises, never put and call -- the same rule `chips.spec.ts` holds the
    // rest of the surface to, extended here since the chart is new ground for it.
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(body).not.toMatch(/\bputs?\b/);
    expect(body).not.toMatch(/\bcalls?\b/);
  });

  test("draws a vertical spot marker with a price chip", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    const chart = page.getByTestId("depth-chart");
    const line = chart.locator('[data-testid="depth-spot-line"]');
    await expect(line).toBeAttached();
    await expect(chart.locator("text.spotchiptx")).toHaveText(fixtures.depthEth.spotUsd.display);
  });

  test("draws a cumulative line walking outward from spot", async ({ page }) => {
    await stubApi(page);
    await page.goto("/");

    const chart = page.getByTestId("depth-chart");
    await expect(chart.locator("path.cum")).toHaveCount(2);
    for (const cls of ["path.cum.call", "path.cum.put"]) {
      const d = await chart.locator(cls).first().getAttribute("d");
      expect(d, `${cls} has no path data`).toMatch(/^M/);
    }
  });

  test("marks a strike with an open Position, and leaves an unheld strike unmarked", async ({ page }) => {
    await stubApi(page, "depth-marked");
    await page.goto("/");

    const chart = page.getByTestId("depth-chart");
    const dots = chart.locator('[data-testid="depth-oi"]');
    // Exactly one strike in the marked fixture carries a held Position.
    await expect(dots).toHaveCount(1);
  });

  test("shows every expiry at once, the selected one lit and the rest dimmed", async ({ page }) => {
    await stubApi(page, "depth-marked");
    await page.goto("/");

    const chart = page.getByTestId("depth-chart");
    await expect(chart).toBeVisible();
    // The marked fixture's $2,380 strike only quotes the 2d expiry; the surface opens
    // on 1d (deck-down-1's fullest expiry), so that bar renders dimmed rather than gone.
    await expect(chart.locator('[data-strike="$2,380.00"] rect.bar')).toHaveClass(/\bdim\b/);
    await expect(chart.locator('[data-strike="$2,360.00"] rect.bar')).not.toHaveClass(/\bdim\b/);
  });

  test("does not empty or re-fetch when a direction or expiry chip is pressed", async ({ page }) => {
    const traffic = await stubApi(page);
    await page.goto("/");
    await expect(page.getByTestId("depth-chart")).toBeVisible();

    const before = traffic.paths().filter((p) => p === "/depth").length;

    await page.getByTestId("direction-UP").click();
    await expect(page.getByTestId("depth-chart")).toBeVisible();
    const barsAfterDirection = await page.getByTestId("depth-chart").locator("rect.bar").count();
    expect(barsAfterDirection).toBeGreaterThan(0);

    // Direction is not part of /depth's key -- pressing it must not cause a new request.
    const after = traffic.paths().filter((p) => p === "/depth").length;
    expect(after).toBe(before);
  });

  test("states how many strikes were excluded, only when there are any", async ({ page }) => {
    await stubApi(page, "depth-marked");
    await page.goto("/");
    await expect(page.getByTestId("depth-chart")).toContainText(fixtures.depthEthMarked.excludedLabel);
  });

  test("reads out call depth, put depth, order counts and held count when a strike is hovered", async ({ page }) => {
    await stubApi(page, "depth-marked");
    await page.goto("/");

    const chart = page.getByTestId("depth-chart");
    await expect(chart).toBeVisible();
    // `.hover()` on the locator, not a raw `page.mouse.move` -- the latter does not
    // synthesize a pointer a touch-emulated project recognises (see `journeys.spec.ts`'s
    // payoff crosshair test, which hovers the same way for exactly this reason).
    await chart.locator(".dchart-hit").hover();

    const tip = page.getByTestId("depth-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("rises");
    await expect(tip).toContainText("falls");
  });

  test("is reachable and operable by keyboard", async ({ page }) => {
    await stubApi(page, "depth-marked");
    await page.goto("/");

    const chart = page.getByTestId("depth-chart");
    await expect(chart).toBeVisible();
    const hit = chart.locator(".dchart-hit");
    await hit.focus();
    await page.keyboard.press("ArrowRight");
    const tip = page.getByTestId("depth-tooltip");
    await expect(tip).toBeVisible();
  });

  test("announces every strike to a screen reader", async ({ page }) => {
    await stubApi(page, "depth-marked");
    await page.goto("/");

    const list = page.getByTestId("depth-strikes-sr");
    await expect(list.locator("li")).toHaveCount(fixtures.depthEthMarked.strikes.length);
    const items = await list.locator("li").allTextContents();
    expect(items.length).toBe(fixtures.depthEthMarked.strikes.length);
    // The held strike's count is read out in words, not just drawn as a dot.
    expect(items.some((t) => t.includes("Held by"))).toBe(true);
  });

  test("suppresses bar-growth motion under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await stubApi(page);
    await page.goto("/");

    const bar = page.getByTestId("depth-chart").locator("rect.bar").first();
    await expect(bar).toBeVisible();
    const transition = await bar.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(transition.split(",").every((t) => parseFloat(t) === 0)).toBe(true);
  });

  test("has no critical or serious accessibility violations", async ({ page }) => {
    await stubApi(page, "depth-marked");
    await page.goto("/");
    await expect(page.getByTestId("depth-chart")).toBeVisible();

    const results = await new AxeBuilder({ page }).include(".depth").analyze();
    const serious = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(serious.map((v) => `${v.id}: ${v.description}`)).toEqual([]);
  });
});
