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

test("production route accepts a CSV larger than Next's former 10 MB limit", async ({ request }) => {
  test.setTimeout(120_000);
  const created = await request.post("/api/v1/jobs");
  expect(created.status()).toBe(201);
  const { job_id: jobId } = await created.json();
  const csv = Buffer.from(
    'Begin Bates,End Bates,Tag: RFP 01,Notes\nABC0001,ABC0002,TRUE,"'
    + "x".repeat(11 * 1024 * 1024) + '"\n',
  );
  const uploaded = await request.put(`/api/v1/jobs/${jobId}/source`, {
    data: csv,
    headers: { "Content-Type": "text/csv", "X-File-Name": "large.csv" },
    timeout: 60_000,
  });
  expect(uploaded.status()).toBe(202);
  await expect.poll(async () => {
    const result = await request.get(`/api/v1/jobs/${jobId}`);
    return (await result.json()).status;
  }, { timeout: 90_000 }).toBe("needs_configuration");
  await request.delete(`/api/v1/jobs/${jobId}`);
});

test("pleading wizard produces the expected text download and receipt identity", async ({ page, request }) => {
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
  expect(text).toContain("SYNREFLCPLD001-0000001, SYNREFLCPLD001-0000005-6");
  const jobId = new URL(page.url()).pathname.split("/")[2];
  const receiptResponse = await request.get(`/api/v1/jobs/${jobId}/receipt.json`);
  expect(receiptResponse.status()).toBe(200);
  const receipt = await receiptResponse.json();
  expect(receipt.image_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  if (process.env.EXPECTED_IMAGE_DIGEST) {
    expect(receipt.image_digest).toBe(process.env.EXPECTED_IMAGE_DIGEST);
  }
});

test("Advanced draft survives browser Back, Forward, and refresh in one tab", async ({ page }) => {
  await upload(page, "reference-sanitized/logikcull/pleading/valid/lc_reference_pleading_001.csv");
  await expect(page.getByRole("heading", { name: "Choose the output" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Inspect pleading ranges" })).toBeVisible();
  await page.getByRole("button", { name: "Semicolon" }).click();
  await expect(page.getByRole("button", { name: "Semicolon" })).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Choose the output" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("button", { name: "Semicolon" })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: "Semicolon" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page.getByRole("button", { name: "Comma" })).toHaveAttribute("aria-pressed", "true");
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

for (const enabled of [true, false]) {
  test(`Logikcull TRUE replacement ${enabled ? "enabled" : "disabled"} persists through review and download`, async ({ page, request }) => {
    await page.goto("/wizard");
    await page.locator('input[type="file"]').setInputFiles({
      name: "synthetic-true-markers.csv", mimeType: "text/csv",
      buffer: Buffer.from(
        "Bates/Control #,End Bates/Control #,Tag: Attorney Client,Tag: Work Product\n"
        + "EXAMPLE_000001,EXAMPLE_000092,Contains a TRUE marker,(TrUe)\n"
        + "EXAMPLE_000093,EXAMPLE_001596,TRUETYPE,FALSE\n",
      ),
    });
    await page.getByRole("button", { name: "Continue" }).click();
    const checkbox = page.getByRole("checkbox", { name: "Replace cells containing TRUE with column headings" });
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Choose the output" })).toBeVisible();
    await page.goForward();
    await expect(checkbox).not.toBeChecked();
    await page.reload();
    await expect(checkbox).not.toBeChecked();
    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(checkbox).toBeChecked();
    if (!enabled) await checkbox.uncheck();
    await page.getByRole("button", { name: "Review output" }).click();
    await expect(page.getByRole("heading", { name: "Review your output" })).toBeVisible();
    await expect(page.getByRole("cell", { name: enabled ? "Attorney Client" : "Contains a TRUE marker", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Previous" }).click();
    await expect(checkbox).toBeChecked({ checked: enabled });
    await page.reload();
    await expect(checkbox).toBeChecked({ checked: enabled });
    await page.getByRole("button", { name: "Review output" }).click();
    await page.getByRole("button", { name: "Finalize CSV" }).click();
    const text = await downloadText(page, /Download CSV/);
    expect(text).toContain(enabled
      ? "EXAMPLE_000001-92,Attorney Client,Work Product"
      : "EXAMPLE_000001-92,Contains a TRUE marker,(TrUe)");
    expect(text).toContain("EXAMPLE_000093-1596,TRUETYPE,FALSE");
    const jobId = new URL(page.url()).pathname.split("/")[2];
    const receipt = await request.get(`/api/v1/jobs/${jobId}/receipt.json`);
    expect((await receipt.json()).mapping.replace_true_with_header).toBe(enabled);
    await request.delete(`/api/v1/jobs/${jobId}`);
  });
}

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
