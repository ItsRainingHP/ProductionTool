/**
 * @file Browser smoke tests against the combined production container.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const fixtures = path.resolve(__dirname, "../../examples");

async function upload(page: Page, relativePath: string) {
  await page.goto("/wizard");
  await page.locator('input[type="file"]').setInputFiles(path.join(fixtures, relativePath));
}

async function downloadText(page: Page, buttonName: RegExp): Promise<string> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: buttonName }).click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  if (!downloadedPath) throw new Error("The browser did not retain the downloaded file");
  return readFile(downloadedPath, "utf8");
}

test("home page starts processing", async ({ page }) => {
  await page.goto("/");
  const start = page.getByRole("link", { name: "Start Processing" });
  await expect(start).toHaveAttribute("href", "/wizard");
  await start.click();
  await expect(page.getByRole("heading", { name: "Upload CSV data" })).toBeVisible();
});

test("pleading wizard produces the expected text download", async ({ page }) => {
  await upload(page, "reference-sanitized/logikcull/pleading/valid/lc_reference_pleading_001.csv");
  await expect(page.getByRole("heading", { name: "Choose the output" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Inspect pleading ranges" })).toBeVisible();
  await page.getByRole("button", { name: "Review output" }).click();
  await expect(page.getByRole("heading", { name: "Review your output" })).toBeVisible();
  await page.getByRole("button", { name: "Finalize text file" }).click();
  await expect(page.getByRole("heading", { name: "Your text file is ready" })).toBeVisible();
  const text = await downloadText(page, /Download text file/);
  expect(text).toContain("RFP 01\r\n");
  expect(text).toContain("SYNREFLCPLD001-0000001, SYNREFLCPLD001-0000005-0006");
});

test("privilege wizard produces a spreadsheet-safe CSV", async ({ page }) => {
  await upload(page, "reference-sanitized/logikcull/privilege/valid/lc_reference_privilege_001.csv");
  await expect(page.getByRole("heading", { name: "Choose the output" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Build privilege output" })).toBeVisible();
  await page.getByRole("button", { name: "Review output" }).click();
  await expect(page.getByRole("heading", { name: "Review your output" })).toBeVisible();
  await page.getByRole("button", { name: "Finalize CSV" }).click();
  await expect(page.getByRole("heading", { name: "Your CSV is ready" })).toBeVisible();
  const text = await downloadText(page, /Download CSV/);
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text).toContain("Bates Range");
  expect(text).toContain("SYNREFLCPRV001-0000001");
});

test("blocking CSV cannot advance beyond validation", async ({ page }) => {
  await upload(page, "generated/everlaw/pleading/invalid/ew_pleading_018_missing_begin_bates_column.csv");
  await expect(page.getByRole("heading", { name: "Review CSV problems" })).toBeVisible();
  await expect(page.getByText("This CSV was analyzed, but it cannot be processed safely.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose another CSV" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue/ })).toHaveCount(0);
});

for (const fixture of [
  "generated/everlaw/privilege/valid/ew_privilege_015_high_volume.csv",
  "generated/everlaw/privilege/valid/ew_privilege_014_wide_high_volume.csv",
]) {
  test(`shows Step 1 progress while processing ${path.basename(fixture)}`, async ({ page }) => {
    await page.goto("/wizard");
    await page.evaluate(() => {
      const state = window as typeof window & { __uploadHeadings?: string[]; __uploadSampler?: number };
      state.__uploadHeadings = [];
      state.__uploadSampler = window.setInterval(() => {
        const heading = document.querySelector("h1")?.textContent?.trim();
        if (heading && state.__uploadHeadings?.at(-1) !== heading) state.__uploadHeadings?.push(heading);
      }, 10);
    });
    await page.locator('input[type="file"]').setInputFiles(path.join(fixtures, fixture));

    await expect(page.getByRole("progressbar")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("heading", { name: /Uploading CSV data|Analyzing CSV data/ })).toBeVisible();
    await expect(page.getByRole("status")).toContainText(/transferred|Uploading CSV|Analyzing CSV/);
    await expect(page).toHaveURL(/\/data$/, { timeout: 120_000 });
    await expect(page.getByText("STEP 2 OF 5")).toBeVisible();
    const headings = await page.evaluate(() => {
      const state = window as typeof window & { __uploadHeadings?: string[]; __uploadSampler?: number };
      if (state.__uploadSampler) window.clearInterval(state.__uploadSampler);
      return state.__uploadHeadings ?? [];
    });
    const progressIndex = headings.findIndex((heading) => /Uploading CSV data|Analyzing CSV data/.test(heading));
    expect(progressIndex).toBeGreaterThanOrEqual(0);
    expect(headings.slice(progressIndex + 1)).not.toContain("Upload CSV data");
  });
}
