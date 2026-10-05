/**
 * Device maker from a MAC address — the first three bytes (OUI).
 *
 * A short built-in list of the makers an ISP actually meets at the customer
 * end (CPE routers, ONUs, its own MikroTiks). Not a full IEEE registry: an
 * unknown prefix returns null rather than a guess. A "locally administered"
 * address (second hex digit 2, 6, A or E) is a phone or laptop hiding its real
 * MAC, which is worth knowing on its own.
 */

const RAW: Record<string, string> = {
  MikroTik: '4C5E0C 64D154 6C3B6B B869F4 CC2DE0 D4CA6D E48D8C 488F5A 744D28 DC2C6E 18FD74 C4AD34 085531 2CC81B',
  Ubiquiti: '24A43C 44D9E7 687251 788A20 802AA8 B4FBE4 DC9FDB F09FC2 FCECDA 7483C2 E063DA 18E829 0418D6 245A4C 74ACB9',
  'TP-Link': '14CC20 50C7BF 60E327 98DAC4 C04A00 EC086B F4F26D 18A6F7 30B5C2 A42BB0 B04E26 C46E1F 54AF97 0C8063 1C3BF3 5CA6E6 6C5AB0 98254A A842A1 E848B8 3C846A 60A4B7 788CB5 9CA2F4 D807B6 28EE52 503EAA 84D81B B09575 1027F5',
  Huawei: '00E0FC 001882 001E10 04BD70 20F3A3 286ED4 4846FB 4C1FCC 548998 70723C 80B686 8853D4 ACE215 C85195 E0247F F4C714',
  ZTE: '0019C6 001E73 002512 344B50 4C09B4 5422F8 681AB2 8CE081 98F537 C87B5B D0154A F4B8A7',
  Tenda: 'C83A35 502B73 CC2D21 D83214',
  'D-Link': '00055D 000D88 001195 001346 0015E9 00179A 00195B 001B11 001CF0 001E58 002191 0022B0 002401 00265A 1C7EE5 28107B 340804 5CD998 78542E 84C9B2 9094E4 B8A386 C0A0BB C8BE19 CCB255 F07D68 FC7516',
};

const BY_OUI = new Map<string, string>();
for (const [maker, list] of Object.entries(RAW)) {
  for (const oui of list.split(/\s+/)) if (oui) BY_OUI.set(oui, maker);
}

export interface MacInfo {
  mac: string;            // normalised AA:BB:CC:DD:EE:FF
  maker: string | null;   // null when the prefix is not in the list
  privateMac: boolean;    // locally administered (randomised) address
}

/** Normalise any MAC spelling to AA:BB:CC:DD:EE:FF, or null if it is not a MAC. */
export function normaliseMac(raw: string | null | undefined): string | null {
  const hex = String(raw ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(':');
}

export function macInfo(raw: string | null | undefined): MacInfo | null {
  const mac = normaliseMac(raw);
  if (!mac) return null;
  const hex = mac.replace(/:/g, '');
  const second = parseInt(hex[1], 16);
  const privateMac = (second & 0b0010) !== 0;
  return { mac, maker: privateMac ? null : BY_OUI.get(hex.slice(0, 6)) ?? null, privateMac };
}
