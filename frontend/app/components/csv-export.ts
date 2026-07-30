/**
 * Tiny client-side CSV export. Columns are exported with the SAME field names
 * the Import dialog expects, so an exported file re-imports cleanly (handy for
 * moving NAS / packages / pools between panels).
 */
export function downloadCsv(
  filename: string,
  rows: any[],
  columns: { key: string; label: string }[],
) {
  const esc = (v: any) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(",");
  const body = (rows || []).map((r) => columns.map((c) => esc(r[c.key])).join(",")).join("\n");
  const blob = new Blob([head + "\n" + body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
