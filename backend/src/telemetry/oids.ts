/**
 * SNMP OIDs and signal thresholds for link tracing.
 *
 * The standard IF-MIB (interface table) works on EVERY SNMP device — MikroTik,
 * switch, or OLT — so port up/down, errors and traffic counters are universal.
 *
 * ONT/ONU optical power lives in vendor-private MIBs, so those are grouped by
 * DeviceType. When an OLT's OIDs aren't known (or the walk returns nothing) the
 * poller simply skips signal collection for it and still reports interface
 * status — nothing breaks. The bases below are the commonly-published ones and
 * are safe to tune per deployment.
 */

// ---- Standard IF-MIB (RFC 1213 / IF-MIB) — every device ----
export const IF = {
  descr: '1.3.6.1.2.1.2.2.1.2', // ifDescr
  operStatus: '1.3.6.1.2.1.2.2.1.8', // ifOperStatus  1=up 2=down
  inErrors: '1.3.6.1.2.1.2.2.1.14', // ifInErrors
  outErrors: '1.3.6.1.2.1.2.2.1.20', // ifOutErrors
  inOctets: '1.3.6.1.2.1.2.2.1.10', // ifInOctets
  outOctets: '1.3.6.1.2.1.2.2.1.16', // ifOutOctets
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysDescr: '1.3.6.1.2.1.1.1.0',
};

export const IF_OPER_UP = 1;

/**
 * 64-bit interface counters (IF-MIB HC group). A 32-bit ifInOctets wraps every
 * ~34 seconds on a 1 Gbps link, which makes rate maths guesswork; the HC
 * counters wrap in centuries. We read these first and fall back to the 32-bit
 * pair only when a device does not implement them.
 */
export const IF_HC = {
  inOctets: '1.3.6.1.2.1.31.1.1.1.6',   // ifHCInOctets
  outOctets: '1.3.6.1.2.1.31.1.1.1.10', // ifHCOutOctets
  name: '1.3.6.1.2.1.31.1.1.1.1',       // ifName (short name, e.g. "ether1")
  alias: '1.3.6.1.2.1.31.1.1.1.18',     // ifAlias (operator description)
  speed: '1.3.6.1.2.1.31.1.1.1.15',     // ifHighSpeed, in Mbps
};

export const IF_EXTRA = {
  adminStatus: '1.3.6.1.2.1.2.2.1.7',   // ifAdminStatus 1=up 2=down
  inDiscards: '1.3.6.1.2.1.2.2.1.13',
  outDiscards: '1.3.6.1.2.1.2.2.1.19',
  physAddress: '1.3.6.1.2.1.2.2.1.6',   // MAC
};

/**
 * DEVICE-HEALTH PROFILES — CPU, memory, uptime and temperature.
 *
 * These live in vendor-private MIBs, so they are grouped by device type with a
 * generic fallback (HOST-RESOURCES / UCD-SNMP), which covers most Linux and
 * many appliances. A profile only needs the OIDs its vendor actually answers;
 * anything missing is skipped and simply not graphed, so an unknown device
 * still reports interfaces without erroring.
 *
 *   kind 'gauge'   → value used as-is (already a percentage)
 *   kind 'ratio'   → used / total * 100 (two OIDs)
 *   kind 'ticks'   → sysUpTime in hundredths of a second → seconds
 *   scale          → multiplier applied before storing (e.g. 0.1 for deci-units)
 */
export type HealthOid =
  | { kind: 'gauge'; oid: string; scale?: number; walkAvg?: boolean }
  | { kind: 'ratio'; usedOid: string; totalOid: string }
  | { kind: 'ticks'; oid: string };

export interface HealthProfile {
  label: string;
  cpu?: HealthOid;
  memory?: HealthOid;
  uptime?: HealthOid;
  temperature?: HealthOid;
}

