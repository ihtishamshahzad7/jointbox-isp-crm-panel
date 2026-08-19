/**
 * TEMPORARY DIAGNOSTIC — fake SNMPv2c agent (RouterOS-like) used to
 * reproduce the "Discover interfaces hangs" bug against the real
 * NdmSnmpService without needing the customer device or a router.
 * Not committed. Delete after diagnosis.
 *
 * Behaviors (env):
 *   PORT=1161                listen port
 *   FAKE_STALL_AFTER=N       stop replying to GETBULK after N per column walk
 *   FAKE_OK=1 (default)      behave like a normal RouterOS device
 */
const dgram = require("dgram");

// ── OID tree ─────────────────────────────────────────────────────────
const IF = "1.3.6.1.2.1.2.2.1";   // ifTable
const IFX = "1.3.6.1.2.1.31.1.1.1"; // ifXTable
const N = 37; // interfaces (CRS317 has 16+2 but user reports 37)
const TREE = new Map(); // oid -> [type, Buffer]

function put(col, idx, type, value) {
  TREE.set(`${col}.${idx}`, [type, value]);
}
function putScalar(oid, type, value) {
  TREE.set(oid, [type, value]);
}

// scalars
putScalar("1.3.6.1.2.1.1.1.0", 4, Buffer.from("RouterOS CRS317-1G-16S+"));
putScalar("1.3.6.1.2.1.1.5.0", 4, Buffer.from("C30"));
putScalar("1.3.6.1.2.1.1.3.0", 0x43, uint(9000000)); // sysUpTime ticks
putScalar("1.3.6.1.2.1.2.1.0", 0x42, uint(N)); // ifNumber

const names = [];
for (let i = 1; i <= N; i++) {
  const n = i <= 16 ? `ether${i}` : i === 17 ? "sfp-sfpplus1" : i === 18 ? "sfp-sfpplus2" : `bridge${i}`;
  names.push(n);
  const admin = i === 4 || i === 12 ? 2 : 1;       // a couple administratively down
  const oper = admin === 2 ? 2 : (i >= 29 ? 2 : 1); // some link-down
  put(IF + ".1", i, 0x02, uint(i));                       // ifIndex
  put(IF + ".2", i, 4, Buffer.from(n));                    // ifDescr
  put(IF + ".3", i, 2, uint(1500));
  put(IF + ".4", i, 4, Buffer.from("ethernetCsmacd"));
  put(IF + ".6", i, 4, macFor(i));                         // physAddress
  put(IF + ".7", i, 0x02, uint(admin));                    // ifAdminStatus
  put(IF + ".8", i, 0x02, uint(oper));                     // ifOperStatus
  put(IF + ".9", i, 0x43, uint(42 + i));                   // ifLastChange
  put(IF + ".10", i, 0x41, uint((123456789 + i * 977) % 4294967295)); // inOctets 32
  put(IF + ".11", i, 0x41, uint(10000 + i));
  put(IF + ".13", i, 0x41, uint(i * 3));
  put(IF + ".14", i, 0x41, uint(i));
  put(IF + ".16", i, 0x41, uint((9876543210 + i) % 4294967295)); // outOctets 32
  put(IF + ".17", i, 0x41, uint(20000 + i));
  put(IF + ".19", i, 0x41, uint(i * 2));
  put(IF + ".20", i, 0x41, uint(i * 7));
  put(IFX + ".1", i, 4, Buffer.from(n));                    // ifName
  put(IFX + ".6", i, 0x46, uint64(900000000000n + BigInt(i) * 12345n)); // ifHCInOctets
  put(IFX + ".7", i, 0x46, uint64(100000n + BigInt(i)));
  put(IFX + ".10", i, 0x46, uint64(7000000000000n + BigInt(i) * 999n));
  put(IFX + ".11", i, 0x46, uint64(200000n + BigInt(i)));
  put(IFX + ".15", i, 0x42, uint(i === 17 || i === 18 ? 10000 : 1000));  // ifHighSpeed Mbps
  put(IFX + ".18", i, 4, Buffer.from(i === 1 ? "WAN" : i === 17 ? "UPLINK" : ""));
}

