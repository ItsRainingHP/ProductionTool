/** Local tour lifecycle, real output workflows, accessibility, and screenshots. */
import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const key = "production-tool.onboarding.v1";
const evidence = path.resolve(__dirname, "../../artifacts/onboarding-tour");
const rfp = path.resolve(__dirname, "../../examples/reference-sanitized/logikcull/pleading/valid/lc_reference_pleading_001.csv");
const privilege = path.resolve(__dirname, "../../examples/generated/everlaw/privilege/valid/ew_privilege_001_minimal_canonical.csv");

async function assertCardFits(page: Page) {
  const card = page.locator(".tour-card");
  await expect(card).toBeVisible();
  await expect.poll(async () => {
    const rect = await card.boundingBox();
    const size = page.viewportSize()!;
    return Boolean(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= size.width + 1 && rect.y + rect.height <= size.height + 1);
  }).toBe(true);
  await expect(page.locator(".react-joyride__spotlight path").nth(1)).toHaveCSS("opacity", "0");
  await expect(page.locator(".react-joyride__arrow")).toHaveCSS("visibility", "visible");
}

async function finishChapter(page: Page, label: string) {
  const card = page.locator(".tour-card");
  await expect(card.locator(".tour-eyebrow")).toContainText(label);
  for (let count = 0; count < 6; count++) {
    await assertCardFits(page);
    const next = card.getByRole("button", { name: "Next tip", exact: true });
    if (await next.count()) {
      const before = await card.locator("h2").textContent();
      await next.click();
      await expect(card.locator("h2")).not.toHaveText(before!);
    } else {
      await card.getByRole("button", { name: "Got it", exact: true }).click();
      await expect(card).toHaveCount(0);
      return;
    }
  }
  throw new Error("Tour failed to finish its short chapter");
}

async function acknowledgeWarnings(page: Page) {
  for (const checkbox of await page.getByRole("checkbox", { name: "I understand how this issue affects the output" }).all()) await checkbox.check();
}

test("first job, unseen workflow, local-only requests, and four tour screenshots", async ({ page, request }) => {
  test.setTimeout(180_000);
  await mkdir(evidence, { recursive: true });
  const externalRequests: string[] = [];
  const errors: string[] = [];
  page.on("request", (req) => { if (new URL(req.url()).origin !== new URL(test.info().project.use.baseURL!).origin) externalRequests.push(req.url()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Start Processing", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Help and guided tour" })).toHaveCount(0);
  await page.screenshot({ path: path.join(evidence, "00-home-desktop.png"), animations: "disabled" });
  await page.getByRole("link", { name: "Start Processing", exact: true }).click();
  await expect(page).toHaveURL(/\/wizard$/);
  await expect(page.getByRole("dialog", { name: "Welcome to the Production Tool" })).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "01-welcome-desktop.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Start tour", exact: true }).click();
  await assertCardFits(page);
  await page.locator(".tour-card").getByRole("button", { name: "Next tip", exact: true }).click();
  await expect(page.locator(".tour-card h2")).toHaveText("Start with your CSV");
  await assertCardFits(page);
  await page.screenshot({ path: path.join(evidence, "02-upload-desktop.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  await page.getByLabel("Upload source CSV").setInputFiles(rfp);
  await expect(page).toHaveURL(/\/data$/);
  await finishChapter(page, "Data");
  await page.getByRole("radio", { name: /RFP \/ Pleading Ranges/ }).click();
  await page.getByRole("button", { name: /^Continue/ }).click();
  await expect(page).toHaveURL(/\/advanced$/);
  await finishChapter(page, "Pleading ranges");
  await page.getByRole("button", { name: "Help and guided tour" }).click();
  await page.getByRole("button", { name: "Explain text formatting" }).click();
  await finishChapter(page, "Text formatting");
  await acknowledgeWarnings(page);
  await page.getByRole("button", { name: "Review output", exact: true }).click();
  await expect(page).toHaveURL(/\/review$/);
  await finishChapter(page, "Review");
  await page.getByRole("button", { name: /^Finalize/ }).click();
  await expect(page).toHaveURL(/\/download$/);
  await finishChapter(page, "Download");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download text file", exact: true }).click();
  const downloaded = await downloadEvent;
  expect(await readFile((await downloaded.path())!, "utf8")).toContain("SYNREFLCPLD001-0000001, SYNREFLCPLD001-0000005-6");
  const jobId = new URL(page.url()).pathname.split("/")[2];
  expect((await request.get(`/api/v1/jobs/${jobId}/receipt.json`)).status()).toBe(200);
  await page.getByRole("button", { name: "Process another CSV", exact: true }).click();
  await expect(page).toHaveURL(/\/wizard$/);
  await expect(page.locator(".tour-card")).toHaveCount(0);
  await page.getByLabel("Upload source CSV").setInputFiles(privilege);
  await expect(page).toHaveURL(/\/data$/);
  await expect(page.locator(".tour-card")).toHaveCount(0);
  await page.getByRole("radio", { name: /Privilege Log/ }).click();
  await page.getByRole("button", { name: /^Continue/ }).click();
  await expect(page).toHaveURL(/\/advanced$/);
  await finishChapter(page, "Privilege mapping");
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await page.getByRole("button", { name: "Help and guided tour" }).click();
  await page.getByRole("button", { name: "Explain mapping options" }).click();
  await assertCardFits(page);
  await page.screenshot({ path: path.join(evidence, "03-mapping-desktop-dark.png"), animations: "disabled" });
  await finishChapter(page, "Mapping options");
  await acknowledgeWarnings(page);
  await page.getByRole("button", { name: "Review output", exact: true }).click();
  await expect(page).toHaveURL(/\/review$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await page.getByRole("button", { name: "Help and guided tour" }).click();
  await page.getByRole("button", { name: "Replay this screen" }).click();
  await page.getByRole("button", { name: "Next tip", exact: true }).click();
  await expect(page.locator(".tour-card h2")).toHaveText("Inspect the sample");
  await assertCardFits(page);
  await page.screenshot({ path: path.join(evidence, "04-review-mobile.png"), animations: "disabled" });
  await finishChapter(page, "Review");
  await page.getByRole("button", { name: /^Finalize/ }).click();
  await expect(page).toHaveURL(/\/download$/);
  await expect(page.getByRole("link", { name: "Download CSV", exact: true })).toBeVisible();
  const csvEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download CSV", exact: true }).click();
  expect(await readFile((await (await csvEvent).path())!, "utf8")).toContain("Bates Range,Privilege");
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("keyboard pause, reload/resume, replay, target interaction, and 320px layout", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.goto("/wizard");
  await page.getByRole("button", { name: "Start tour", exact: true }).click();
  await assertCardFits(page);
  await page.keyboard.press("Tab");
  expect(await page.locator(".tour-card").evaluate((element) => element.contains(document.activeElement))).toBe(true);
  expect(await page.locator("main").evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  await page.getByRole("button", { name: "Next tip", exact: true }).click();
  await expect(page.locator(".tour-card h2")).toHaveText("Start with your CSV");
  await page.keyboard.press("Escape");
  await expect(page.locator(".tour-card")).toHaveCount(0);
  expect(await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)!).preference, key)).toBe("paused");
  expect(await page.locator("main").evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "Help and guided tour" }).click();
  await page.getByRole("button", { name: "Resume tour", exact: true }).click();
  await expect(page.locator(".tour-card h2")).toHaveText("Start with your CSV");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".tour-card h2")).toHaveText("Welcome to the Production Tool");
  await finishChapter(page, "Upload");
  await page.reload();
  await expect(page.locator(".tour-card")).toHaveCount(0);
});

