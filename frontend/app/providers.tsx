/**
 * @file Client-side Once UI theme, layout, icon, and toast providers.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

"use client";

import { IconProvider, LayoutProvider, ThemeProvider, ToastProvider } from "@once-ui-system/core";
import { SystemStatusProvider } from "@/components/system-status";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      theme="system"
      neutral="slate"
      brand="cyan"
      accent="indigo"
      solid="contrast"
      solidStyle="flat"
      border="rounded"
      surface="translucent"
      transition="all"
      scaling="100"
    >
      <LayoutProvider>
        <IconProvider>
          <ToastProvider><SystemStatusProvider>{children}</SystemStatusProvider></ToastProvider>
        </IconProvider>
      </LayoutProvider>
    </ThemeProvider>
  );
}
