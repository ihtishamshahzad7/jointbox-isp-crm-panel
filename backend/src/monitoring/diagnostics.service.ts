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
    // -n numeric, -w 2s per probe, -q 1 probe/hop, -m max hops. No shell.
    const out = await this.run('traceroute', ['-n', '-w', '2', '-q', '1', '-m', String(m), h], (m + 6) * 2000);
    const hops = out.split('\n').map((line) => line.trim()).filter((l) => /^\d+\s/.test(l)).map((l) => {
      const parts = l.split(/\s+/);
      const hop = Number(parts[0]);
      const ip = parts[1] === '*' ? null : parts[1];
      const msM = l.match(/([\d.]+)\s*ms/);
      return { hop, ip, latencyMs: msM ? parseFloat(msM[1]) : null, timedOut: parts[1] === '*' };
    });
    return {
      host: h, hops,
      note: 'Intermediate hops may not answer probes (that is normal and does not mean they are down). Destination reachability is evaluated separately.',
      reachedDestination: hops.some((x) => x.ip && !x.timedOut && hops.indexOf(x) === hops.length - 1),
      raw: out.trim(),
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
    // Best-effort path (traceroute -T needs privilege; if it fails we still have
    // the connect result, which is what actually matters).
    const out = await this.run('traceroute', ['-n', '-T', '-p', String(p), '-w', '2', '-q', '1', '-m', '20', h], 45000);
    const hops = out.split('\n').map((l) => l.trim()).filter((l) => /^\d+\s/.test(l)).map((l) => {
      const parts = l.split(/\s+/);
      const msM = l.match(/([\d.]+)\s*ms/);
      return { hop: Number(parts[0]), ip: parts[1] === '*' ? null : parts[1], latencyMs: msM ? parseFloat(msM[1]) : null, timedOut: parts[1] === '*' };
    });
    return {
      host: h, port: p,
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
