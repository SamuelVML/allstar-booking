// Run against the built local Worker after applying 0005 locally.
// TEST_BASE_URL may point only at the existing All Star TEST Worker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:8787';
assert.ok(['127.0.0.1', 'localhost', 'allstar-booking-test.samuel-731.workers.dev'].includes(new URL(base).hostname), 'Refuse subscriber tests outside local/TEST');
const output = process.env.QA_OUTPUT_DIR ?? '/tmp/allstar-launch-qa';
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const run = Date.now();
try {
  console.log(`Subscriber test run: ${run}`);
  const valid = { name: 'Codex TEST API verification', email: `codex-launch-${run}-api@example.com`, consent: true };
  const post = body => fetch(`${base}/api/launch-list`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  for (const body of ['{', { ...valid, email: 'broken@' }, { ...valid, consent: false }, { ...valid, consent: undefined }, { ...valid, name: ' ' }]) {
    assert.equal((await post(body)).status, 400);
  }
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => post(valid)));
  assert.equal(concurrent.filter(response => response.status === 201).length, 1);
  assert.equal(concurrent.filter(response => response.status === 200).length, 4);
  console.log('PASS HTTP API: malformed JSON/email, blank name, false/missing consent, concurrent normalized duplicate handling');
  for (const [device, width, height] of [['desktop', 1440, 900], ['ipad', 820, 1180], ['iphone', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: device !== 'desktop' });
    page.setDefaultTimeout(15000);
    console.log(`Checking ${device}`);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    assert.equal((await page.goto(base)).status(), 200);
    assert.match(await page.title(), /All Star/);
    assert.ok(await page.locator('h1').innerText());
    assert.equal(await page.locator('a[href*="all-star-barbershop.com/academy"]').count(), 0);
    await page.getByRole('button', { name: 'Join the launch list', exact: true }).click();
    const form = page.getByRole('form', { name: 'Mobile Barber launch list', exact: true });
    const name = form.getByLabel('Name', { exact: true });
    const email = form.getByLabel('Email', { exact: true });
    const consent = form.getByRole('checkbox');
    const submit = form.getByRole('button', { name: 'Subscribe', exact: true });
    assert.ok(await name.evaluate(el => el === document.activeElement));
    assert.equal(await consent.isChecked(), false);
    await submit.click();
    assert.equal(await name.evaluate(el => el.validity.valueMissing), true);
    await name.fill('Codex TEST launch verification');
    await email.fill('broken@');
    assert.equal(await email.evaluate(el => el.validity.valid), false);
    await email.fill(`codex-launch-${run}-${device}@example.com`);
    await submit.click();
    assert.equal(await consent.evaluate(el => el.validity.valueMissing), true);
    await consent.focus();
    await page.keyboard.press('Space');
    await submit.click();
    await form.getByRole('status').filter({ hasText: "You're on the launch list" }).waitFor();
    await submit.click();
    await form.getByRole('status').filter({ hasText: 'already on the launch list' }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await form.screenshot({ path: `${output}/${device}-launch.png` });
    await page.getByRole('link', { name: 'Explore the Academy', exact: true }).click();
    await page.waitForURL(`${base}/academy`);
    await page.getByRole('heading', { name: 'Learn the craft.' }).waitFor();
    assert.equal(await page.locator('.academy-program').count(), 4);
    assert.ok(await page.locator('.academy-hero img').evaluate(el => el.complete && el.naturalWidth > 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/${device}-academy.png`, fullPage: true });
    assert.match(await page.getByRole('link', { name: 'Academy enquiry' }).getAttribute('href'), /^mailto:info@all-star-barbershop.com\?subject=/);
    for (const target of await page.locator('.academy-page .btn, .academy-page .brand').all()) {
      const box = await target.boundingBox();
      assert.ok(box.height >= 44, 'Academy touch targets >=44px');
    }
    await page.getByRole('link', { name: 'Back to All Star', exact: true }).click();
    await page.waitForURL(`${base}/`);
    await page.locator('.lang-toggle').click();
    await page.locator('a[href="/academy?lang=nl"]').click();
    await page.waitForURL(`${base}/academy?lang=nl`);
    await page.getByRole('heading', { name: 'Leer het vak.' }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('link', { name: 'Terug naar All Star', exact: true }).click();
    await page.waitForURL(`${base}/?lang=nl`);
    await page.getByRole('button', { name: 'Zet me op de lanceerlijst', exact: true }).waitFor();
    const booking = page.locator('a[href^="/book"]').first();
    await booking.click();
    await page.waitForURL(/\/book/);
    assert.ok((await page.locator('body').innerText()).length > 100);
    assert.deepEqual(errors, [], 'No browser runtime/console errors');
    console.log(`PASS ${device} ${width}x${height}: signup, duplicate, validation, keyboard consent, Academy EN/NL, return language, booking navigation, layout, console`);
    await page.close();
  }
  const page = await browser.newPage();
  await page.goto(base);
  await page.getByRole('button', { name: 'Join the launch list', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Test Subscriber');
  await page.getByLabel('Email', { exact: true }).fill('codex-ui-mocked@example.com');
  await page.getByRole('checkbox').check();
  let release;
  let requests = 0;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/launch-list', async route => {
    requests++;
    await pending;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
  });
  await page.getByRole('button', { name: 'Subscribe', exact: true }).click();
  await page.getByRole('button', { name: 'Subscribing…', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Subscribing…', exact: true }).isDisabled(), true);
  await page.getByLabel('Email', { exact: true }).press('Enter');
  release();
  await page.getByRole('status').filter({ hasText: 'temporarily unavailable' }).waitFor();
  assert.equal(requests, 1);
  assert.equal(await page.getByRole('button', { name: 'Subscribe', exact: true }).isEnabled(), true);
  await page.screenshot({ path: `${output}/launch-error.png` });
  console.log('PASS: loading/disabled, repeated submission guard, recoverable error state (mocked failure)');
} finally {
  await browser.close();
}
