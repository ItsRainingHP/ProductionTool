/** Local-only qualification for matter-specific Everlaw exports. */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const evidence = path.resolve(__dirname, "../../artifacts/everlaw-rfp-local/browser");
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
test.beforeEach(async ({ page, baseURL }) => {
  expect(localHosts.has(new URL(baseURL!).hostname)).toBe(true);
  await mkdir(evidence, { recursive: true });
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && !localHosts.has(url.hostname)) {
      await route.abort();
      throw new Error(`Nonlocal browser request blocked: ${url.origin}`);
    }
    await route.continue();
  });
  await page.addInitScript(() => localStorage.setItem("production-tool.onboarding.v1",
    JSON.stringify({ schemaVersion: 1, preference: "skipped", chapters: {} })));
});

async function upload(page: Page, csv: string) {
  await page.goto("/wizard");
  await page.locator('input[type="file"]').setInputFiles({ name: "synthetic.csv",
    mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByRole("heading", { name: "Choose the output" })).toBeVisible();
}

async function finalize(page: Page) {
  await expect(page.getByRole("heading", { name: "Review your output" })).toBeVisible();
  await page.getByRole("button", { name: "Finalize text file", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your text file is ready" })).toBeVisible();
  const pending = page.waitForEvent("download");
  await page.getByRole("link", { name: /Download text file/ }).click();
  return readFile((await (await pending).path())!);
}

test("full code labels and source edits survive reload on desktop and mobile", async ({ page, request }) => {
  await upload(page, 'Bates/Control #,End Bates/Control #,RFPs: RFP 23 (2): Calendars,RFPs: RFP 23: Emails,Matter: Notes\n'
    + 'SYN_0001,SYN_0002,RFP 23 (2): Calendars,RFP 23: Emails,Notes\n'
    + 'SYN_0003,SYN_0004,null,RFP 23: Emails,null\n');
  await expect(page.getByRole("radio", { name: /RFP \/ Pleading Ranges/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "RFP 23 (2): Calendars", exact: true })).toBeChecked();
  await page.getByRole("checkbox", { name: "Notes", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Object.values(sessionStorage)
    .some((value) => value.includes('"column":"Matter: Notes"')))).toBe(true);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Notes", exact: true })).toBeChecked();
  await page.screenshot({ path: path.join(evidence, "sources-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(evidence, "sources-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Review output", exact: true }).click();
  const output = await finalize(page);
  expect(output.toString()).toBe("RFP 23 (2): Calendars\r\nSYN_0001-2\r\n\r\nRFP 23: Emails\r\nSYN_0001-4\r\n\r\nNotes\r\nSYN_0001-2\r\n");
  const jobId = new URL(page.url()).pathname.split("/")[2];
  const receipt = await (await request.get(`/api/v1/jobs/${jobId}/receipt.json`)).json();
  expect(receipt.pleading_settings.request_sources).toHaveLength(3);
  expect(receipt.output_sha256).toBe(createHash("sha256").update(output).digest("hex"));
});

test("arbitrary category lists recover from an ambiguous separator", async ({ page }) => {
  await upload(page, 'Begin Bates,End Bates,Custom matter\nSYN_0001,SYN_0002,"Alpha; Beta"\n');
  await expect(page.getByText("Unclassified data", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: /RFP \/ Pleading Ranges/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("checkbox", { name: "Custom matter", exact: true }).click();
  await page.getByRole("combobox", { name: "Source layout for Custom matter" }).selectOption("category");
  await page.getByRole("button", { name: "Review output", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Check the request source settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inspect pleading ranges" })).toBeVisible();
  await page.getByRole("combobox", { name: "Input code separator for Custom matter" }).selectOption("semicolon");
  await page.getByRole("button", { name: "Review output", exact: true }).click();
  expect((await finalize(page)).toString()).toBe("Alpha\r\nSYN_0001-2\r\n\r\nBeta\r\nSYN_0001-2\r\n");
});

test("private local CSV produces 26 headings and retains its original bytes", async ({ page, request }) => {
  const csvPath = process.env.LOCAL_EVERLAW_CSV;
  test.skip(!csvPath, "Set LOCAL_EVERLAW_CSV for the private local acceptance case");
  const original = await readFile(csvPath!);
  await page.goto("/wizard");
  await page.locator('input[type="file"]').setInputFiles(csvPath!);
  await expect(page.getByRole("heading", { name: "Choose the output" })).toBeVisible();
  const jobId = new URL(page.url()).pathname.split("/")[2];
  const job = await (await request.get(`/api/v1/jobs/${jobId}`)).json();
  expect(job.analysis.row_count).toBe(197);
  expect(job.analysis.request_count).toBe(26);
  expect(job.analysis.detected_workflow).toBe("rfp_ranges");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Request sources", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review output", exact: true }).click();
  const output = await finalize(page);
  const headings = output.toString().trim().split("\r\n\r\n").map((group) => group.split("\r\n")[0]);
  expect(headings).toHaveLength(26);
  expect(headings.some((heading) => /^RFP 23 \(2\):/.test(heading))).toBe(true);
  expect(headings.some((heading) => /^RFP 23:/.test(heading))).toBe(true);
  expect(headings).not.toContain("null");
  const receipt = await (await request.get(`/api/v1/jobs/${jobId}/receipt.json`)).json();
  expect(receipt.output_sha256).toBe(createHash("sha256").update(output).digest("hex"));
  expect(await readFile(csvPath!)).toEqual(original);
  await writeFile(path.join(evidence, "supplied-output.txt"), output);
  await writeFile(path.join(evidence, "supplied-receipt.json"), JSON.stringify(receipt, null, 2));
});
