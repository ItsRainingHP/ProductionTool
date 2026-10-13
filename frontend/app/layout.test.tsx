import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RootLayout, { metadata } from "./layout";

const connection = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("next/server", () => ({ connection }));

describe("root layout", () => {
  it("waits for request context and wraps children in the application providers", async () => {
    const layout = await RootLayout({ children: <main>Production workspace</main> });
    render(layout);
    expect(connection).toHaveBeenCalledOnce();
    expect(screen.getByText("Production workspace")).toBeInTheDocument();
    expect(metadata.title).toBe("Production Tool");
  });
});
