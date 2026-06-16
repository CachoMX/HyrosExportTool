"use client";

import { useMemo, useRef, useState } from "react";
import { ExportRow, ReportType, ROW_HEADERS, StreamMessage } from "@/lib/types";
import { exportCsv, exportXlsx, visibleHeaders } from "@/lib/clientExport";

const REPORTS: { key: ReportType; label: string }[] = [
  { key: "sales", label: "Sales" },
  { key: "calls", label: "Calls" },
  { key: "leads", label: "Leads" },
];

const PREVIEW_LIMIT = 200;

function tzOffset(): string {
  const off = -new Date().getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

export default function Page() {
  const [apiKey, setApiKey] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [report, setReport] = useState<ReportType>("sales");
  const [enrichFull, setEnrichFull] = useState(true);

  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<ExportRow[]>([]);
  const [phase, setPhase] = useState("");
  const [fetched, setFetched] = useState(0);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const canRun = apiKey.trim() && fromDate && toDate && !running;

  const headers = useMemo(() => visibleHeaders(rows), [rows]);
  const hiddenCount = ROW_HEADERS.length - headers.length;

  const pct = useMemo(() => {
    if (done) return 100;
    if (total && total > 0) return Math.min(99, Math.round((fetched / total) * 100));
    return undefined;
  }, [fetched, total, done]);

  async function run() {
    if (!canRun) return;
    setRunning(true);
    setRows([]);
    setWarnings([]);
    setError("");
    setDone(false);
    setFetched(0);
    setTotal(undefined);
    setPhase("Starting…");

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const collected: ExportRow[] = [];

    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          fromDate: `${fromDate}T00:00:00${tzOffset()}`,
          toDate: `${toDate}T23:59:59${tzOffset()}`,
          report,
          enrich: enrichFull ? "full" : "direct",
        }),
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        throw new Error(t || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as StreamMessage;
          handle(msg, collected);
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e?.message || String(e));
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function handle(msg: StreamMessage, collected: ExportRow[]) {
    switch (msg.type) {
      case "progress":
        setPhase(msg.detail ? `${msg.phase} — ${msg.detail}` : msg.phase);
        setFetched(msg.fetched);
        setTotal(msg.total);
        break;
      case "rows":
        collected.push(...msg.rows);
        setRows(collected.slice()); // shallow copy to trigger render
        break;
      case "warn":
        setWarnings((w) => [...w, msg.message]);
        break;
      case "done":
        setDone(true);
        setPhase(`Done — ${msg.total} record(s)`);
        break;
      case "error":
        setError(msg.message);
        break;
    }
  }

  function cancel() {
    abortRef.current?.abort();
    setRunning(false);
    setPhase("Cancelled");
  }

  const baseName = `hyros-${report}-${fromDate}_to_${toDate}`;

  return (
    <div className="container">
      <div className="header">
        <svg className="logo" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <path d="M27.21 46.37H17.63V17.63h9.58V46.37ZM20.58 30.53v10.32h3.68V30.53h-3.68Z" fill="#50F5AC" />
          <path d="M46.37 46.37h-9.58V17.63h9.58V46.37ZM39.74 23.16v10.32h3.68V23.16h-3.68Z" fill="#50F5AC" />
          <path d="M14.68 34.21H11v10.32h3.68V34.21ZM53 19.47h-3.68v10.32H53V19.47ZM33.84 26.84h-3.68v10.32h3.68V26.84Z" fill="#50F5AC" />
        </svg>
        <h1>Hyros Export Tool</h1>
      </div>
      <p className="subtitle">
        Export <b>sales</b>, <b>calls</b> and <b>leads</b> by email with origin source, last source and full
        campaign / ad&nbsp;set / ad attribution.
      </p>

      <div className="panel">
        <div className="grid">
          <div>
            <label>Hyros API Key</label>
            <input
              type="password"
              placeholder="Paste your Hyros API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label>Report</label>
            <div className="segmented">
              {REPORTS.map((r) => (
                <button key={r.key} className={report === r.key ? "active" : ""} onClick={() => setReport(r.key)} type="button">
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label>From date</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div>
            <label>To date</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        </div>

        <div className="row mt">
          <label className="checkbox" style={{ marginBottom: 0 }}>
            <input type="checkbox" checked={enrichFull} onChange={(e) => setEnrichFull(e.target.checked)} />
            Full enrichment (resolve campaign / ad set names & IDs via the attribution report)
          </label>
          <div className="spacer" />
          {running ? (
            <button className="ghost" onClick={cancel} type="button">
              Cancel
            </button>
          ) : null}
          <button className="primary" onClick={run} disabled={!canRun} type="button">
            {running ? "Generating…" : "Generate report"}
          </button>
        </div>

        {(running || done || error) && (
          <div className="progress">
            <div className="bar">
              <div style={{ width: `${pct ?? 40}%`, opacity: pct === undefined ? 0.6 : 1 }} />
            </div>
            <div className="phase">
              {phase}
              {fetched ? ` · ${fetched.toLocaleString()}${total ? ` / ${total.toLocaleString()}` : ""} fetched` : ""}
            </div>
          </div>
        )}
        {warnings.map((w, i) => (
          <div className="warn" key={i}>
            ⚠ {w}
          </div>
        ))}
        {error && <div className="error">✕ {error}</div>}
      </div>

      {rows.length > 0 && (
        <div className="mt">
          <div className="stats">
            <div className="stat">
              <div className="n">{rows.length.toLocaleString()}</div>
              <div className="l">Rows</div>
            </div>
            <div className="stat">
              <div className="n">{new Set(rows.map((r) => r.email).filter(Boolean)).size.toLocaleString()}</div>
              <div className="l">Unique emails</div>
            </div>
            <div className="spacer" />
            <button className="ghost" onClick={() => exportCsv(rows, `${baseName}.csv`, headers)} type="button">
              ⬇ Export CSV
            </button>
            <button className="ghost" onClick={() => exportXlsx(rows, `${baseName}.xlsx`, report, headers)} type="button">
              ⬇ Export XLSX
            </button>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {headers.map((h) => (
                    <th key={h.key}>{h.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, PREVIEW_LIMIT).map((r, i) => (
                  <tr key={i}>
                    {headers.map((h) => (
                      <td key={h.key} title={String(r[h.key] ?? "")}>
                        {String(r[h.key] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > PREVIEW_LIMIT && (
            <p className="note">
              Showing first {PREVIEW_LIMIT} of {rows.length.toLocaleString()} rows. Export to get the full data set.
            </p>
          )}
          {hiddenCount > 0 && (
            <p className="note">
              {hiddenCount} column{hiddenCount > 1 ? "s" : ""} hidden because{" "}
              {hiddenCount > 1 ? "they were" : "it was"} empty for every row (e.g. Campaign / Ad&nbsp;Set ID when your
              Hyros account doesn&apos;t expose them). They reappear automatically for accounts/reports that have the
              data.
            </p>
          )}
        </div>
      )}

      <p className="note mt">
        The API Key is sent only to this app&apos;s own server to call Hyros and is never stored. Rate limits (30/s,
        1000/min) are respected automatically. <b>Sales</b> &amp; <b>calls</b> carry full ad attribution (origin/last
        source, ad name, ad id, ad&nbsp;set name; ad&nbsp;set id and campaign columns fill only when your ad account
        exposes them in Hyros). For <b>leads</b>, source is resolved from each lead&apos;s journey (their sales /
        calls / carts) — Hyros only exposes an ad source once a lead converts, so leads that haven&apos;t converted yet
        show no source.
      </p>
    </div>
  );
}
