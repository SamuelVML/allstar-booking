// Browser tests for the Backstage sheets.
//
// Backstage is behind Cloudflare Access, which cannot be satisfied locally or
// in CI, so these flows would otherwise only be testable by deploying and
// signing in by hand. This starts a Vite dev server over `harness.tsx`, which
// mounts the real `DayActionsProvider` with `next/navigation`, `next/link` and
// `fetch` stubbed, and drives it with Playwright.
//
// A green run does NOT cover Cloudflare Access, real D1 data, the same-origin
// and content-type check in `authoriseStaffMutation`, or email delivery.
//
// Run with `npm run test:ui`. Needs a Chromium build: `npx playwright install
// chromium`, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE to one you already have.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const IPHONE = {
  viewport: { width: 402, height: 874 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  reducedMotion: "reduce",
};

/* ------------------------------------------------------------------ browser */

/**
 * Playwright's own resolution first, then any Chromium already on the machine.
 * Environments that preinstall browsers often do so outside Playwright's
 * default cache.
 */
async function launchChromium() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (explicit) return chromium.launch({ executablePath: explicit });
  try {
    return await chromium.launch();
  } catch (reason) {
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const candidate = root && fs.existsSync(root)
      ? fs.readdirSync(root)
          .filter((name) => name.startsWith("chromium-"))
          .map((name) => path.join(root, name, "chrome-linux", "chrome"))
          .find((file) => fs.existsSync(file))
      : undefined;
    if (candidate) return chromium.launch({ executablePath: candidate });
    console.error(
      "\nNo Chromium available. Run `npx playwright install chromium`, or set\n" +
        "PLAYWRIGHT_CHROMIUM_EXECUTABLE to an existing Chromium binary.\n",
    );
    throw reason;
  }
}

/* -------------------------------------------------------------------- setup */

const server = await createServer({
  configFile: path.join(here, "vite.config.mjs"),
  server: { port: 0 },
  logLevel: "warn",
});
await server.listen();
const base = server.resolvedUrls.local[0];

let browser;
try {
  browser = await launchChromium();
} catch (reason) {
  // Otherwise the dev server keeps the process alive after the failure.
  await server.close();
  throw reason;
}

const failures = [];

/** Each case gets a clean page, so state never leaks between them. */
async function withPage(name, run) {
  const context = await browser.newContext(IPHONE);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await run(page);
    assert.deepEqual(pageErrors, [], `${name} raised page errors`);
    console.log(`  ok  ${name}`);
  } catch (reason) {
    failures.push(`${name}: ${reason.message}`);
    console.log(`  FAIL  ${name}`);
  } finally {
    await context.close();
  }
}

const requests = (page) => page.evaluate(() => window.__harness.calls);
/** Scoped to the sheets' service, so the persistent panel's polling is excluded. */
const rankingRequests = (page, service = "haircut") =>
  page.evaluate((name) => window.__harness.rankingRequests(name), service);
const posts = async (page) => (await requests(page)).filter((call) => call.method === "POST");

async function openHarness(page, { clock = false } = {}) {
  if (clock) await page.clock.install();
  await page.goto(base, { waitUntil: clock ? "domcontentloaded" : "networkidle" });
  if (clock) await page.clock.runFor(500);
  await page.waitForTimeout(400);
}

/* -------------------------------------------------------------------- cases */

console.log("\nBackstage sheets");

await withPage("the harness lays out at phone width", async (page) => {
  await openHarness(page);
  assert.equal(
    await page.evaluate(() => window.innerWidth), 402,
    "the viewport meta is missing, so the phone media queries would not apply",
  );
  assert.equal(
    await page.evaluate(() => window.matchMedia("(min-width: 768px)").matches), false,
  );
});