test("missing targets release the overlay and pause instead of completing", async ({ page }) => {
  await page.goto("/wizard");
  await page.getByRole("button", { name: "Start tour", exact: true }).click();
  await expect(page.locator(".tour-card")).toBeVisible();
  await page.locator('[data-tour="upload-csv"]').evaluate((element) => element.removeAttribute("data-tour"));
  await page.getByRole("button", { name: "Next tip", exact: true }).click();
  await expect.poll(async () => page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)!).preference, key)).toBe("paused");
  await expect(page.locator(".tour-card")).toHaveCount(0);
  expect(await page.locator("main").evaluate((element) => (element as HTMLElement).inert)).toBe(false);
});

test("two browser tabs share pause without interrupting saved work", async ({ page, context }) => {
  await page.goto("/wizard");
  await page.getByRole("button", { name: "Start tour", exact: true }).click();
  await expect(page.locator(".tour-card")).toBeVisible();
  const other = await context.newPage();
  await other.goto("/wizard");
  await expect(other.locator(".tour-card")).toBeVisible();
  await other.getByRole("button", { name: "Pause tour", exact: true }).click();
  await expect(page.locator(".tour-card")).toHaveCount(0);
  await other.close();
});

for (const scenario of [
  { name: "blocking errors", source: "generated/everlaw/pleading/invalid/ew_pleading_018_missing_begin_bates_column.csv", title: "Try a corrected export" },
  { name: "personal-data advisories", source: "generated/everlaw/privilege/valid/ew_privilege_feature_personal_data_normalization.csv", title: "Advisories are a separate check" },
]) {
  test(`Data tour explains ${scenario.name} without altering validation`, async ({ page }) => {
    await page.addInitScript((storageKey) => localStorage.setItem(storageKey, JSON.stringify({ schemaVersion: 1, preference: "enabled", chapters: { upload: { completed: true, nextTipId: null } } })), key);
    await page.goto("/wizard");
    await page.getByLabel("Upload source CSV").setInputFiles(path.resolve(__dirname, "../../examples", scenario.source));
    await expect(page).toHaveURL(/\/data$/);
    for (let step = 0; step < 4; step++) {
      await assertCardFits(page);
      if (await page.locator(".tour-card h2").textContent() === scenario.title) break;
      await page.getByRole("button", { name: "Next tip", exact: true }).click();
    }
    await expect(page.locator(".tour-card h2")).toHaveText(scenario.title);
    await finishChapter(page, "Data");
    if (scenario.name === "blocking errors") {
      await expect(page.getByRole("button", { name: "Choose another CSV", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Continue/ })).toHaveCount(0);
    } else {
      await expect(page.getByText("This notice does not change the source CSV or prevent you from continuing.", { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Continue/ })).toBeEnabled();
    }
  });
}
