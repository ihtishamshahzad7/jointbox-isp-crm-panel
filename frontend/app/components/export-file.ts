/**
 * File writers for exports.
 *
 * The old "Excel" export wrote a CSV and named it .csv regardless — the format
 * dropdown did nothing. These are two genuinely different files:
 *
 *  CSV   — universal, opens anywhere. Written with a UTF-8 BOM because Excel
 *          otherwise mangles Urdu names and any non-ASCII text into mojibake.
 *
 *  EXCEL — SpreadsheetML (Excel XML). A real spreadsheet with typed cells,
 *          a bold frozen header row and sized columns. Chosen over .xlsx
 *          because .xlsx is a ZIP container that would need a dependency,
 *          while this is plain XML every version of Excel opens natively.
 */

type Cell = string | number | null | undefined;

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 10);

/** Dates arrive as ISO strings; spreadsheets want something readable. */
function normalise(v: Cell): string | number {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  const s = String(v);
  // ISO timestamp → local date. Matches what the operator sees in the panel.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toLocaleDateString();
  }
  return s;
}

export function exportCsv(headers: string[], rows: Cell[][], name = "subscribers") {
  const esc = (v: Cell) => {
    const s = String(normalise(v));
    // Quote anything containing a delimiter, quote or newline; double inner quotes.
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\r\n");

  // The BOM is what makes Excel read this as UTF-8. Without it, Urdu and
  // accented characters open as garbage.
  download(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }), `${name}-${stamp()}.csv`);
}

export function exportExcel(headers: string[], rows: Cell[][], name = "subscribers", title = "Subscribers") {
  const xmlEsc = (v: Cell) =>
    String(normalise(v))
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      // Control characters are illegal in XML and would corrupt the file.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

  const cell = (v: Cell) => {
    const n = normalise(v);
    // Numeric cells are typed so Excel can sum and sort them. Strings that
    // merely look numeric (phone numbers, CNICs) stay text — otherwise Excel
    // strips their leading zeros.
    const isNum = typeof n === "number" && Number.isFinite(n);
    return isNum
      ? `<Cell><Data ss:Type="Number">${n}</Data></Cell>`
      : `<Cell><Data ss:Type="String">${xmlEsc(n)}</Data></Cell>`;
  };

  const widths = headers.map((h, i) => {
    const longest = Math.max(h.length, ...rows.slice(0, 200).map((r) => String(normalise(r[i])).length));
    return Math.min(300, Math.max(70, longest * 7));
  });

  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
  <Title>${xmlEsc(title)}</Title>
  <Created>${new Date().toISOString()}</Created>
 </DocumentProperties>
 <Styles>
  <Style ss:ID="hdr">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#6C3CE1" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Center"/>
   <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/></Borders>
  </Style>
 </Styles>
 <Worksheet ss:Name="${xmlEsc(title).slice(0, 31)}">
  <Table>
   ${widths.map((w) => `<Column ss:Width="${w}"/>`).join("")}
   <Row ss:StyleID="hdr" ss:Height="20">${headers.map((h) => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${xmlEsc(h)}</Data></Cell>`).join("")}</Row>
   ${rows.map((r) => `<Row>${r.map(cell).join("")}</Row>`).join("\n   ")}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <FreezePanes/><FrozenNoSplit/>
   <SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane>
   <ActivePane>2</ActivePane>
  </WorksheetOptions>
 </Worksheet>
</Workbook>`;

  download(
    new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8;" }),
    `${name}-${stamp()}.xls`,
  );
}
