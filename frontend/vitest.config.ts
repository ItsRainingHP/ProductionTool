/**
 * @file Vitest configuration for React tests in a browser-like environment.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "e2e/**"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
