/**
 * PANEL EXCHANGE FORMAT
 *
 * The canonical subscriber file layout: 46 columns, in this exact order, with
 * these exact header names. It is the shape the wider ISP tooling ecosystem
 * uses, so a file exported here opens correctly elsewhere and a file produced
 * elsewhere loads correctly here.
 *
 * ORDER AND SPELLING ARE PART OF THE CONTRACT. Other systems match on column
 * position as often as on header name, so renaming `full_name` to `fullName`
 * or moving a column would silently break interoperability. Any change to this
 * list is a breaking change to the format.
 *
 * Columns the panel has no data for are still emitted, empty. A file with 40
 * columns is not this format, and a receiving system that expects position 30
 * to be `static_ip` would read the wrong value.
 */

export const PANEL_COLUMNS = [
  'isp_id',
  'branch_id',
  'full_name',
  'username',
  'password',
  'connection_password',
  'identity',
  'phone',
  'connection_type',
  'nas_id',
  'salesperson_id',
  'package_id',
  'expiration_date',
  'join_date',
  'previous_balance',
  'email',
  'address',
  'subarea_id',
  'area_id',
  'city_id',
  'province_id',
  'country_id',
  'department_id',
  'latitude',
  'longitude',
  'profile_status',
  'sms_status',
  'mac_lock_status',
  'mac_address',
  'static_ip',
  'total_volume',
  'used_volume',
  'total_session',
  'used_session',
  'discount_type',
  'discount',
  'box_number',
  'box_address',
  'switch_board',
  'switch_port',
  'electric_socket',
  'cable_type',
  'uplink_port',
  'fiber_code',
  'fiber_color',
  'onu_note',
] as const;

export type PanelColumn = (typeof PANEL_COLUMNS)[number];

/**
 * Numeric codes used by the format.
 *
 * These are integers on the wire, not words. Mapping them in one place means
 * the import and the export cannot drift apart — the usual way a round trip
 * quietly corrupts data.
 */
export const CONNECTION_TYPE: Record<string, string> = {
  '1': 'FTTH',
  '2': 'ADSL',
  '3': 'G4_LTE',
  '4': 'WIRELESS',
  '5': 'FIBER',
};
export const CONNECTION_TYPE_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(CONNECTION_TYPE).map(([k, v]) => [v, k]),
);

export const PROFILE_STATUS: Record<string, string> = {
  '0': 'INACTIVE',
  '1': 'INACTIVE',
  '2': 'ACTIVE',
  '3': 'EXPIRED',
  '4': 'SUSPENDED',
};
export const PROFILE_STATUS_CODE: Record<string, string> = {
  INACTIVE: '1',
  ACTIVE: '2',
  EXPIRED: '3',
  SUSPENDED: '4',
};

export const DISCOUNT_TYPE: Record<string, string> = {
  '': 'NONE',
  '0': 'NONE',
  '1': 'PERCENTAGE',
  '2': 'FIXED',
};
export const DISCOUNT_TYPE_CODE: Record<string, string> = {
  NONE: '',
  PERCENTAGE: '1',
  FIXED: '2',
};

/**
 * Dates travel as `M/D/YYYY HH:mm` — US ordering, no leading zeros.
 *
 * This is genuinely ambiguous for the first twelve days of a month: 8/9/2026
 * could be August 9th or September 8th. The format specifies month-first, so
 * that is what is parsed and emitted, and no attempt is made to be clever
 * about it — guessing would corrupt exactly the dates hardest to notice.
 */
export function parsePanelDate(v?: string | null): Date | null {
  const s = String(v ?? '').trim();
  if (!s) return null;

  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
  if (m) {
    const d = new Date(
      Number(m[3]), Number(m[1]) - 1, Number(m[2]),
      m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0,
    );
    return isNaN(d.getTime()) ? null : d;
  }

  // ISO and other recognisable forms are accepted on import so a file that has
  // been through Excel — which loves to reformat dates — still loads.
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function formatPanelDate(d?: Date | string | null): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Booleans are 1/0 on the wire. */
export const flag = (v: boolean | null | undefined) => (v ? '1' : '0');
export const parseFlag = (v?: string | null) => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
};

/** Blank means "not set" and must stay blank — never 0, never "null". */
export const str = (v: any): string =>
  v === null || v === undefined || v === '' ? '' : String(v);
export const num = (v: any): string =>
  v === null || v === undefined || v === '' ? '' : String(v);
