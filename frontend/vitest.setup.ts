/**
 * @file Shared DOM assertion setup for frontend tests.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import "@testing-library/jest-dom/vitest";

const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", { configurable: true, value: {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
  removeItem: (key: string) => { stored.delete(key); },
  clear: () => { stored.clear(); },
} });
Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({
  matches: false, addListener: () => undefined, removeListener: () => undefined,
  addEventListener: () => undefined, removeEventListener: () => undefined,
}) });