await withPage("walk-in: the panel asks the protected endpoint", async (page) => {
  await openHarness(page);
  await page.click("#open-add");
  await page.waitForTimeout(700);

  const ranking = (await requests(page)).filter((call) =>
    call.url.startsWith("/api/admin/recommendations?service=haircut"),
  );
  assert.equal(ranking.length, 1, "exactly one ranking request on open");
  assert.equal(ranking[0].method, "GET");
  assert.equal(
    ranking[0].url,
    "/api/admin/recommendations?service=haircut&date=2026-09-22",
    "the selected service and the day on screen",
  );
});

await withPage("walk-in: the server's order and reason are rendered verbatim", async (page) => {
  await openHarness(page);
  await page.click("#open-add");
  await page.waitForTimeout(700);

  assert.deepEqual(
    await page.locator(".sheet .samaritan-staff-time b").allTextContents(),
    ["13:40", "10:45", "16:00"],
    "rendered in the order the server returned, not re-sorted",
  );
  assert.equal(
    await page.locator(".sheet .samaritan-staff-time .best").count(), 1,
    "only the top pick is marked best",
  );
  await page.locator(".sheet .samaritan-staff-time").first().waitFor();
  assert.equal(
    await page.locator(".sheet .samaritan-staff-time").first().locator(".best").count(), 1,
    "the best mark belongs to the first entry",
  );
  assert.equal(
    (await page.locator(".sheet .samaritan-staff-reason").textContent()).trim(),
    "Best fit for a 30-minute haircut. This time fills the space between two appointments without creating unused capacity.",
    "the explanation is the server's sentence, unedited",
  );
  assert.equal(
    await page.locator(".sheet .samaritan-staff-times").getByText("300").count(), 0,
    "the raw score is not shown",
  );
});

await withPage("walk-in: an off-grid pick is added to the grid and selected", async (page) => {
  await openHarness(page);
  await page.click("#open-add");
  await page.waitForTimeout(700);

  const before = await page.locator(".sheet .time-grid .time-cell").allTextContents();
  assert.equal(before.includes("13:40"), false, "13:40 is not a fifteen-minute step");

  await page.locator(".sheet .samaritan-staff-time").first().click();
  await page.waitForTimeout(300);

  const after = await page.locator(".sheet .time-grid .time-cell").allTextContents();
  assert.equal(after.includes("13:40"), true, "the picked time joins the grid");
  assert.equal(
    after.indexOf("13:40"), after.indexOf("13:30") + 1,
    "and sits in chronological order",
  );
  assert.equal(
    (await page.locator('.sheet .time-cell[aria-checked="true"]').textContent()).trim(),
    "13:40",
    "the picked time is the selected cell",
  );
  assert.match(
    (await page.locator(".sheet .btn-primary").textContent()).trim(),
    /Add walk-in · 13:40/,
  );
});

await withPage("walk-in: saving sends the operation and refreshes in place", async (page) => {
  await openHarness(page);
  await page.click("#open-add");
  await page.waitForTimeout(700);
  await page.locator(".sheet .samaritan-staff-time").first().click();
  await page.waitForTimeout(200);
  await page.locator(".sheet .btn-primary").click();
  await page.waitForTimeout(800);

  const [sent, ...rest] = await posts(page);
  assert.deepEqual(rest, [], "one request per save");
  assert.equal(sent.url, "/api/admin/operations");
  assert.equal(sent.body.action, "walk_in");
  assert.equal(sent.body.date, "2026-09-22");
  assert.equal(sent.body.time, "13:40");
  assert.equal(sent.body.serviceId, "haircut");
  assert.match(
    sent.body.id,
    /^[0-9a-f-]{36}$/,
    "an idempotency key, so a retry cannot double-book",
  );

  assert.match((await page.locator(".toast").textContent()).trim(), /Walk-in added · 13:40/);
  assert.equal(await page.locator(".sheet").count(), 0, "the sheet closes");
  assert.equal(
    await page.evaluate(() => window.__refreshes ?? 0), 1,
    "the day is refreshed in place rather than reloaded",
  );
});

