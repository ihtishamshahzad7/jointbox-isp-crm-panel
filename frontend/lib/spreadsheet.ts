/**
 * Reading uploaded spreadsheets in the browser.
 *
 * This replaces SheetJS (`xlsx` 0.18.5 on npm), which has unpatched
 * prototype-pollution and ReDoS advisories and is no longer published to npm —
 * and these code paths parse files a user uploads, which is exactly where those
 * advisories bite. `read-excel-file` reads .xlsx; CSV/TSV is parsed here.
 *
 * Old binary Excel (.xls, Excel 97–2003) is not supported by any maintained
 * small reader. Rather than guessing, it is refused with a clear message.
 */

export type Table = string[][];

const XLS_REFUSED =
  "Old .xls files (Excel 97–2003) can't be read. Open it in Excel or LibreOffice and save as .xlsx or CSV, then upload that.";

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF), or TSV when tab-separated. */
export function parseDelimited(text: string): Table {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows: Table = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** First sheet of an .xlsx, or the rows of a CSV/TSV/TXT file, as text cells. */
export async function readTableFile(file: File): Promise<Table> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xls")) throw new Error(XLS_REFUSED);
  if (name.endsWith(".xlsx")) {
    const { readSheet } = await import("read-excel-file/browser");
    const data = await readSheet(file);
    return data.map((r) => r.map(cellText)).filter((r) => r.some((c) => c.trim() !== ""));
  }
  return parseDelimited(await file.text());
}

/** Rows back to CSV, quoting only where needed — the import screens take CSV text. */
export function tableToCsv(rows: Table): string {
  const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(q).join(",")).join("\n");
}

/** First row as headers; every later row as an object (missing cells → ""). */
export function tableToObjects(rows: Table): Record<string, string>[] {
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
