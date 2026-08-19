import { Injectable } from '@nestjs/common';
import { SYSLOG_SEVERITIES, eventSeverity, type NdmEventType } from './ndm.constants';

/**
 * Syslog parser — turns a raw message into structured fields and detects the
 * high-value events we alert on.
 *
 * Two parsers cover both wire formats so the receiver doesn't care which one
 * the device speaks:
 *   - RFC 5424:  <PRI>1 TIMESTAMP HOST APP PROCID MSGID [SD] MSG
 *   - RFC 3164:  <PRI>TIMESTAMP HOST TAG[PID]: MSG
 * A bare message with no PRI means "just the payload".
 */
@Injectable()
export class NdmSyslogParserService {
  /** Strip the <PRI> severity (7 vs 6 = Level vs Notice is handled by caller). */
  private parsePrio(line: string): { pri: number | null; rest: string } {
    const m = line.match(/^<(\d{1,3})>/);
    if (!m) return { pri: null, rest: line };
    return { pri: Number(m[1]), rest: line.slice(m[0].length) };
  }

  parse(raw: string): NdmParsedSyslog | null {
    // Normalize line endings / NULs that some devices pad with.
    const line = String(raw || '').replace(/[\r\n\u0000]+$/, '').trim();
    if (!line) return null;

    const { pri, rest } = this.parsePrio(line);
    const severity = pri != null ? SYSLOG_SEVERITIES[pri % 8] : 'NOTICE';
    const facility = pri != null ? Math.floor(pri / 8) : null;

    let timestamp: string | null = null;
    let host: string | null = null;
    let processes = '';
    let message = line;
    const body = rest;

    // RFC 5424 has a version digit right after the PRI.
    const v5424 = body.match(/^1\s+/);

    if (v5424) {
      const parts = body.split(/\s+/);
      // 1 TIMESTAMP HOST APP PROCID MSGID [SD] MSG
      let i = 1;
      if (i < parts.length) timestamp = parts[i++] || null;
      if (i < parts.length) host = parts[i++] || null;
      if (i < parts.length) processes = String(parts[i++] || '');
      if (i < parts.length) i++; // PROCID
      if (i < parts.length) i++; // MSGID
      // Optional [structured-data] element(s) — skip each token that looks like one.
      while (i < parts.length && parts[i].startsWith('[')) i++;
      if (i < parts.length) message = parts.slice(i).join(' ');
    } else {
      // RFC 3164: TIMESTAMP HOST TAG[PID]: MSG
      const tm = body.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(.*)$/);
      if (tm) {
        timestamp = tm[1];
        const rest2 = tm[2];
        const hm = rest2.match(/^(\S+)\s+(.*)$/);
        if (hm) {
          host = hm[1];
          const [, afterHost] = hm;
          const tm2 = afterHost.match(/^(\S+?)(?:\[\d+\])?[: ]\s*(.*)$/);
          if (tm2) { processes = tm2[1]; message = tm2[2] || ''; }
          else message = afterHost;
        } else { host = rest2.split(/\s+/)[0] || null; }
      } else {
        host = body.split(/\s+/)[0] || null;
        message = body;
      }
    }

    const ml = message.toLowerCase();

    return {
      raw: line,
      facility,
      facilityName: facilityName(facility),
      severity,
      severityCode: pri != null ? pri % 8 : 5,
      eventSeverity: eventSeverity(severity),
      timestamp: timestamp || new Date().toISOString(),
      host,
      process: processes || null,
      message: message || null,
      event: detectEvent(ml, severity),
      len: line.length,
    };
  }
}

/** Facility index → name (RFC 3164/5424 table). */
function facilityName(f: number | null): string {
  const names = ['KERN', 'USER', 'MAIL', 'DAEMON', 'AUTH', 'SYSLOG', 'LPR',
    'NEWS', 'UUCP', 'CRON', 'AUTHPRIV', 'FTP', 'NTP', 'AUDIT', 'ALERT', 'CLOCK',
    'LOCAL0', 'LOCAL1', 'LOCAL2', 'LOCAL3', 'LOCAL4', 'LOCAL5', 'LOCAL6', 'LOCAL7'];
  return f != null && f >= 0 && f < names.length ? names[f] : 'USER';
}

