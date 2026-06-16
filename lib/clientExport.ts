// Browser-side export helpers (CSV without deps, XLSX via dynamically-imported SheetJS).

import { ExportRow, ROW_HEADERS } from "./types";

function csvCell(v: string): string {
  const needsQuote = /[",\n]/.test(v);
  const escaped = v.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

export function rowsToCsv(rows: ExportRow[]): string {
  const head = ROW_HEADERS.map((h) => csvCell(h.label)).join(",");
  const body = rows.map((r) => ROW_HEADERS.map((h) => csvCell(String(r[h.key] ?? ""))).join(",")).join("\n");
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

export function exportCsv(rows: ExportRow[], filename: string) {
  download(filename, "﻿" + rowsToCsv(rows), "text/csv;charset=utf-8");
}

export async function exportXlsx(rows: ExportRow[], filename: string, sheetName: string) {
  const XLSX = await import("xlsx");
  const aoa = [
    ROW_HEADERS.map((h) => h.label),
    ...rows.map((r) => ROW_HEADERS.map((h) => String(r[h.key] ?? ""))),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, filename);
}
