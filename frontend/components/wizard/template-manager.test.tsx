import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/providers";
import { createTemplate, exportTemplates } from "../../lib/templates";
import type { MappingTemplate, OutputColumn } from "../../lib/types";
import { TemplateManager } from "./template-manager";

const column: OutputColumn = {
  id: "author", name: "Author", source_fields: ["Author"],
  transform: { kind: "none", delimiter: null }, normalize: false,
};
const onApply = vi.fn();
const onError = vi.fn();

function Harness({ initial = [], headers = ["Author"], columns = [column] }: {
  initial?: MappingTemplate[]; headers?: string[]; columns?: OutputColumn[];
}) {
  const [templates, setTemplates] = useState(initial);
  return <Providers><TemplateManager headers={headers} columns={columns} templates={templates}
    onTemplatesChange={setTemplates} onApply={onApply} onError={onError} /></Providers>;
}

describe("mapping template actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "matchMedia", { configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
    window.localStorage.clear();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("saves, renames, updates, applies and deletes a browser-local mapping", () => {
    render(<Harness />);
    const name = screen.getByRole("textbox", { name: "Template name" });
    fireEvent.change(name, { target: { value: " Reviewers " } });
    fireEvent.click(screen.getByRole("button", { name: "Save current mapping" }));
    expect(window.localStorage.getItem("production-tool.mapping-templates.v1")).toContain("Reviewers");
    expect(screen.getAllByRole("textbox", { name: "Template name" })[0]).toHaveValue("");
    const templateInput = screen.getAllByRole("textbox", { name: "Template name" })[1];
    fireEvent.change(templateInput, { target: { value: "Review team" } });
    fireEvent.blur(templateInput);
    expect(window.localStorage.getItem("production-tool.mapping-templates.v1")).toContain("Review team");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([expect.objectContaining({ name: "Author" })], []);
    fireEvent.click(screen.getByRole("button", { name: "Update mapping" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(window.localStorage.getItem("production-tool.mapping-templates.v1")).toBe("[]");
  });

  it("imports valid JSON, exports it, and reports a bad import", async () => {
    const template = createTemplate("Reviewers", [column]);
    const url = vi.fn(() => "blob:template");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: url, revokeObjectURL: revoke }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<Harness initial={[template]} />);
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    expect(url).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:template");

    const input = screen.getByLabelText("Import mapping templates");
    const openChooser = vi.spyOn(input as HTMLInputElement, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
    expect(openChooser).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { files: [] } });
    expect(onError).not.toHaveBeenCalled();
    const valid = new File([exportTemplates([template])], "templates.json", { type: "application/json" });
    Object.defineProperty(valid, "text", { value: async () => exportTemplates([template]) });
    fireEvent.change(input, { target: { files: [valid] } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Apply" })).toHaveLength(2));
    const invalid = new File(["bad"], "bad.json", { type: "application/json" });
    Object.defineProperty(invalid, "text", { value: async () => "bad" });
    fireEvent.change(input, { target: { files: [invalid] } });
    await waitFor(() => expect(onError).toHaveBeenCalledWith("The template file is not valid JSON."));
  });

  it("keeps templates visible and reports storage failure and missing source fields", () => {
    const template = createTemplate("Reviewers", [column]);
    render(<Harness initial={[template]} headers={[]} />);
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("full"); });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith([expect.objectContaining({ source_fields: [] })], ["Author"]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Browser storage is unavailable"));
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
    setItem.mockRestore();
  });
});
