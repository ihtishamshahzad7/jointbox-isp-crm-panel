/**
 * Deterministic IPv6 prefix allocation.
 *
 * Given a base prefix and a per-subscriber index, this computes a unique
 * sub-prefix by placing the index into the subnet bits. It is stateless — the
 * same subscriber always gets the same prefix, so there's no allocation table
 * to keep in sync and no risk of two customers colliding.
 *
 *   allocate("2401:db8:1::", 48, 64, 8)  ->  "2401:db8:1:8::/64"
 *   allocate("2401:db8:100::", 40, 56, 8) -> "2401:db8:100:800::/56"
 */

function parseIpv6(addr: string): bigint {
  let a = addr.trim();
  if (a.includes('::')) {
    const [head, tail] = a.split('::');
    const h = head ? head.split(':').filter(Boolean) : [];
    const t = tail ? tail.split(':').filter(Boolean) : [];
    const fill = 8 - (h.length + t.length);
    a = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t].join(':');
  }
  const groups = a.split(':');
  if (groups.length !== 8) throw new Error(`Invalid IPv6 base: ${addr}`);
  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(parseInt(g || '0', 16) & 0xffff);
  return v;
}

function formatIpv6(v: bigint): string {
  const g: string[] = [];
  // g[0] is the leftmost (highest) group, g[7] the lowest.
  for (let i = 0; i < 8; i++) g[i] = ((v >> BigInt((7 - i) * 16)) & 0xffffn).toString(16);
  // find longest run of zero groups to compress
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (g[i] === '0') {
      if (curStart < 0) { curStart = i; curLen = 1; } else curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else { curStart = -1; curLen = 0; }
  }
  if (bestLen < 2) return g.join(':');
  const head = g.slice(0, bestStart).join(':');
  const tail = g.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

/**
 * Allocate a sub-prefix of size `allocBits` from `base`/`baseBits` for `index`.
 * Returns "prefix/allocBits" or null if the config is invalid/out of range.
 */
export function allocateIpv6(base: string, baseBits: number, allocBits: number, index: number): string | null {
  try {
    if (allocBits <= baseBits || allocBits > 128 || baseBits < 0) return null;
    const subnetBits = allocBits - baseBits;
    const maxIndex = subnetBits >= 63 ? Number.MAX_SAFE_INTEGER : (2 ** subnetBits) - 1;
    if (index < 0 || index > maxIndex) return null;
    const baseVal = parseIpv6(base);
    // Align base to its network boundary, then add index in the subnet field.
    const hostBits = BigInt(128 - allocBits);
    const network = (baseVal >> hostBits) << hostBits; // clears host bits
    const prefixVal = network + (BigInt(index) << hostBits);
    return `${formatIpv6(prefixVal)}/${allocBits}`;
  } catch {
    return null;
  }
}

/** Read the IPv6 auto-allocation policy from env. Off unless a base is set. */
export function ipv6AutoConfig() {
  const framedBase = (process.env.IPV6_FRAMED_BASE || '').trim();
  const delegatedBase = (process.env.IPV6_DELEGATED_BASE || '').trim();
  return {
    enabled: !!framedBase || !!delegatedBase,
    framedBase,
    framedBaseBits: Number(process.env.IPV6_FRAMED_BASE_BITS || 48),
    framedSize: Number(process.env.IPV6_FRAMED_SIZE || 64),
    delegatedBase,
    delegatedBaseBits: Number(process.env.IPV6_DELEGATED_BASE_BITS || 40),
    delegatedSize: Number(process.env.IPV6_DELEGATED_SIZE || 56),
  };
}
