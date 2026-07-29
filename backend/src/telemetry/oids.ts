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
