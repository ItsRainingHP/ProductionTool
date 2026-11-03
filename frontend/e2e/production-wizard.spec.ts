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
import { createHash } from "node:crypto";

const fixtures = path.resolve(__dirname, "../../examples");
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("production-tool.onboarding.v1", JSON.stringify({ schemaVersion: 1, preference: "skipped", chapters: {} })));
});
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

for (const workflow of ["rfp_ranges", "privilege_log"] as const) {
  test(`${workflow} shows Bates-only rows on Data and requires acknowledgment before output`, async ({ page, request }) => {
    const evidence = path.resolve(__dirname, "../../artifacts/bates-only-warning");
    const source = [
      ["Begin Bates", "End Bates", "Tag: RFP 01", "Redact", "Withhold", "Subject"],
      ["ABC0001", "ABC0002", "TRUE", "Redact", "", "Populated subject"],
      ["ABC0003", "ABC0004", "", "", "", ""],
      ["ABC0005", "ABC0006", " ", "\t", " ", " "],
    ].map((row) => row.join(",")).join("\r\n") + "\r\n";
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto("/wizard");
    await page.locator('input[type="file"]').setInputFiles({ name: "bates-only.csv", mimeType: "text/csv", buffer: Buffer.from(source) });
    await expect(page).toHaveURL(/\/data$/);
    await expect(page.getByText(/Begin and End Bates values but no data/)).toBeVisible();
    await expect(page.getByText(/First affected row: 3/)).toContainText("2 occurrences");
    await expect(page.getByRole("checkbox", { name: /understand how this issue affects/ })).toHaveCount(0);
    const jobId = page.url().split("/").at(-2)!;
    await page.reload();
    await expect(page.getByText(/Begin and End Bates values but no data/)).toBeVisible();
    await page.getByRole("radio", { name: workflow === "privilege_log" ? /Privilege Log/ : /RFP \/ Pleading/ }).click();
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, `${workflow}-data.png`), fullPage: true, animations: "disabled" });
    if (workflow === "privilege_log") {
      await page.setViewportSize({ width: 390, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: path.join(evidence, "privilege-data-mobile.png"), fullPage: true, animations: "disabled" });
      await page.setViewportSize({ width: 1440, height: 1100 });
    }
    await page.getByRole("button", { name: "Continue with warnings" }).click();
    await expect(page).toHaveURL(/\/advanced$/);
    await expect(page.getByRole("button", { name: "Review output" })).toBeDisabled();
    await page.getByRole("checkbox", { name: /understand how this issue affects/ }).check();
    await page.getByRole("button", { name: "Review output" }).click();
    await expect(page).toHaveURL(/\/review$/);
    await page.getByRole("button", { name: "Finalize with warnings" }).click();
    await expect(page).toHaveURL(/\/download$/);
    const output = await downloadText(page, workflow === "privilege_log" ? /Download CSV/ : /Download text file/);
    expect(output).toBe(workflow === "privilege_log"
      ? "\ufeffBates Range,Privilege\r\nABC0001-2,Redact\r\nABC0003-4,\r\nABC0005-6,\r\n"
      : "RFP 01\r\nABC0001-2\r\n");
    const receipt = await (await request.get(`/api/v1/jobs/${jobId}/receipt.json`)).json();
    expect(receipt.issue_counts).toEqual({ bates_only_row: 2 });
    expect(receipt.acknowledged_issue_codes).toEqual(["bates_only_row"]);
    expect(receipt.input_sha256).toBe(createHash("sha256").update(source).digest("hex"));
    await writeFile(path.join(evidence, `${workflow}-output.${workflow === "privilege_log" ? "csv" : "txt"}`), output);
    await writeFile(path.join(evidence, `${workflow}-receipt.json`), JSON.stringify(receipt, null, 2));
  });
}