/**
 * Smart event detection — the reason "switch syslog beats everything else".
 * Regexes run against the lowercased message; the first hit wins. Unmatched
 * messages become a generic SYSLOG event and still get stored + notified if
 * the rule targets them. Patterns are deliberately loose: vendor wording
 * differs, but the verb + nouns rarely do.
 */
const DETECTORS: { type: NdmEventType; re: RegExp; force?: string }[] = [
  // Link / port state changes
  { type: 'LINK_DOWN', re: /\b(link|interface|port|gigabitethernet|ge|ethernet)\S*\s+(is\s+)?down\b/ },
  { type: 'LINK_UP', re: /\b(link|interface|port|gigabitethernet|ge|ethernet)\S*\s+(is\s+)?up\b/ },
  { type: 'LINK_UP', re: /\bport\S*\s+(changed state to up|state to up|now in up)\b/ },
  { type: 'LINK_DOWN', re: /\b(change state to down|now in down|went down)\b/ },
  { type: 'LINK_UP', re: /\b(restored|recovered|went back to up)\b/ },
  { type: 'LINK_FLAP', re: /\b(reset|flap|flapping|oscillat\w+|up down up)\b/ },
  // Routing / switching protocols
  { type: 'BGP_DOWN', re: /\bbgp\S*\s+(neighbor|peer)\s+\S+\s+(went\s+)?down\b/ },
  { type: 'BGP_UP', re: /\bbgp\S*\s+(neighbor|peer)\s+\S+\s+(came|went|is)\s+up\b/ },
  { type: 'BGP_DOWN', re: /\b(down|reset|cleared).*\bbgp\b/i },
  { type: 'OSPF_DOWN', re: /\bospf\S*\s+(adjacency|neighbor|interface)\s+(with|to|on)\s+\S+\s+(went|goes|is)\s+down\b/ },
  { type: 'OSPF_UP', re: /\bospf\S*\s+(adjacency|neighbor|interface)\s+(with|to|on)\s+\S+\s+(came|went|is)\s+up\b/ },
  { type: 'STP_CHANGE', re: /\bstp\b.*\b(topology change|tcn|forwarding state|listening state)\b/ },
  // Resource pressure
  { type: 'CPU_HIGH', re: /\bcpu\b.*\b(utilization|usage|load)\b.*\b(high|critical|exceeded|above|alert)\b/ },
  { type: 'MEMORY_HIGH', re: /\b(memory|ram)\b.*\b(utilization|usage|low)\b.*\b(high|critical|exceeded|alert)\b/ },
  // Security
  { type: 'AUTH_FAILURE', re: /\b(auth|login|user)\b.*\b(fail|denied|invalid|rejected)\b|\bfailed login\b|\bauthentication failure\b/ },
  { type: 'AUTH_FAILURE', re: /\b(username|password|account).*(invalid|wrong|locked|expired)\b/ },
  { type: 'CONFIG_CHANGE', re: /\b(config|configuration|running-config|startup-config)\b.*\b(chang|saved|modified|write)\b/ },
  { type: 'CONFIG_CHANGE', re: /\b(configuration changed by user)\b|\blogged out.*(console|ssh)\b/ },
  // Device-level
  { type: 'DEVICE_REBOOT', re: /\b(reload|reboot|restart|booting|cold start|warm start|system restarted)\b/ },
  { type: 'POWER_FAILURE', re: /\bpower\b.*\b(fail|loss|outage|supply.*(down|fail)|input.*off)\b/ },
  { type: 'POWER_FAILURE', re: /\b(power supply)\s*\d*\s*(failed|shutdown|not present)\b/ },
  // Interface error flood — errors themselves are '*' style, but NVTs flag them this way.
  { type: 'PORT_ERROR', re: /\b(errors|crc|fcs|alignment)\b.*\b(increas|exceeds|exceeded|high|critical)\b/ },
];

function detectEvent(lower: string, _severity: string): NdmEventType {
  for (const d of DETECTORS) if (d.re.test(lower)) return d.type;
  return 'SYSLOG';
}

export interface NdmParsedSyslog {
  raw: string;
  facility: number | null;
  facilityName: string;
  severity: string;
  severityCode: number;
  eventSeverity: 'critical' | 'error' | 'warning' | 'notice' | 'info' | 'debug';
  timestamp: string;
  host: string | null;
  process: string | null;
  message: string | null;
  event: NdmEventType;
  len: number;
}