await withPage("re-opening after a mutation shows the new ranking, never a stale one", async (page) => {
  await openHarness(page);
  await page.click("#open-add");
  await page.waitForTimeout(700);
  await page.locator(".sheet .samaritan-staff-time").first().click();
  await page.waitForTimeout(200);
  await page.locator(".sheet .btn-primary").click();
  await page.waitForTimeout(800);

  const before = await rankingRequests(page);
  await page.click("#open-add");
  await page.waitForTimeout(700);

  assert.equal(await rankingRequests(page) - before, 1, "the ranking is asked again");
  assert.deepEqual(
    await page.locator(".sheet .samaritan-staff-time b").allTextContents(),
    ["15:00"],
    "and the new ranking is what is shown",
  );
});

await withPage("the ranking refreshes every thirty seconds", async (page) => {
  await openHarness(page, { clock: true });
  await page.click("#open-add");
  await page.clock.runFor(100);
  await page.waitForTimeout(700);

  const opened = await rankingRequests(page);
  assert.equal(opened, 1);

  await page.clock.runFor(25_000);
  await page.waitForTimeout(400);
  assert.equal(await rankingRequests(page), 1, "nothing before thirty seconds");

  await page.clock.runFor(6_000);
  await page.waitForTimeout(500);
  assert.equal(await rankingRequests(page), 2, "one refresh at thirty seconds");

  await page.clock.runFor(30_000);
  await page.waitForTimeout(500);
  assert.equal(await rankingRequests(page), 3, "and again at sixty");
});

