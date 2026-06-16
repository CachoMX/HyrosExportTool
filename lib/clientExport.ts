// Browser-side export helpers (CSV without deps, XLSX via dynamically-imported SheetJS).

import { ExportRow, ROW_HEADERS } from "./types";

type Header = (typeof ROW_HEADERS)[number];

/** Columns that have at least one non-empty value across the rows (drops all-empty columns). */
export function visibleHeaders(rows: ExportRow[]): Header[] {
  return ROW_HEADERS.filter((h) => rows.some((r) => String(r[h.key] ?? "") !== ""));
}

function csvCell(v: string): string {
  const needsQuote = /[",\n]/.test(v);
  const escaped = v.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

export function rowsToCsv(rows: ExportRow[], headers: Header[]): string {
  const head = headers.map((h) => csvCell(h.label)).join(",");
  const body = rows.map((r) => headers.map((h) => csvCell(String(r[h.key] ?? ""))).join(",")).join("\n");
  return head + "\n" + body;
}

export function download(filename: string, content: BlobPart, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function exportCsv(rows: ExportRow[], filename: string, headers: Header[] = visibleHeaders(rows)) {
  download(filename, "﻿" + rowsToCsv(rows, headers), "text/csv;charset=utf-8");
}

export async function exportXlsx(
  rows: ExportRow[],
  filename: string,
  sheetName: string,
  headers: Header[] = visibleHeaders(rows)
) {
  const XLSX = await import("xlsx");
  const aoa = [headers.map((h) => h.label), ...rows.map((r) => headers.map((h) => String(r[h.key] ?? "")))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, filename);
}
