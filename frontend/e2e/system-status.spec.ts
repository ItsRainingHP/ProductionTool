/** Footer update availability, native hover text, and responsive layout. */
import { expect, test } from "@playwright/test";
import { ONBOARDING_KEY } from "../lib/onboarding";

for (const available of [false, true]) {
  test(`Systems Status is ${available ? "yellow" : "green"} on home and wizard pages`, async ({ page }) => {
    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, preference: "skipped", chapters: {} }));
    }, ONBOARDING_KEY);
    await page.route("**/api/v1/system-status", (route) => route.fulfill({ json: {
      current_version: "2.0.5", latest_version: available ? "2.0.6" : "2.0.5", update_available: available,
    } }));
    const message = available ? "update available" : "ready";
    await page.goto("/");
    const footer = page.getByRole("contentinfo");
    const circle = footer.getByRole("img", { name: `Systems Status: ${message}` });
    await expect(circle).toHaveAttribute("data-status", available ? "update-available" : "ready");
    await expect(circle.locator(":scope > div")).toHaveCSS(
      "background-color", available ? "rgb(254, 204, 85)" : "rgb(1, 207, 56)",
    );
    await expect(circle).toHaveAttribute("title", message);
    await expect(footer.getByText(message, { exact: true })).toHaveCount(0);
    await expect(footer.getByRole("tooltip")).toHaveCount(0);
    const version = await footer.getByText(/^Version /).boundingBox();
    const status = await footer.getByText("Systems Status", { exact: true }).boundingBox();
    expect(status!.y).toBeGreaterThan(version!.y);
    await circle.hover();
    await circle.click();
    await expect(circle).toBeFocused();
    await page.mouse.move(0, 0);
    await expect(footer.getByText(message, { exact: true })).toHaveCount(0);
    await expect(footer.getByRole("tooltip")).toHaveCount(0);
    await footer.screenshot({ path: test.info().outputPath("footer-desktop.png") });
    await page.getByRole("link", { name: "Start Processing" }).click();
    await expect(page).toHaveURL(/\/wizard$/);
    await expect(circle).toBeAttached();
    await page.setViewportSize({ width: 320, height: 740 });
    await circle.scrollIntoViewIfNeeded();
    await circle.focus();
    await expect(circle).toHaveAttribute("title", message);
    await expect(footer.getByText(message, { exact: true })).toHaveCount(0);
    await expect(footer.getByRole("tooltip")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await footer.screenshot({ path: test.info().outputPath("footer-mobile.png") });
  });
}