await withPage("the ranking refreshes on focus and on becoming visible", async (page) => {
  await openHarness(page, { clock: true });
  await page.click("#open-add");
  await page.clock.runFor(100);
  await page.waitForTimeout(700);

  const opened = await rankingRequests(page);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(500);
  assert.equal(await rankingRequests(page) - opened, 1, "focus refreshes");

  const focused = await rankingRequests(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(35_000);
  await page.waitForTimeout(400);
  assert.equal(
    await rankingRequests(page), focused,
    "polling pauses while the tab is hidden",
  );

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(600);
  assert.equal(
    await rankingRequests(page) - focused, 1,
    "coming back refreshes once",
  );
});

await withPage("reschedule: the ranking follows the booking's own service", async (page) => {
  await openHarness(page);
  await page.click("#open-appointment");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Reschedule" }).click();
  await page.waitForTimeout(800);

  const urls = (await requests(page)).map((call) => call.url);
  assert.ok(
    urls.includes("/api/admin/recommendations?service=haircut&date=2026-09-22"),
    "ranked for the service on the booking, not the last one picked elsewhere",
  );
  assert.ok(
    urls.some((url) =>
      url.startsWith(
        "/api/admin/bookings/availability?reference=AS-20260922-A2BB&date=2026-09-22",
      ),
    ),
    "the grid still asks the endpoint that knows about this booking's own slots",
  );

  await page.locator(".sheet .samaritan-staff-time").first().click();
  await page.waitForTimeout(300);
  assert.equal(
    (await page.locator('.sheet .time-cell[aria-checked="true"]').textContent()).trim(),
    "13:40",
  );
});

await withPage("reschedule: nothing is sent until the move is confirmed", async (page) => {
  await openHarness(page);
  await page.click("#open-appointment");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Reschedule" }).click();
  await page.waitForTimeout(800);
  await page.locator(".sheet .samaritan-staff-time").first().click();
  await page.waitForTimeout(200);
  await page.locator(".sheet .btn-primary").click();
  await page.waitForTimeout(400);

  assert.equal((await page.locator(".dialog h2").textContent()).trim(), "Move booking?");
  assert.deepEqual(await posts(page), [], "the confirmation gates the request");

  await page.getByRole("button", { name: "Move booking" }).click();
  await page.waitForTimeout(800);

  const [sent] = await posts(page);
  assert.equal(sent.url, "/api/admin/bookings/change");
  assert.deepEqual(sent.body, {
    reference: "AS-20260922-A2BB",
    revision: 0,
    action: "reschedule",
    date: "2026-09-22",
    time: "13:40",
  }, "the revision travels with the change so a stale edit is rejected");
  assert.match((await page.locator(".toast").textContent()).trim(), /Booking moved/);
});

await withPage("keeping a booking unchanged sends nothing", async (page) => {
  await openHarness(page);
  await page.click("#open-appointment");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await page.waitForTimeout(400);

  assert.equal((await page.locator(".dialog h2").textContent()).trim(), "Cancel booking?");
  assert.match(
    await page.locator(".dialog p").first().textContent(),
    /release 11:30–12:00/,
    "the dialog says exactly what is released",
  );

  await page.getByRole("button", { name: "Keep unchanged" }).click();
  await page.waitForTimeout(400);
  assert.deepEqual(await posts(page), []);
  assert.equal(await page.locator(".dialog").count(), 0, "the dialog closes");
});

await withPage("recording a payment is confirmed and states the amount", async (page) => {
  await openHarness(page);
  await page.click("#open-appointment");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Cash" }).click();
  await page.waitForTimeout(400);

  assert.equal((await page.locator(".dialog h2").textContent()).trim(), "Cash received?");
  assert.match(
    await page.locator(".dialog p").first().textContent(),
    /€35/,
    "the barber confirms a number, not a vague action",
  );

  await page.getByRole("button", { name: "Confirm cash" }).click();
  await page.waitForTimeout(800);

  const [sent] = await posts(page);
  assert.equal(sent.url, "/api/admin/operations");
  assert.equal(sent.body.action, "payment");
  assert.equal(sent.body.method, "cash");
  assert.equal(sent.body.revision, 0);
  assert.equal(sent.body.reference, "AS-20260922-A2BB");
});

await withPage("a failed email is surfaced, not swallowed", async (page) => {
  await openHarness(page);
  await page.evaluate(() => window.__harness.setNotificationsSent(false));
  await page.click("#open-appointment");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Cancel booking" }).nth(1).click();
  await page.waitForTimeout(800);

  const toast = (await page.locator(".toast").textContent()).trim();
  assert.match(toast, /email did not go out/i, "staff are told to contact the customer");
  assert.equal(
    await page.locator(".toast.is-error").count(), 1,
    "and it is shown as a problem, not a success",
  );
});

await withPage("bumping the revision refetches a panel that stays mounted", async (page) => {
  await openHarness(page, { clock: true });

  // Inside a sheet every mutation closes the sheet, so the panel remounts and
  // would refetch regardless. This exercises the bump on its own.
  const persistent = page.locator("#persistent");
  await persistent.locator(".samaritan-staff-time b").first().waitFor();
  const before = await rankingRequests(page, "line-up");
  assert.equal(before, 1);
  assert.deepEqual(
    await persistent.locator(".samaritan-staff-time b").allTextContents(),
    ["13:40", "10:45", "16:00"],
  );

  // A different answer is waiting; without a refetch the panel keeps the old one.
  await page.evaluate(() =>
    window.__harness.setRanking([
      { date: "2026-09-22", time: "09:55", score: 300, reason: "Changed after the bump." },
    ]),
  );
  await page.waitForTimeout(300);
  assert.deepEqual(
    await persistent.locator(".samaritan-staff-time b").allTextContents(),
    ["13:40", "10:45", "16:00"],
    "nothing is refetched until something asks for it",
  );

  await page.click("#bump-revision");
  await page.waitForTimeout(600);

  assert.equal(
    await rankingRequests(page, "line-up") - before, 1,
    "the bump refetches without a remount",
  );
  assert.deepEqual(
    await persistent.locator(".samaritan-staff-time b").allTextContents(),
    ["09:55"],
    "and the panel shows the new answer",
  );
});

/* ----------------------------------------------------------------- teardown */

await browser.close();
await server.close();

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  "\nPASS: Backstage sheets — ranking rendered as served, off-grid picks selectable, " +
    "30s/focus/visibility refresh, mutations re-rank, and destructive actions gated\n",
);
