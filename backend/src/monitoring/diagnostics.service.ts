import { Injectable, BadRequestException } from '@nestjs/common';
import { execFile } from 'child_process';
import * as net from 'net';
import * as dns from 'dns';
import * as https from 'https';
import * as http from 'http';

/**
 * On-demand network diagnostics — ping, traceroute, TCP connect/trace, DNS and
 * HTTP checks. SECURITY: user input is NEVER concatenated into a shell. Every
 * external command uses execFile with an argument array (no shell) and the host
 * is strictly validated first, so command injection is impossible.
 */
@Injectable()
export class DiagnosticsService {
  // A host is an IPv4/IPv6 literal or a DNS name. This character set cannot form
  // a shell metacharacter, and we pass args as an array anyway.
  private assertHost(host: string): string {
    const h = String(host || '').trim();
    if (!h || h.length > 255 || !/^[a-zA-Z0-9.:_-]+$/.test(h)) {
      throw new BadRequestException('Invalid host — use an IP address or hostname.');
    }
    return h;
  }
  private assertPort(port: any): number {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new BadRequestException('Port must be 1–65535.');
    return p;
  }

  private run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (_e, stdout, stderr) => {
        resolve(String(stdout || '') + (stderr ? `\n${stderr}` : ''));
      });
    });
  }

  /**
   * Run a command and report WHY it failed — previously a missing binary was
   * swallowed and the UI just showed an empty hop list with no explanation.
   */
  private runDetailed(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string; missing: boolean; error?: string }> {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (e: any, stdout, stderr) => {
        const out = String(stdout || '') + (stderr ? `\n${stderr}` : '');
        if (e && (e.code === 'ENOENT' || /not found/i.test(String(e.message)))) {
          return resolve({ ok: false, out, missing: true, error: `${cmd} is not installed on the server` });
        }
        // A timeout still yields partial hops, which are useful.
        resolve({ ok: !e || out.trim().length > 0, out, missing: false, error: e ? (e.killed ? 'timed out' : e.message) : undefined });
      });
    });
  }

  /**
   * True when the tool ran but could not actually probe — e.g. it lacks raw
   * socket capability. Without this check `tracepath`'s "1: send failed" line
   * parses as a real hop and the UI shows one meaningless row.
   */
  private unusableOutput(out: string): string | null {
    const o = out.toLowerCase();
    if (/send failed/.test(o)) return 'the tool cannot open raw sockets (missing CAP_NET_RAW)';
    if (/permission denied|operation not permitted|failure to open/.test(o)) return 'permission denied opening probe sockets';
    if (/name or service not known|unknown host|cannot handle/.test(o)) return 'host could not be resolved';
    return null;
  }

  /** Parse hop lines from traceroute/tracepath output. */
  private parseHops(out: string) {
    return out.split('\n').map((l) => l.trim()).filter((l) => /^\d+[\s:]/.test(l)).map((l) => {
      const parts = l.replace(':', ' ').split(/\s+/);
      const hop = Number(parts[0]);
      const ipTok = parts.find((p, i) => i > 0 && (/^\d+\.\d+\.\d+\.\d+$/.test(p) || /^[0-9a-f:]{6,}$/i.test(p)));
      const msM = l.match(/([\d.]+)\s*ms/);
      const timedOut = !ipTok || /\*/.test(parts[1] || '');
      return { hop, ip: ipTok || null, latencyMs: msM ? parseFloat(msM[1]) : null, timedOut };
    }).filter((h) => Number.isFinite(h.hop));
  }

  // ── Ping ─────────────────────────────────────────────────────
  async ping(host: string, count = 4) {
    const h = this.assertHost(host);
    const c = Math.min(Math.max(count, 1), 10);
    const out = await this.run('ping', ['-n', '-c', String(c), '-w', String(c + 3), h], (c + 4) * 1000);
    const loss = out.match(/([\d.]+)% packet loss/);
    const rtt = out.match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/); // min/avg/max
    const lossPct = loss ? parseFloat(loss[1]) : 100;
    return {
      host: h, reachable: lossPct < 100, packetLoss: lossPct,
      min: rtt ? parseFloat(rtt[1]) : null, avg: rtt ? parseFloat(rtt[2]) : null, max: rtt ? parseFloat(rtt[3]) : null,
      raw: out.trim().split('\n').slice(-5).join('\n'),
    };
  }

  // ── Traceroute (ICMP/UDP) ────────────────────────────────────
  async traceroute(host: string, maxHops = 20) {
    const h = this.assertHost(host);
    const m = Math.min(Math.max(maxHops, 1), 30);
    const budget = (m + 6) * 2000;

    // Try the common tools in order. Ubuntu often ships `tracepath` (iputils)
    // even when `traceroute` isn't installed, and `mtr` is common on NOC boxes.
    const attempts: Array<{ cmd: string; args: string[] }> = [
      { cmd: 'traceroute', args: ['-n', '-w', '2', '-q', '1', '-m', String(m), h] },
      { cmd: 'tracepath',  args: ['-n', '-m', String(m), h] },
      { cmd: 'mtr',        args: ['-n', '-r', '-c', '1', '-m', String(m), h] },
    ];
    const tried: string[] = [];
    const problems: string[] = [];
    for (const a of attempts) {
      const r = await this.runDetailed(a.cmd, a.args, budget);
      tried.push(a.cmd);
      if (r.missing) { problems.push(`${a.cmd}: not installed`); continue; }
      // Ran, but couldn't probe (no raw-socket capability) → don't report junk hops.
      const bad = this.unusableOutput(r.out);
      if (bad) { problems.push(`${a.cmd}: ${bad}`); continue; }
      const hops = this.parseHops(r.out);
      if (hops.length === 0) { problems.push(`${a.cmd}: produced no hops`); continue; }
      const last = hops[hops.length - 1];
      return {
        host: h, tool: a.cmd, hops,
        reachedDestination: !!last && !last.timedOut,
        note: 'Intermediate hops may not answer probes (that is normal and does not mean they are down). Destination reachability is evaluated separately.',
        raw: r.out.trim().slice(0, 4000),
      };
    }
    // Nothing usable — say exactly why and how to fix it, instead of an empty table.
    return {
      host: h, tool: null, hops: [], reachedDestination: false,
      error: `Traceroute could not run on the monitoring server. ${problems.join(' · ')}`,
      hint: 'Install a tool and allow raw sockets:  sudo apt install traceroute  ' +
            '&&  sudo setcap cap_net_raw+ep $(which traceroute)   ' +
            '(the backend runs unprivileged, so the binary needs CAP_NET_RAW).',
      note: 'Ping, TCP test, TCP trace, DNS and HTTP diagnostics still work without it.',
      raw: '',
    };
  }

  // ── TCP port connect ─────────────────────────────────────────
  async tcpPort(host: string, port: any, timeoutMs = 4000) {
    const h = this.assertHost(host);
    const p = this.assertPort(port);
    const t0 = Date.now();
    return new Promise((resolve) => {
      const sock = new net.Socket();
      let done = false;
      const finish = (open: boolean, error?: string) => {
        if (done) return; done = true; try { sock.destroy(); } catch { /* noop */ }
        resolve({ host: h, port: p, open, latencyMs: open ? Date.now() - t0 : null, error: error || null });
      };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false, 'Connection timed out'));
      sock.once('error', (e: any) => finish(false, e?.code || e?.message || 'Connection failed'));
      sock.connect(p, h);
    });
  }

  // ── TCP traceroute (best effort) + definitive port reachability ──
  async tcpTrace(host: string, port: any) {
    const h = this.assertHost(host);
    const p = this.assertPort(port);
    // Definitive answer: can we actually open the TCP port to the destination?
    const connect: any = await this.tcpPort(h, p, 5000);
    // Best-effort path (traceroute -T needs privilege; if it's missing or not
    // permitted we still return the connect result, which is what matters).
    const r = await this.runDetailed('traceroute', ['-n', '-T', '-p', String(p), '-w', '2', '-q', '1', '-m', '20', h], 45000);
    const hops = r.missing ? [] : this.parseHops(r.out);
    return {
      host: h, port: p,
      pathAvailable: !r.missing && hops.length > 0,
      pathError: r.missing
        ? 'traceroute is not installed on the server (sudo apt install traceroute) — the TCP result below is still authoritative.'
        : (hops.length === 0 ? 'TCP path probing needs root privileges on this server; the TCP result below is still authoritative.' : undefined),
      destinationReached: connect.open,
      connectLatencyMs: connect.latencyMs,
      connectError: connect.error,
      hops,
      note: connect.open
        ? `TCP connection to ${h}:${p} established.`
        : `TCP connection to ${h}:${p} failed (${connect.error}). Intermediate hops that time out are not necessarily down.`,
    };
  }

  // ── DNS ──────────────────────────────────────────────────────
  async dnsLookup(name: string, type = 'A', resolver?: string) {
    const n = this.assertHost(name);
    const rec = String(type || 'A').toUpperCase();
    if (!['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT'].includes(rec)) throw new BadRequestException('Unsupported record type.');
    const r = new dns.promises.Resolver();
    if (resolver) r.setServers([this.assertHost(resolver)]);
    const t0 = Date.now();
    try {
      const answers: any = await (r as any).resolve(n, rec);
      return { name: n, type: rec, resolver: resolver || 'system', success: true, responseMs: Date.now() - t0, answers };
    } catch (e: any) {
      return { name: n, type: rec, resolver: resolver || 'system', success: false, responseMs: Date.now() - t0, error: e?.code || e?.message || 'DNS lookup failed', answers: [] };
    }
  }

  // ── HTTP / HTTPS ─────────────────────────────────────────────
  async httpCheck(url: string) {
    let u: URL;
    try { u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`); } catch { throw new BadRequestException('Invalid URL.'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new BadRequestException('Only http/https URLs are supported.');
    this.assertHost(u.hostname);
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    return new Promise((resolve) => {
      const req = lib.request(u, { method: 'GET', timeout: 8000, rejectUnauthorized: false }, (res) => {
        const ms = Date.now() - t0;
        const tls = (res.socket as any)?.getPeerCertificate ? (res.socket as any).getPeerCertificate() : null;
        res.resume(); // drain
        resolve({
          url: u.toString(), success: (res.statusCode || 0) < 500, status: res.statusCode,
          responseMs: ms, server: res.headers['server'] || null,
          tls: u.protocol === 'https:' && tls?.valid_to ? { validTo: tls.valid_to, issuer: tls.issuer?.O || null } : null,
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ url: u.toString(), success: false, status: null, responseMs: null, error: 'Request timed out' }); });
      req.on('error', (e: any) => resolve({ url: u.toString(), success: false, status: null, responseMs: null, error: e?.code || e?.message || 'Request failed' }));
      req.end();
    });
  }
}