const sorted = [...TREE.keys()].sort((a, b) => cmpSuffix(a, b));

// ── tiny BER ────────────────────────────────────────────────────────
function tlv(tag, content) {
  const len = content.length;
  let lb;
  if (len < 128) lb = Buffer.from([len]);
  else lb = Buffer.from([0x81, len]);
  return Buffer.concat([Buffer.from([tag]), lb, content]);
}
function seq(...parts) { return tlv(0x30, Buffer.concat(parts)); }
function int(v) {
  let b = bigintToBuf(BigInt(v));
  return tlv(0x02, b);
}
function uint(v) { return tlv(0x02, bigintToBuf(BigInt(v))); }
function uint64(v) { return tlv(0x46, bigintToBuf(BigInt(v))); }
function oct(s) { return tlv(0x04, Buffer.isBuffer(s) ? s : Buffer.from(s)); }
function oidTlv(o) {
  const parts = o.split(".").map(Number);
  const body = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack = [v & 0x7f];
    v >>= 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>= 7; }
    body.push(...stack);
  }
  return tlv(0x06, Buffer.from(body));
}
function bigintToBuf(v) {
  if (v < 0) throw new Error("neg");
  if (v === 0n) return Buffer.from([0]);
  const bytes = [];
  while (v > 0n) { bytes.unshift(Number(v & 0xffn)); v >>= 8n; }
  if (bytes[0] & 0x80) bytes.unshift(0); // keep positive
  return Buffer.from(bytes);
}
function macFor(i) {
  const b = Buffer.alloc(6);
  b[0] = 0x74; b[1] = 0x4d; b[2] = 0x28;
  b[3] = (i >> 8) & 0xff; b[4] = i & 0xff; b[5] = 0x01;
  return b;
}
function cmpSuffix(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  const m = Math.max(pa.length, pb.length);
  for (let i = 0; i < m; i++) {
    const x = pa[i] === undefined ? -1 : pa[i];
    const y = pb[i] === undefined ? -1 : pb[i];
    if (x !== y) return x - y;
  }
  return 0;
}

// ── BER parse ───────────────────────────────────────────────────────
class R {
  constructor(buf) { this.b = buf; this.p = 0; }
  tag() { const t = this.b[this.p++]; return t; }
  len() {
    let l = this.b[this.p++];
    if (l & 0x80) { const n = l & 0x7f; l = 0; for (let i = 0; i < n; i++) l = l * 256 + this.b[this.p++]; }
    return l;
  }
  val() { const l = this.len(); const v = this.b.subarray(this.p, this.p + l); this.p += l; return v; }
  int() { const v = this.val(); let n = 0n; for (const x of v) n = n * 256n + BigInt(x); return Number(n); }
  oid() {
    const v = this.val();
    const nums = [];
    let acc = 0;
    for (let i = 0; i < v.length; i++) {
      const byte = v[i];
      if (i === 0) {
        if (byte < 40) nums.push(0, byte);
        else if (byte < 80) nums.push(1, byte - 40);
        else nums.push(2, byte - 80);
        continue;
      }
      acc = acc * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) { nums.push(acc); acc = 0; }
    }
    return nums.join(".");
  }
  rb() { return this.b.subarray(this.p, this.b.length); }
}

// ── agent ───────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 1161);
const STALL_AFTER = Number(process.env.FAKE_STALL_AFTER || 0);
let bulkCount = 0;