test("privilege defaults use only Bates Range and Redact/Withhold Fill through download", async ({ page, request }) => {
  const evidence = path.resolve(__dirname, "../../artifacts/privilege-defaults");
  const headers = ["Begin Bates num from SYNTHETIC_PROD_001", "End Bates num from SYNTHETIC_PROD_001",
    "Date", "File Name", "Email From", "Email To", "Email CC", "Email BCC", "Email Subject",
    "Tag: Privilege - Withhold", "Tag: Privilege - Redact", "Tag: Attorney-Client"];
  const source = [headers,
    ["ABC000001", "ABC000003", "", "first.pdf", "", "", "", "", "Unused subject", "", "Redact", "Yes"],
    ["ABC000004", "ABC000004", "", "second.pdf", "", "", "", "", "", "Withhold", "", ""],
    ["ABC000005", "ABC000006", "", "third.pdf", "", "", "", "", "", "Withhold", "Redact", ""],
    ["ABC000007", "ABC000007", "", "fourth.pdf", "", "", "", "", "", "", "", ""],
  ].map((row) => row.join(",")).join("\r\n") + "\r\n";
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto("/wizard");
  await page.locator('input[type="file"]').setInputFiles({ name: "privilege-defaults.csv", mimeType: "text/csv", buffer: Buffer.from(source) });
  await expect(page).toHaveURL(/\/data$/);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/advanced$/);
  await expect(page.getByLabel("Output column 1", { exact: true })).toHaveValue("Bates Range");
  await expect(page.getByLabel("Output column 2", { exact: true })).toHaveValue("Privilege");
  await expect(page.getByLabel("Output column 3", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Transform for Privilege", exact: true }).getByRole("button", { name: "Fill", exact: true })).toHaveAttribute("aria-pressed", "true");
  const jobId = page.url().split("/").at(-2)!;
  await page.reload();
  await expect(page.getByLabel("Output column 2", { exact: true })).toHaveValue("Privilege");
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, "mapping.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Review output" }).click();
  await expect(page.getByRole("heading", { name: "Review your output" })).toBeVisible();
  const job = await (await request.get(`/api/v1/jobs/${jobId}`)).json();
  expect(job.mapping.columns).toEqual([
    expect.objectContaining({ name: "Bates Range", source_fields: headers.slice(0, 2), transform: { kind: "shorten_bates", delimiter: null } }),
    expect.objectContaining({ name: "Privilege", source_fields: ["Tag: Privilege - Redact", "Tag: Privilege - Withhold"], transform: { kind: "fill", delimiter: null } }),
  ]);
  await page.getByRole("button", { name: "Finalize CSV" }).click();
  await expect(page.getByRole("heading", { name: "Your CSV is ready" })).toBeVisible();
  const text = await downloadText(page, /Download CSV/);
  expect(text).toBe("\ufeffBates Range,Privilege\r\nABC000001-3,Redact\r\nABC000004,Withhold\r\nABC000005-6,Redact\r\nABC000007,\r\n");
  await writeFile(path.join(evidence, "output.csv"), text);
  await writeFile(path.join(evidence, "mapping.json"), JSON.stringify(job.mapping, null, 2));
});

