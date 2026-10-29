/** Synthetic boundary and TRUE-marker cases exercised through the production wizard. */
import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { OutputColumn } from "../lib/types";

const root = path.resolve(__dirname, "../..");
const evidenceRoot = path.resolve(process.env.OUTPUT_STRESS_ARTIFACT_DIR ?? path.join(root, "artifacts/output-stress-validation"));
type StressCase = {
  id: string;
  path: string;
  platform: "logikcull" | "everlaw";
  workflow: "rfp_ranges" | "privilege_log";
  replaceTrueWithHeader?: boolean;
  columns?: OutputColumn[];
  expectedHeaders?: string[];
  expectedRows: number | string[][];
  expectedText?: string;
  expectedEscapes: number;
};
const { cases } = JSON.parse(readFileSync(path.join(root, "examples/output-stress-cases.json"), "utf8")) as { cases: StressCase[] };

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

for (const scenario of cases) {
  test(`stress ${scenario.id}: Review, Output, and exact download`, async ({ page, request }) => {
    const source = path.join(root, "examples", scenario.path);
    const original = await readFile(source);
    await mkdir(evidenceRoot, { recursive: true });
    let jobId: string | undefined;
    try {
      await page.goto("/wizard");
      await page.getByLabel("Upload source CSV").setInputFiles(source);
      await expect(page.getByRole("heading", { name: "Choose the output" })).toBeVisible();
      await expect(page).toHaveURL(/\/wizard\/[0-9a-f-]+\/data$/);
      jobId = new URL(page.url()).pathname.split("/")[2];
      const analyzed = await (await request.get(`/api/v1/jobs/${jobId}`)).json();
      expect(analyzed.analysis.platform).toBe(scenario.platform);
      expect(analyzed.analysis.issues).toEqual([]);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page).toHaveURL(/\/advanced$/);
      await expect(page.getByRole("heading", { name: scenario.workflow === "rfp_ranges" ? "Inspect pleading ranges" : "Build privilege output" })).toBeVisible();
      await page.waitForLoadState("networkidle");

      if (scenario.workflow === "privilege_log") {
        const template = { schemaVersion: 1, templates: [{
          schemaVersion: 1, id: "synthetic-output-stress", name: "Synthetic output stress mapping",
          createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z", columns: scenario.columns,
        }] };
        await page.getByLabel("Import mapping templates").setInputFiles({
          name: "synthetic-output-stress-mapping.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(template)),
        });
        await page.getByRole("button", { name: "Apply", exact: true }).click();
        const checkbox = page.getByRole("checkbox", { name: "Replace cells containing TRUE with column headings" });
        if (scenario.platform === "logikcull") {
          await expect(checkbox).toBeChecked();
          if (!scenario.replaceTrueWithHeader) await checkbox.uncheck();
        } else {
          await expect(checkbox).toHaveCount(0);
        }
      }

      await page.getByRole("button", { name: "Review output" }).click();
      await expect(page.getByRole("heading", { name: "Review your output" })).toBeVisible();
      await page.getByLabel("Output filename").fill(scenario.id);
      const previewResponse = await request.get(`/api/v1/jobs/${jobId}/preview?limit=5`);
      expect(previewResponse.ok()).toBeTruthy();
      const preview = await previewResponse.json();
      if (scenario.workflow === "rfp_ranges") {
        expect(preview.text).toBe(scenario.expectedText);
        await expect(page.locator(".text-preview")).toHaveText(scenario.expectedText!);
      } else {
        expect(preview.headers).toEqual(scenario.expectedHeaders);
        expect(preview.rows).toEqual((scenario.expectedRows as string[][]).slice(0, 5));
        await expect(page.getByRole("columnheader", { name: "Fill", exact: true })).toBeVisible();
      }
      expect(preview.formula_escapes).toBe(scenario.expectedEscapes);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(evidenceRoot, `${scenario.id}-review.png`), fullPage: true, animations: "disabled" });

      await page.getByRole("button", { name: scenario.workflow === "rfp_ranges" ? "Finalize text file" : "Finalize CSV" }).click();
      await expect(page.getByRole("heading", { name: scenario.workflow === "rfp_ranges" ? "Your text file is ready" : "Your CSV is ready" })).toBeVisible();
      await page.screenshot({ path: path.join(evidenceRoot, `${scenario.id}-output.png`), fullPage: true, animations: "disabled" });
      const extension = scenario.workflow === "rfp_ranges" ? "txt" : "csv";
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("link", { name: scenario.workflow === "rfp_ranges" ? "Download text file" : "Download CSV", exact: true }).click();
      const download = await downloadPromise;
      const outputPath = path.join(evidenceRoot, `${scenario.id}.${extension}`);
      await download.saveAs(outputPath);
      const output = await readFile(outputPath, "utf8");
      const expected = scenario.workflow === "rfp_ranges" ? scenario.expectedText
        : "\ufeff" + [scenario.expectedHeaders!, ...(scenario.expectedRows as string[][])].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
      expect(output).toBe(expected);
      expect(await readFile(source)).toEqual(original);
      const receiptResponse = await request.get(`/api/v1/jobs/${jobId}/receipt.json`);
      expect(receiptResponse.ok()).toBeTruthy();
      const receipt = await receiptResponse.json();
      expect(receipt.output_stats.output_rows).toBe(Array.isArray(scenario.expectedRows) ? scenario.expectedRows.length : scenario.expectedRows);
      expect(receipt.output_stats.formula_escapes).toBe(scenario.expectedEscapes);
      if (scenario.platform === "logikcull" && scenario.workflow === "privilege_log") {
        expect(receipt.mapping.replace_true_with_header).toBe(scenario.replaceTrueWithHeader);
      }
      await writeFile(path.join(evidenceRoot, `${scenario.id}-receipt.json`), JSON.stringify(receipt, null, 2) + "\n");
      await writeFile(path.join(evidenceRoot, `${scenario.id}-preview.json`), JSON.stringify(preview, null, 2) + "\n");
    } finally {
      if (jobId) expect((await request.delete(`/api/v1/jobs/${jobId}`)).status()).toBe(204);
    }
  });
}
