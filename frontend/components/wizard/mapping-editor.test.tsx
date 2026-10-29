/**
 * @file Interaction tests for privilege-log contact normalization controls.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/providers";
import type { OutputColumn } from "../../lib/types";
import { MappingEditor } from "./mapping-editor";

describe("MappingEditor normalization", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  });

  it("reports the per-column normalize setting independently of the transform", () => {
    const onChange = vi.fn();
    const columns: OutputColumn[] = [{
      id: "author",
      name: "Author",
      source_fields: ["Author"],
      transform: { kind: "none", delimiter: null },
      normalize: false,
    }];
    render(
      <Providers>
        <MappingEditor headers={["Author"]} columns={columns} onChange={onChange} />
      </Providers>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Normalize names and emails" }));
    expect(onChange).toHaveBeenCalledWith([{ ...columns[0], normalize: true }]);
    expect(screen.getByText(/source CSV is not changed/i)).toBeInTheDocument();
  });

  function Harness({ headers, initial, jobId }: { headers: string[]; initial: OutputColumn[]; jobId?: string }) {
    const [columns, setColumns] = useState(initial);
    return <Providers><MappingEditor jobId={jobId} headers={headers} columns={columns} onChange={setColumns} />
      <output data-testid="mapping-state">{JSON.stringify(columns)}</output></Providers>;
  }

  const state = (): OutputColumn[] => JSON.parse(screen.getByTestId("mapping-state").textContent ?? "[]") as OutputColumn[];

  it("warns only for affected output columns and refreshes after a mapping change", async () => {
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const mapping = JSON.parse(init.body as string) as { columns: OutputColumn[] };
      return new Response(JSON.stringify({
        blank_cells: mapping.columns.map((column) => column.source_fields.length === 1 ? 2 : 0),
        output_rows: 3,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const initial: OutputColumn[] = [
      { id: "author", name: "Author", source_fields: ["Author"], transform: { kind: "none", delimiter: null }, normalize: false },
      { id: "range", name: "Range", source_fields: ["Begin Bates", "End Bates"], transform: { kind: "shorten_bates", delimiter: null }, normalize: false },
    ];
    const { container } = render(<Harness jobId="job-1" headers={["Author", "Recipient", "Begin Bates", "End Bates"]} initial={initial} />);
    const cards = container.querySelectorAll(".mapping-column-card");
    expect(await within(cards[0] as HTMLElement).findByText("2 blank output cells")).toBeVisible();
    expect(within(cards[1] as HTMLElement).queryByText(/blank output cell/)).not.toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByText("This column will be empty in 2 of 3 rows.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Recipient/ }));
    fireEvent.click(within(cards[0] as HTMLElement).getByRole("button", { name: "Add Recipient here" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(within(cards[0] as HTMLElement).queryByText(/blank output cell/)).not.toBeInTheDocument();
  });

  it("refreshes blank counts when only TRUE replacement changes", async () => {
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const mapping = JSON.parse(init.body as string) as { replace_true_with_header: boolean };
      return new Response(JSON.stringify({ blank_cells: [mapping.replace_true_with_header ? 1 : 0], output_rows: 1 }));
    });
    vi.stubGlobal("fetch", fetcher);
    const columns: OutputColumn[] = [{ id: "tag", name: "Tag", source_fields: ["Tag:"],
      transform: { kind: "none", delimiter: null }, normalize: false }];
    const view = render(<Providers><MappingEditor jobId="job-1" headers={["Tag:"]} columns={columns} onChange={() => undefined} /></Providers>);
    expect(await screen.findByText("1 blank output cell")).toBeVisible();
    view.rerender(<Providers><MappingEditor jobId="job-1" headers={["Tag:"]} columns={columns} replaceTrueWithHeader={false} onChange={() => undefined} /></Providers>);
    expect(screen.queryByText("1 blank output cell")).not.toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetcher.mock.calls[1][1].body).replace_true_with_header).toBe(false);
  });

  it("finds and assigns fields, then reorders and removes them", () => {
    const initial: OutputColumn[] = [{ id: "output", name: "People", source_fields: ["First"],
      transform: { kind: "none", delimiter: null }, normalize: false }];
    const { container } = render(<Harness headers={["First", "Last", "Bates"]} initial={initial} />);
    fireEvent.change(screen.getByLabelText("Search available fields"), { target: { value: "last" } });
    expect(container.querySelectorAll(".source-chip")).toHaveLength(1);
    fireEvent.click(container.querySelector(".source-chip")!);
    fireEvent.click(screen.getByRole("button", { name: "Add Last here" }));
    expect(state()[0].source_fields).toEqual(["First", "Last"]);
    expect(state()[0].transform).toEqual({ kind: "delimit", delimiter: "; " });
    fireEvent.click(screen.getByRole("button", { name: "Move Last earlier" }));
    expect(state()[0].source_fields).toEqual(["Last", "First"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove First from People" }));
    expect(state()[0].source_fields).toEqual(["Last"]);
    expect(state()[0].transform.kind).toBe("delimit");
    fireEvent.change(screen.getByLabelText("Search available fields"), { target: { value: "absent" } });
    expect(screen.getByText("No source fields match that search.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add another empty output column" }));
    expect(state()).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Search available fields"), { target: { value: "First" } });
    fireEvent.click(container.querySelector(".source-chip")!);
    fireEvent.click(screen.getAllByRole("button", { name: "Add First here" })[1]);
    expect(state()[1].source_fields).toEqual(["First"]);
    fireEvent.change(screen.getByRole("textbox", { name: "Output column 2" }), { target: { value: "Extra" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Move column left" })[1]);
    expect(state().map((column) => column.name)).toEqual(["Extra", "People"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Move column right" })[0]);
    expect(state().map((column) => column.name)).toEqual(["People", "Extra"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Extra" }));
    expect(state().map((column) => column.name)).toEqual(["People"]);
  });

  it("supports drag assignment, transform choices, separators and normalization", () => {
    const initial: OutputColumn[] = [{ id: "range", name: "Range", source_fields: ["Begin Bates"],
      transform: { kind: "none", delimiter: null }, normalize: false }];
    const { container } = render(<Harness headers={["Begin Bates", "End Bates"]} initial={initial} />);
    const endChip = Array.from(container.querySelectorAll(".source-chip")).find((button) => button.textContent?.includes("End Bates"))!;
    fireEvent.mouseDown(endChip);
    fireEvent.mouseEnter(container.querySelector(".mapping-fields")!);
    fireEvent.mouseUp(container.querySelector(".mapping-fields")!);
    fireEvent.mouseLeave(container.querySelector(".mapping-fields")!);
    expect(state()[0].source_fields).toEqual(["Begin Bates", "End Bates"]);
    expect(state()[0].transform.kind).toBe("shorten_bates");
    const choices = within(screen.getByRole("group", { name: "Transform for Range" }));
    fireEvent.click(choices.getByRole("button", { name: "Join" }));
    expect(state()[0].transform.kind).toBe("delimit");
    fireEvent.click(screen.getByRole("button", { name: "Pipe" }));
    expect(state()[0].transform.delimiter).toBe(" | ");
    fireEvent.click(choices.getByRole("button", { name: "Fill" }));
    expect(state()[0].transform).toEqual({ kind: "fill", delimiter: null });
    fireEvent.click(choices.getByRole("button", { name: "Bates range" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Normalize names and emails" }));
    expect(state()[0]).toMatchObject({ normalize: true, transform: { kind: "shorten_bates" } });
    fireEvent.click(screen.getByRole("button", { name: "Move Begin Bates later" }));
    expect(state()[0].source_fields).toEqual(["End Bates", "Begin Bates"]);
    fireEvent.click(endChip);
    fireEvent.click(screen.getByRole("button", { name: "Add End Bates here" }));
    expect(state()[0].source_fields).toEqual(["End Bates", "Begin Bates"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  });

  it("starts a new column with one source and flags an emptied column", () => {
    const { container } = render(<Harness headers={["Author"]} initial={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add empty output column" }));
    fireEvent.click(container.querySelector(".source-chip")!);
    fireEvent.click(screen.getByRole("button", { name: "Add Author here" }));
    expect(state()[0].transform.kind).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Remove Author from Output column 1" }));
    expect(state()[0].source_fields).toEqual([]);
    expect(screen.getByText("1 column need attention")).toBeInTheDocument();
  });

  it("explains when no source headers are available", () => {
    render(<Harness headers={[]} initial={[]} />);
    expect(screen.getByText("No source fields were detected.")).toBeInTheDocument();
    expect(screen.getByText("Mapping ready")).toBeInTheDocument();
  });
});
