/**
 * @file Browser smoke tests against the combined production container.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const fixtures = path.resolve(__dirname, "../../examples");
const trueEvidence = path.resolve(process.env.TRUE_REPLACEMENT_ARTIFACT_DIR
  ?? path.resolve(__dirname, "../../artifacts/per-column-true/browser"));

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
  await expect(page).toHaveURL(/\/advanced$/);
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

for (const platform of ["logikcull", "everlaw", "unknown"] as const) {
for (const enabled of [true, false]) {
  test(`${platform} TRUE replacement ${enabled ? "enabled" : "disabled"} persists through review and download`, async ({ page, request }) => {
    test.setTimeout(60_000);
    const mode = `${platform}-${enabled ? "enabled" : "disabled"}`;
    const releaseVersion = (await readFile(path.resolve(__dirname, "../../VERSION"), "utf8")).trim();
    await mkdir(trueEvidence, { recursive: true });
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto("/wizard");
    await page.locator('input[type="file"]').setInputFiles({
      name: "synthetic-true-markers.csv", mimeType: "text/csv",
      buffer: Buffer.from(
        (platform === "logikcull" ? "Bates/Control #,End Bates/Control #" : platform === "everlaw" ? "Begin Bates Num from Production,End Bates Num from Production" : "Begin Bates,End Bates") + ",Subject,Tag: Attorney Client,Tag: Work Product\n"
        + "EXAMPLE_000001,EXAMPLE_000092,Re: True-up calculation for Q3,TRUE,true\n"
        + "EXAMPLE_000093,EXAMPLE_001596,Is this statement true?,TrUe,  true  \n"
        + "EXAMPLE_001597,EXAMPLE_001598,True copy of signed agreement,TRUE,FALSE\n"
        + "EXAMPLE_001599,EXAMPLE_001600,Contains a TRUE marker,(TrUe),TRUE-ish\n"
        + "EXAMPLE_001601,EXAMPLE_001601,TRUETYPE,,\n",
      ),
    });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/advanced$/, { timeout: 15_000 });
    await page.waitForLoadState("networkidle");
    const checkbox = page.locator(".mapping-column-card").nth(2).getByRole("checkbox", { name: "Replace TRUE cells with source headings" });
    const secondFlag = page.locator(".mapping-column-card").nth(3).getByRole("checkbox", { name: "Replace TRUE cells with source headings" });
    await expect(page.locator(".mapping-column-card").nth(0).getByRole("checkbox", {
      name: "Replace TRUE cells with source headings",
    })).toBeDisabled();
    await expect(checkbox).not.toBeChecked();
    await expect(secondFlag).not.toBeChecked();
    await checkbox.check();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Choose the output" })).toBeVisible();
    await page.goForward();
    await expect(checkbox).toBeChecked();
    await expect(page).toHaveURL(/\/advanced$/);
    await page.reload();
    await expect(checkbox).toBeChecked();
    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(checkbox).not.toBeChecked();
    if (enabled) { await checkbox.check(); await secondFlag.check(); }
    await expect(page.getByText(/only when its entire value is TRUE/).first()).toBeVisible();
    await page.screenshot({ path: path.join(trueEvidence, `${mode}-settings.png`), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Review output" }).click();
    await expect(page.getByRole("heading", { name: "Review your output" })).toBeVisible();
    const expectedRows = [
      ["EXAMPLE_000001-92", "Re: True-up calculation for Q3", enabled ? "Attorney Client" : "TRUE", enabled ? "Work Product" : "true"],
      ["EXAMPLE_000093-1596", "Is this statement true?", enabled ? "Attorney Client" : "TrUe", enabled ? "Work Product" : "  true  "],
      ["EXAMPLE_001597-1598", "True copy of signed agreement", enabled ? "Attorney Client" : "TRUE", "FALSE"],
      ["EXAMPLE_001599-1600", "Contains a TRUE marker", "(TrUe)", "TRUE-ish"],
      ["EXAMPLE_001601", "TRUETYPE", "", ""],
    ];
    for (const row of expectedRows) {
      await expect(page.getByRole("cell", { name: row[1], exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "Previous" }).click();
    await expect(checkbox).toBeChecked({ checked: enabled });
    // The view updates before Next commits the URL; reload the Advanced route.
    await expect(page).toHaveURL(/\/advanced$/);
    await page.reload();
    await expect(checkbox).toBeChecked({ checked: enabled });
    await page.getByRole("button", { name: "Review output" }).click();
    await expect(page.getByRole("heading", { name: "Review your output" })).toBeVisible();
    const jobId = new URL(page.url()).pathname.split("/")[2];
    const preview = await (await request.get(`/api/v1/jobs/${jobId}/preview`)).json();
    expect(preview.rows).toEqual(expectedRows);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(trueEvidence, `${mode}-review.png`), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Finalize CSV" }).click();
    await expect(page.getByRole("heading", { name: "Your CSV is ready" })).toBeVisible();
    await page.screenshot({ path: path.join(trueEvidence, `${mode}-output.png`), fullPage: true, animations: "disabled" });
    const text = await downloadText(page, /Download CSV/);
    expect(text).toBe("\ufeff" + [["Bates Range", "Subject", "Tag: Attorney Client", "Tag: Work Product"], ...expectedRows]
      .map(row => row.join(",")).join("\r\n") + "\r\n");
    await writeFile(path.join(trueEvidence, `${mode}.csv`), text);
    const receipt = await request.get(`/api/v1/jobs/${jobId}/receipt.json`);
    const receiptJson = await receipt.json();
    expect(receiptJson.platform).toBe(platform);
    expect(receiptJson.mapping.columns.map((column: { replace_true_with_header: boolean }) => column.replace_true_with_header)).toEqual([false, false, enabled, enabled]);
    expect(receiptJson.schema_version).toBe(3);
    expect(receiptJson.app_version).toBe(releaseVersion);
    await writeFile(path.join(trueEvidence, `${mode}-receipt.json`), JSON.stringify(receiptJson, null, 2) + "\n");
    const receiptText = await (await request.get(`/api/v1/jobs/${jobId}/receipt.txt`)).text();
    expect(receiptText).toContain(releaseVersion);
    await writeFile(path.join(trueEvidence, `${mode}-receipt.txt`), receiptText);
    await request.delete(`/api/v1/jobs/${jobId}`);
  });
}

}

test("blocking CSV cannot advance beyond validation", async ({ page }) => {
  await upload(page, "generated/everlaw/pleading/invalid/ew_pleading_018_missing_begin_bates_column.csv");
  await expect(page.getByRole("heading", { name: "Review CSV problems" })).toBeVisible();
  await expect(page.getByText("This CSV was analyzed, but it cannot be processed safely.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose another CSV" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue/ })).toHaveCount(0);
});

for (const platform of ["logikcull", "everlaw"] as const) {
  test(`${platform} keeps TRUE settings independent when an input is reused`, async ({ page, request }) => {
    await mkdir(trueEvidence, { recursive: true });
    await page.setViewportSize({ width: 1500, height: 1100 });
    const bates = platform === "logikcull" ? "Bates/Control #,End Bates/Control #"
      : "Begin Bates Num from Production,End Bates Num from Production";
    await page.goto("/wizard");
    await page.getByLabel("Upload source CSV").setInputFiles({ name: "synthetic-mixed-flags.csv", mimeType: "text/csv",
      buffer: Buffer.from(`${bates},Subject,Tag: Attorney Client\nSYN_1,SYN_1,Is this statement true?,TrUe\n`) });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/advanced$/, { timeout: 15_000 });
    await page.waitForLoadState("networkidle");
    const columns = [
      { id: "on", name: "Privilege reason", source_fields: ["Tag: Attorney Client"], replace_true_with_header: true },
      { id: "off", name: "Original flag", source_fields: ["Tag: Attorney Client"], replace_true_with_header: false },
      { id: "subject", name: "Subject", source_fields: ["Subject"], replace_true_with_header: false },
    ].map((column) => ({ ...column, normalize: false, transform: { kind: "none", delimiter: null } }));
    const template = { schemaVersion: 2, templates: [{ schemaVersion: 2, id: "mixed", name: "Independent flags",
      createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", columns }] };
    await page.getByLabel("Import mapping templates").setInputFiles({ name: "mixed.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(template)) });
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    const cards = page.locator(".mapping-column-card");
    const option = "Replace TRUE cells with source headings";
    await expect(cards.nth(0).getByRole("checkbox", { name: option })).toBeChecked();
    await expect(cards.nth(1).getByRole("checkbox", { name: option })).not.toBeChecked();
    await cards.nth(0).screenshot({ path: path.join(trueEvidence, `${platform}-column-settings.png`), animations: "disabled" });
    await page.screenshot({ path: path.join(trueEvidence, `${platform}-mixed-settings.png`), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Review output" }).click();
    await expect(page.getByRole("cell", { name: "Attorney Client", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "TrUe", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Is this statement true?", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(trueEvidence, `${platform}-mixed-review.png`), fullPage: true, animations: "disabled" });
    const jobId = new URL(page.url()).pathname.split("/")[2];
    expect((await (await request.get(`/api/v1/jobs/${jobId}/preview`)).json()).rows)
      .toEqual([["Attorney Client", "TrUe", "Is this statement true?"]]);
    await page.getByRole("button", { name: "Finalize CSV" }).click();
    await expect(page.getByRole("heading", { name: "Your CSV is ready" })).toBeVisible();
    const receipt = await (await request.get(`/api/v1/jobs/${jobId}/receipt.json`)).json();
    expect(receipt.mapping.columns.map((column: { replace_true_with_header: boolean }) => column.replace_true_with_header))
      .toEqual([true, false, false]);
    expect(await downloadText(page, /Download CSV/)).toContain("Attorney Client,TrUe,Is this statement true?");
    await request.delete(`/api/v1/jobs/${jobId}`);
  });
}

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
