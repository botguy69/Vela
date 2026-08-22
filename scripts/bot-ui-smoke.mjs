#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.APP_URL || "http://127.0.0.1:8080";
const outDir = "/workspace/screenshots";
mkdirSync(outDir, { recursive: true });

const email = `desk${Date.now()}@example.com`;
const password = "vela-desk-99";
const fails = [];
const log = [];
const note = (msg) => {
  log.push(msg);
  console.log(msg);
};

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(30000);

try {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${outDir}/bot-landing.png`, fullPage: true });
  const home = await page.locator("body").innerText();
  note(`home: ${home.slice(0, 80).replace(/\s+/g, " ")}`);

  const onAuto = (await page.getByRole("button", { name: /tick now/i }).count()) > 0;
  if (!onAuto) {
    const open = page.getByRole("link", { name: /open the bot|open auto|sign in/i }).first();
    if (await open.count()) await open.click();
    else await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole("button", { name: /create desk/i }).click();
    await page.waitForTimeout(2500);
    if (page.url().includes("/login")) {
      const err = (await page.locator("body").innerText()).match(/invalid|failed|error|small/i);
      fails.push(`signup stuck on login ${err?.[0] ?? ""}`);
      await page.screenshot({ path: `${outDir}/bot-after-signup.png`, fullPage: true });
    } else {
      note("signed up");
    }
  } else {
    note("already on auto desk");
  }

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" }).catch(() => null);
  await page.waitForTimeout(800);
  if (!(await page.getByRole("button", { name: /tick now/i }).count())) {
    await page.goto(`${BASE}/auto`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
  }
  await page.screenshot({ path: `${outDir}/bot-after-signup.png`, fullPage: true });

  const toastText = async () =>
    (await page.locator("[data-sonner-toast], [data-sonner-toaster]").allInnerTexts()).join(" | ");

  if (await page.getByRole("button", { name: /tick now/i }).count()) {
    await page.getByRole("button", { name: /tick now/i }).click();
    await page.waitForTimeout(4000);
    note(`tick toast: ${await toastText()}`);

    const arm = page.getByRole("button", { name: /arm live|kill switch/i });
    if (await arm.count()) {
      await arm.click();
      await page.waitForTimeout(1500);
      note(`arm toast: ${await toastText()}`);
    }

    const ka = page.getByRole("button", { name: /turn 24\/7|24\/7 on/i });
    if (await ka.count()) {
      await ka.click();
      await page.waitForTimeout(1500);
      note(`24/7 toast: ${await toastText()}`);
    }

    await page.getByLabel(/^api key$/i).fill("test-key");
    await page.getByLabel(/^secret$/i).fill("test-secret");
    await page.getByLabel(/^passphrase$/i).fill("test-pass");
    await page.getByRole("button", { name: /store keys/i }).click();
    await page.waitForTimeout(4000);
    note(`keys toast: ${await toastText()}`);

    const review = page.getByRole("button", { name: /review open tickets/i });
    if (await review.count()) {
      await review.click();
      await page.waitForTimeout(2500);
      note(`review toast: ${await toastText()}`);
    }

    await page.screenshot({ path: `${outDir}/bot-desk-actions.png`, fullPage: true });
  } else {
    fails.push("auto desk buttons not found");
    await page.screenshot({ path: `${outDir}/bot-desk-actions.png`, fullPage: true });
  }

  await page.goto(`${BASE}/alive`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const alive = await page.locator("body").innerText();
  await page.screenshot({ path: `${outDir}/bot-alive.png`, fullPage: true });
  if (/fail 500/i.test(alive)) fails.push("alive fail 500");
  else note(`alive: ${alive.replace(/\s+/g, " ").slice(0, 120)}`);

  const cron = await page.request.get(`${BASE}/api/cron/tick`);
  const cj = await cron.json();
  if (cron.status() !== 200) fails.push(`cron ${cron.status()}`);
  else note(`cron ${JSON.stringify(cj).slice(0, 160)}`);
} catch (err) {
  fails.push(String(err?.message || err));
  await page.screenshot({ path: `${outDir}/bot-crash.png`, fullPage: true }).catch(() => null);
} finally {
  await browser.close();
}

writeFileSync(`${outDir}/bot-ui-log.txt`, `${log.join("\n")}\n\nFAILS:\n${fails.join("\n")}\n`);
console.log(fails.length ? `UI FAILS:\n${fails.join("\n")}` : "UI smoke passed");
process.exit(fails.length ? 1 : 0);