export const HEALTH_PROFILES: Record<string, HealthProfile> = {
  MIKROTIK: {
    label: 'MikroTik RouterOS',
    // hrProcessorLoad is a table (one row per core) — average the walk.
    cpu: { kind: 'gauge', oid: '1.3.6.1.2.1.25.3.3.1.2', walkAvg: true },
    // mtxrHlUsedMemory / mtxrHlTotalMemory (bytes)
    memory: { kind: 'ratio', usedOid: '1.3.6.1.4.1.14988.1.1.1.4.0', totalOid: '1.3.6.1.4.1.14988.1.1.1.5.0' },
    uptime: { kind: 'ticks', oid: '1.3.6.1.2.1.1.3.0' },
    // mtxrHlTemperature — deci-degrees Celsius.
    temperature: { kind: 'gauge', oid: '1.3.6.1.4.1.14988.1.1.3.10.0', scale: 0.1 },
  },
  CISCO: {
    label: 'Cisco IOS',
    cpu: { kind: 'gauge', oid: '1.3.6.1.4.1.9.9.109.1.1.1.1.7.1' }, // 5-min avg
    memory: { kind: 'ratio', usedOid: '1.3.6.1.4.1.9.9.48.1.1.1.5.1', totalOid: '1.3.6.1.4.1.9.9.48.1.1.1.6.1' },
    uptime: { kind: 'ticks', oid: '1.3.6.1.2.1.1.3.0' },
    temperature: { kind: 'gauge', oid: '1.3.6.1.4.1.9.9.13.1.3.1.3.1' },
  },
  HUAWEI: {
    label: 'Huawei',
    cpu: { kind: 'gauge', oid: '1.3.6.1.4.1.2011.6.3.4.1.2', walkAvg: true },
    memory: { kind: 'gauge', oid: '1.3.6.1.4.1.2011.6.3.5.1.1.2', walkAvg: true },
    uptime: { kind: 'ticks', oid: '1.3.6.1.2.1.1.3.0' },
    temperature: { kind: 'gauge', oid: '1.3.6.1.4.1.2011.6.3.6.2.1.1.1.5', walkAvg: true },
  },
  GENERIC: {
    label: 'Generic SNMP (HOST-RESOURCES / UCD)',
    cpu: { kind: 'gauge', oid: '1.3.6.1.2.1.25.3.3.1.2', walkAvg: true }, // hrProcessorLoad
    // UCD memAvailReal / memTotalReal (kB) — inverted into "used %" by the poller.
    memory: { kind: 'ratio', usedOid: '1.3.6.1.4.1.2021.4.6.0', totalOid: '1.3.6.1.4.1.2021.4.5.0' },
    uptime: { kind: 'ticks', oid: '1.3.6.1.2.1.1.3.0' },
  },
};

/** Pick the health profile for a NAS device type, falling back to generic. */
export function healthProfileFor(deviceType?: string | null): HealthProfile {
  const key = String(deviceType || '').toUpperCase();
  if (HEALTH_PROFILES[key]) return HEALTH_PROFILES[key];
  if (key.startsWith('OLT_')) return HEALTH_PROFILES.GENERIC;
  return HEALTH_PROFILES.GENERIC;
}

/**
 * Vendor ONT/ONU Rx optical-power OID bases (walked; the ONU index is the
 * trailing sub-id). Values are typically reported in units of 0.1 dBm or 0.01
 * dBm — `scale` converts to dBm. These are best-effort defaults; if a device
 * returns nothing the poller skips it gracefully.
 */
export const ONT_RX_POWER: Partial<Record<string, { oid: string; scale: number }>> = {
  // VSOL / BDCOM EPON-OLT (enterprise 37950 / 3320 family). 0.1 dBm units.
  OLT_VSOL: { oid: '1.3.6.1.4.1.37950.1.1.5.10.1.7', scale: 0.1 },
  OLT_BDCOM: { oid: '1.3.6.1.4.1.3320.101.10.5.1.5', scale: 0.1 },
  // ZTE GPON — ONU Rx power (rxPower), 0.01 dBm units.
  OLT_ZTE: { oid: '1.3.6.1.4.1.3902.1012.3.28.2.1.4', scale: 0.01 },
  // Huawei GPON — hwGponOntOpticalDdmRxPower, 0.01 dBm.
  OLT_HUAWEI: { oid: '1.3.6.1.4.1.2011.6.128.1.1.2.51.1.4', scale: 0.01 },
  // FiberHome GPON — ONU Rx optical power, 0.01 dBm.
  OLT_FIBERHOME: { oid: '1.3.6.1.4.1.5875.800.3.9.3.3.1.5', scale: 0.01 },
};

/** dBm thresholds. Configurable via env; sane fibre defaults otherwise. */
export const SIGNAL = {
  weak: Number(process.env.SIGNAL_WEAK_DBM) || -25,
  critical: Number(process.env.SIGNAL_CRITICAL_DBM) || -30,
};

export function signalStatus(dbm: number): 'GOOD' | 'WEAK' | 'CRITICAL' {
  if (dbm <= SIGNAL.critical) return 'CRITICAL';
  if (dbm <= SIGNAL.weak) return 'WEAK';
  return 'GOOD';
}

/** Errors-per-minute above which a port is flagged. */
export const PORT_ERROR_PER_MIN = Number(process.env.PORT_ERROR_PER_MIN) || 100;
