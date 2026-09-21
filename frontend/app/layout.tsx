/**
 * @file Root document layout and application metadata.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import type { Metadata } from "next";
import { connection } from "next/server";
import "@once-ui-system/core/css/tokens.css";
import "@once-ui-system/core/css/styles.css";
import "./globals.scss";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Production Tool",
  description: "Prepare RFP ranges and privilege logs from discovery exports.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection();
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