const sock = dgram.createSocket("udp4");
let logSend = 0;
sock.on("message", (msg, rinfo) => {
  try {
    if (process.env.FAKE_LOG) console.log(`[fake-agent] RX ${msg.length}B from ${rinfo.address}:${rinfo.port}`);
    const r = new R(msg);
    if (r.tag() !== 0x30) return;
    r.val(); // seq length
    r.tag(); r.int(); // version
    r.tag(); r.val(); // community
    const pduTag = r.tag();
    const pduLen = r.len();
    const pduEnd = r.p + pduLen;
    const reqId = r.int();

    if (pduTag === 0xa0) { // GET
      r.int(); r.int(); // err status/index
      const reqOids = [];
      r.tag(); r.val(); // varbind list
      while (r.p < pduEnd) {
        r.tag(); const l = r.len(); const end = r.p + l;
        if (end <= r.p) break;
        r.tag(); const oid = r.oid();
        reqOids.push(oid);
        r.p = end;
      }
      sock.send(build(pduTag, reqId, answerGet(reqOids)), rinfo.port, rinfo.address);
      return;
    }

    if (pduTag === 0xa5) { // GETBULK
      const nonRep = r.int();
      const maxRep = r.int();
      const reqOids = [];
      r.tag(); r.val(); // varbind list
      while (r.p < pduEnd) {
        r.tag(); const l = r.len(); const end = r.p + l;
        if (end <= r.p) break;
        r.tag(); const oid = r.oid();
        reqOids.push(oid);
        r.p = end;
      }
      // RouterOS-style stall: drop bulk replies entirely after threshold
      bulkCount++;
      if (STALL_AFTER > 0 && bulkCount > STALL_AFTER) {
        console.log(`[fake-agent] STALL: dropping GETBULK #${bulkCount} (threshold ${STALL_AFTER})`);
        return; // no response — like a dead/rate-limited device
      }
      const out = [];
      for (const base of reqOids) {
        let n = 0;
        for (const o of sorted) {
          if (cmpSuffix(o, base) > 0 && n < maxRep) {
            const [t, v] = TREE.get(o);
            out.push({ oid: o, tlv: oidTlv(o), valTlv: valueTlv(t, v) });
            n++;
            if (n >= maxRep) break;
          }
        }
        // after exhausting the tree (or before it) append endOfMibView
        if (n < maxRep) out.push({ tlv2: true });
      }
      sock.send(build(pduTag, reqId, out), rinfo.port, rinfo.address);
      return;
    }
  } catch (e) {
    // incomplete parse — diagnostic only
  }
});

function answerGet(oids) {
  return oids.map((o) => {
    const t = TREE.get(o);
    if (!t) return { tlv2: true };
    const [ty, v] = t;
    return { oid: o, tlv: oidTlv(o), valTlv: valueTlv(ty, v) };
  });
}

function valueTlv(type, value) {
  if (type === 4) return tlv(0x04, value);
  if (type === 0x02) return tlv(0x02, value);
  if (type === 0x41) return tlv(0x41, value);
  if (type === 0x42) return tlv(0x42, value);
  if (type === 0x43) return tlv(0x43, value);
  if (type === 0x46) return tlv(0x46, value);
  return tlv(0x04, Buffer.from(String(value)));
}

function build(pduTag, reqId, vbs) {
  const list = [];
  for (const vb of vbs) {
    if (vb.tlv2) list.push(tlv(0x30, Buffer.concat([oidTlv("1.3.6.1.6.3.1.1.5.1"), Buffer.from([0x02, 0x01, 0x00])])));
    else list.push(tlv(0x30, Buffer.concat([vb.tlv, vb.valTlv])));
  }
  const pdu = tlv(pduTag, Buffer.concat([int(reqId), tlv(0x02, Buffer.from([0])), tlv(0x02, Buffer.from([0])), tlv(0x30, Buffer.concat(list))]));
  const msg = tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([1])), oct("public"), pdu]));
  return msg;
}

sock.bind(PORT, () => console.log(`[fake-agent] SNMPv2c RouterOS-like agent on udp :${PORT} (${N} interfaces, stallAfter=${STALL_AFTER})`));