test("privilege wizard produces a spreadsheet-safe CSV", async ({ page }) => {
  await upload(page, "reference-sanitized/logikcull/privilege/valid/lc_reference_privilege_001.csv");
  await expect(page.getByRole("heading", { name: "Choose the output" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Build privilege output" })).toBeVisible();
  await page.locator(".source-chip").filter({ has: page.locator(".source-name", { hasText: /^Privilege$/ }) }).click();
  await page.locator(".mapping-column-card").filter({ has: page.getByLabel("Output column 2", { exact: true }) }).getByRole("button", { name: "Add Privilege here", exact: true }).click();
  await page.getByRole("button", { name: "Review output" }).click();
  await expect(page.getByRole("heading", { name: "Review your output" })).toBeVisible();
  await page.getByRole("button", { name: "Finalize CSV" }).click();
  await expect(page.getByRole("heading", { name: "Your CSV is ready" })).toBeVisible();
  const text = await downloadText(page, /Download CSV/);
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text).toContain("Bates Range");
  expect(text).toContain("SYNREFLCPRV001-0000001");
});

for (const theme of ["light", "dark"] as const) {
  test(`privilege source drag follows the mouse and persists exact output in ${theme} theme`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const field = "Author with a deliberately long source heading for privilege document metadata";
    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("/wizard");
    await page.getByLabel("Upload source CSV").setInputFiles({ name: "drag-preview.csv", mimeType: "text/csv",
      buffer: Buffer.from(`Begin Bates,End Bates,${field},Subject\nABC000001,ABC000002,Alice,Example\n`) });
    await expect(page).toHaveURL(/\/data$/);
    const jobId = page.url().split("/").at(-2)!;
    try {
      await page.getByRole("radio", { name: /Privilege Log/ }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page).toHaveURL(/\/advanced$/);
      const chip = page.locator(".source-palette .source-chip").filter({ has: page.locator(".source-name", { hasText: field }) });
      const targets = page.locator(".mapping-fields");
      const dragTo = async (targetIndex: number, screenshot = false) => {
        const target = targets.nth(targetIndex);
        await target.scrollIntoViewIfNeeded();
        await chip.scrollIntoViewIfNeeded();
        const origin = (await chip.boundingBox())!;
        const start = { x: origin.x + 20, y: origin.y + 12 };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await expect(page.locator(".drag-overlay")).toBeVisible();
        await page.mouse.move(start.x + 3, start.y + 4);
        await expect(page.locator(".drag-overlay")).toBeVisible();
        for (const offset of [{ x: 60, y: 20 }, { x: 160, y: 50 }]) {
          await page.mouse.move(start.x + offset.x, start.y + offset.y, { steps: 5 });
          const ghost = page.locator(".drag-overlay");
          await expect(ghost).toBeVisible();
          await expect(ghost).toHaveAttribute("aria-hidden", "true");
          await expect(ghost).toHaveCSS("pointer-events", "none");
          await expect(ghost.locator(".source-name")).toHaveCSS("white-space", "normal");
          expect(await ghost.evaluate((element) => element.parentElement === document.body)).toBe(true);
          expect(await ghost.evaluate((element) => getComputedStyle(element).backgroundColor))
            .toBe(await page.locator("html").evaluate((element) => getComputedStyle(element).backgroundColor));
          await expect.poll(async () => Math.abs((await ghost.boundingBox())!.x - (origin.x + offset.x))).toBeLessThan(2);
          await expect.poll(async () => Math.abs((await ghost.boundingBox())!.y - (origin.y + offset.y))).toBeLessThan(2);
          expect(Math.abs((await ghost.boundingBox())!.width - origin.width)).toBeLessThan(2);
          await expect(chip).toHaveClass(/is-dragging/);
        }
        if (screenshot) {
          const beforeWheel = (await page.locator(".drag-overlay").boundingBox())!;
          await page.mouse.wheel(0, 70);
          await expect.poll(async () => Math.abs((await page.locator(".drag-overlay").boundingBox())!.y - beforeWheel.y)).toBeLessThan(2);
        }
        const destination = (await target.boundingBox())!;
        await page.mouse.move(destination.x + 35, destination.y + 25, { steps: 10 });
        await expect(target).toHaveClass(/is-over/);
        await expect(target).toHaveClass(/is-active/);
        if (screenshot) {
          const directory = path.resolve(__dirname, "../../artifacts/source-drag/browser");
          await mkdir(directory, { recursive: true });
          await page.screenshot({ path: path.join(directory, `drag-${theme}.png`), animations: "disabled" });
        }
        await page.mouse.up();
        await expect(page.locator(".drag-overlay")).toHaveCount(0);
        await expect(chip).not.toHaveClass(/is-dragging/);
      };
      await dragTo(1, true);
      await expect(targets.nth(1).locator(".mapping-field-row")).toHaveCount(1);
      // Dropping onto the nested source-priority content must not duplicate the assignment.
      await dragTo(1);
      await expect(targets.nth(1).locator(".mapping-field-row")).toHaveCount(1);
      await expect(chip.locator(".source-count")).toHaveText("1");

      // Cancellation leaves both mapping and click/keyboard selection usable.
      const origin = (await chip.boundingBox())!;
      await page.mouse.move(origin.x + 20, origin.y + 12); await page.mouse.down();
      await page.mouse.move(origin.x + 100, origin.y + 70, { steps: 5 });
      await expect(page.locator(".drag-overlay")).toBeVisible();
      await page.keyboard.press("Escape"); await page.mouse.up();
      await expect(page.locator(".drag-overlay")).toHaveCount(0);
      await expect(targets.nth(1).locator(".mapping-field-row")).toHaveCount(1);
      await page.getByRole("button", { name: "Add another empty output column" }).click();
      await chip.focus(); await page.keyboard.press("Enter");
      await targets.nth(2).getByRole("button", { name: `Add ${field} here`, exact: true }).click();
      await expect(chip.locator(".source-count")).toHaveText("2");
      await page.getByRole("button", { name: "Review output", exact: true }).click();
      await expect(page).toHaveURL(/\/review$/);
      await page.reload();
      const preview = await (await request.get(`/api/v1/jobs/${jobId}/preview`)).json();
      expect(preview.rows).toEqual([["ABC000001-2", "Alice", "Alice"]]);
      const mapping = (await (await request.get(`/api/v1/jobs/${jobId}`)).json()).mapping;
      expect(mapping.columns.map((column: { transform: { kind: string } }) => column.transform.kind)).toEqual(["shorten_bates", "fill", "none"]);
      expect(mapping.columns.slice(1).map((column: { source_fields: string[] }) => column.source_fields)).toEqual([[field], [field]]);
      await page.getByRole("button", { name: "Finalize CSV", exact: true }).click();
      await expect(page).toHaveURL(/\/download$/);
      expect(await downloadText(page, /Download CSV/)).toBe("\ufeffBates Range,Privilege,Output column 3\r\nABC000001-2,Alice,Alice\r\n");
    } finally { await request.delete(`/api/v1/jobs/${jobId}`); }
  });
}

test("Bcc visibly lifts on click-hold inside a scrolled source list and follows the mouse outside it", async ({ page, request }) => {
  const evidence = path.resolve(__dirname, "../../artifacts/source-drag-feedback");
  await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.emulateMedia({ colorScheme: "dark" });
  const headers = ["Begin Bates", "End Bates", ...Array.from({ length: 24 }, (_, i) => `Metadata ${i + 1}`), "Author", "Bcc", "Cc"];
  const row = ["ABC000001", "ABC000002", ...Array.from({ length: 24 }, (_, i) => `Example ${i + 1}`), "Alice", "Hidden recipient", "Copy recipient"];
  await page.goto("/wizard");
  await page.getByLabel("Upload source CSV").setInputFiles({ name: "bcc-feedback.csv", mimeType: "text/csv", buffer: Buffer.from(`${headers.join(",")}\n${row.join(",")}\n`) });
  await expect(page).toHaveURL(/\/data$/);
  const jobId = page.url().split("/").at(-2)!;
  try {
    await page.getByRole("radio", { name: /Privilege Log/ }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(/\/advanced$/);
    const chip = page.locator(".source-palette .source-chip").filter({ has: page.locator(".source-name", { hasText: /^Bcc$/ }) });
    await chip.scrollIntoViewIfNeeded();
    expect(await page.locator(".source-list").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const origin = (await chip.boundingBox())!;
    await page.mouse.move(origin.x + 40, origin.y + 20);
    await page.mouse.down();
    const ghost = page.locator(".drag-overlay");
    await expect(ghost).toBeVisible();
    await expect(ghost.locator(".source-name")).toHaveText("Bcc");
    await expect(chip).toHaveClass(/is-dragging/);
    await page.screenshot({ path: path.join(evidence, "bcc-held.png"), animations: "disabled" });
    await page.mouse.move(origin.x + origin.width + 60, origin.y + 80, { steps: 12 });
    await expect.poll(async () => Math.abs((await ghost.boundingBox())!.x - (origin.x + origin.width + 20))).toBeLessThan(2);
    expect(await ghost.evaluate((element) => element.parentElement === document.body)).toBe(true);
    await page.screenshot({ path: path.join(evidence, "bcc-following.png"), animations: "disabled" });
    const target = page.locator(".mapping-fields").nth(1);
    await target.scrollIntoViewIfNeeded();
    const destination = (await target.boundingBox())!;
    await page.mouse.move(destination.x + 35, destination.y + 25, { steps: 12 });
    await expect(target).toHaveClass(/is-over/);
    await page.mouse.up();
    await expect(ghost).toHaveCount(0);
    await expect(target.locator(".mapping-field-row")).toHaveText(/Bcc/);
    await expect(chip.locator(".source-count")).toHaveText("1");
    await page.getByRole("button", { name: "Review output", exact: true }).click();
    await expect(page).toHaveURL(/\/review$/);
    expect((await (await request.get(`/api/v1/jobs/${jobId}/preview`)).json()).rows).toEqual([["ABC000001-2", "Hidden recipient"]]);
  } finally { await request.delete(`/api/v1/jobs/${jobId}`); }
});

test("touch users can still tap a source and add it without a drag preview", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => localStorage.setItem("production-tool.onboarding.v1", JSON.stringify({ schemaVersion: 1, preference: "skipped", chapters: {} })));
  const page = await context.newPage();
  let jobId: string | undefined;
  try {
    await page.goto("/wizard");
    await page.getByLabel("Upload source CSV").setInputFiles({ name: "touch-mapping.csv", mimeType: "text/csv",
      buffer: Buffer.from("Begin Bates,End Bates,Author\nABC000001,ABC000002,Alice\n") });
    await expect(page).toHaveURL(/\/data$/); jobId = page.url().split("/").at(-2)!;
    await page.getByRole("radio", { name: /Privilege Log/ }).tap();
    await page.getByRole("button", { name: "Continue", exact: true }).tap();
    const chip = page.locator(".source-palette .source-chip").filter({ has: page.locator(".source-name", { hasText: /^Author$/ }) });
    await chip.tap();
    await expect(page.locator(".drag-overlay")).toHaveCount(0);
    await page.locator(".mapping-fields").nth(1).getByRole("button", { name: "Add Author here", exact: true }).tap();
    await expect(page.locator(".mapping-fields").nth(1).locator(".mapping-field-row")).toHaveText(/Author/);
    await expect(chip.locator(".source-count")).toHaveText("1");
  } finally {
    if (jobId) await context.request.delete(`/api/v1/jobs/${jobId}`);
    await context.close();
  }
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
    // This scenario needs four specific columns; do not depend on editor defaults.
    const mappingJobId = new URL(page.url()).pathname.split("/")[2];
    const configuredJob = await (await request.get(`/api/v1/jobs/${mappingJobId}`)).json();
    const columns = [
      { id: "bates", name: "Bates Range", source_fields: [configuredJob.analysis.begin_bates_header, configuredJob.analysis.end_bates_header],
        transform: { kind: "shorten_bates", delimiter: null }, normalize: false, replace_true_with_header: false },
      ...["Subject", "Tag: Attorney Client", "Tag: Work Product"].map((field, index) => ({
        id: `field-${index}`, name: field, source_fields: [field], transform: { kind: "none", delimiter: null }, normalize: false, replace_true_with_header: false,
      })),
    ];
    expect((await request.put(`/api/v1/jobs/${mappingJobId}/mapping`, { data: { columns } })).status()).toBe(200);
    await page.reload();
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
