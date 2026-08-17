import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { execFile } from 'child_process';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';
import { EventsService } from '../common/events.service';

/**
 * Network monitoring — continuously pings the hosts each account adds, keeps a
 * short latency history for the mini graphs, and fires an alert the moment a
 * host goes down. Everything is owner-scoped: a parent's targets are private
 * unless they belong to the viewer's own subtree.
 */
@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);
  private polling = false;

  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
    private events: EventsService,
  ) {}

  // ── Scope helpers ────────────────────────────────────────────
  private async ownedIds(actor?: Actor): Promise<number[] | null> {
    if (!actor || this.scope.isAdmin(actor.role)) return null; // admin = all
    return this.scope.descendantIds(await this.scope.rootId(actor));
  }
  private async assertOwns(id: number, actor?: Actor) {
    const t = await this.prisma.monitorTarget.findUnique({ where: { id }, select: { ownerId: true } });
    if (!t) throw new NotFoundException(`Monitor target ${id} not found`);
    if (!actor || this.scope.isAdmin(actor.role)) return t;
    const ids = await this.ownedIds(actor);
    if (t.ownerId == null || !ids!.includes(t.ownerId)) throw new NotFoundException(`Monitor target ${id} not found`);
    return t;
  }

  // ── CRUD ─────────────────────────────────────────────────────
  async list(actor?: Actor) {
    const ids = await this.ownedIds(actor);
    const rows = await this.prisma.monitorTarget.findMany({
      where: ids ? { ownerId: { in: ids.length ? ids : [-1] } } : {},
      orderBy: [{ groupName: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => ({ ...r, history: this.parseHistory(r.history) }));
  }

  async getOne(id: number, actor?: Actor) {
    await this.assertOwns(id, actor);
    const t = await this.prisma.monitorTarget.findUnique({ where: { id } });
    return t ? { ...t, history: this.parseHistory(t.history) } : null;
  }

  async create(data: { name?: string; host?: string; groupName?: string; intervalSec?: number }, actor?: Actor) {
    const host = String(data.host || '').trim();
    if (!host) throw new BadRequestException('A host (IP or hostname) is required.');
    if (!/^[a-zA-Z0-9._:-]{1,255}$/.test(host)) throw new BadRequestException('That host looks invalid — use an IP or hostname.');
    return this.prisma.monitorTarget.create({
      data: {
        name: String(data.name || host).trim().slice(0, 120),
        host,
        groupName: data.groupName ? String(data.groupName).trim().slice(0, 80) : null,
        intervalSec: Math.min(Math.max(Number(data.intervalSec) || 30, 10), 3600),
        ownerId: actor ? this.scope.actorId(actor) : null,
      },
    });
  }

  async update(id: number, data: any, actor?: Actor) {
    await this.assertOwns(id, actor);
    const patch: any = {};
    if (data.name !== undefined) patch.name = String(data.name).trim().slice(0, 120);
    if (data.host !== undefined) patch.host = String(data.host).trim().slice(0, 255);
    if (data.groupName !== undefined) patch.groupName = data.groupName ? String(data.groupName).trim().slice(0, 80) : null;
    if (data.enabled !== undefined) patch.enabled = !!data.enabled;
    if (data.intervalSec !== undefined) patch.intervalSec = Math.min(Math.max(Number(data.intervalSec) || 30, 10), 3600);
    return this.prisma.monitorTarget.update({ where: { id }, data: patch });
  }

  async remove(id: number, actor?: Actor) {
    await this.assertOwns(id, actor);
    return this.prisma.monitorTarget.delete({ where: { id } });
  }

  /** Rename/regroup a whole group at once. */
  async renameGroup(from: string, to: string, actor?: Actor) {
    const ids = await this.ownedIds(actor);
    await this.prisma.monitorTarget.updateMany({
      where: { groupName: from || null, ...(ids ? { ownerId: { in: ids.length ? ids : [-1] } } : {}) },
      data: { groupName: to ? to.trim().slice(0, 80) : null },
    });
    return { ok: true };
  }

  // ── Ping ─────────────────────────────────────────────────────
  private ping(host: string): Promise<{ up: boolean; ms: number | null; loss: number }> {
    return new Promise((resolve) => {
      // 2 packets, 2s deadline — fast enough to poll many at once.
      execFile('ping', ['-n', '-c', '2', '-w', '2', host], { timeout: 5000 }, (_err, stdout) => {
        const out = String(stdout || '');
        const lossM = out.match(/([\d.]+)% packet loss/);
        const rttM = out.match(/=\s*[\d.]+\/([\d.]+)\//); // avg
        const loss = lossM ? parseFloat(lossM[1]) : 100;
        resolve({ up: loss < 100, ms: rttM ? Math.round(parseFloat(rttM[1]) * 10) / 10 : null, loss });
      });
    });
  }

  private parseHistory(s: string | null): Array<{ t: number; ms: number | null; up: boolean }> {
    try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  }

  /** Ping one target now (the manual "check now" button). Scope-checked. */
  async checkTarget(id: number, actor?: Actor) {
    await this.assertOwns(id, actor);
    const t = await this.prisma.monitorTarget.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Target not found');
    return this.runCheck(t);
  }

  private async runCheck(t: { id: number; host: string; name: string; ownerId: number | null; isUp: boolean | null; history: string | null }) {
    const res = await this.ping(t.host);
    const wasUp = t.isUp;
    const now = new Date();
    const hist = this.parseHistory(t.history);
    hist.push({ t: now.getTime(), ms: res.ms, up: res.up });
    while (hist.length > 60) hist.shift(); // keep the last 60 for the mini graph

    await this.prisma.monitorTarget.update({
      where: { id: t.id },
      data: {
        isUp: res.up,
        lastLatencyMs: res.ms,
        lossPct: res.loss,
        lastCheckedAt: now,
        downSince: res.up ? null : (wasUp === false ? undefined : now),
        history: JSON.stringify(hist),
      },
    });

    // Persist the sample for the long-range history charts (retained ~30 days).
    await this.prisma.monitorSample.create({
      data: { targetId: t.id, up: res.up, latencyMs: res.ms, lossPct: res.loss },
    }).catch(() => null);

    // Transition → alert (up↔down). Broadcast so the browser can beep/announce,
    // and log a durable record.
    if (wasUp !== null && wasUp !== res.up) {
      this.events.broadcast('monitor', {
        id: t.id, name: t.name, host: t.host, ownerId: t.ownerId,
        isUp: res.up, at: now.toISOString(),
      });
      await this.prisma.systemLog.create({
        data: {
          level: res.up ? 'INFO' : 'ERROR',
          source: 'monitoring',
          message: res.up ? `Monitor UP: "${t.name}" (${t.host}) recovered.` : `Monitor DOWN: "${t.name}" (${t.host}) is not responding.`,
          metadata: JSON.stringify({ targetId: t.id, ownerId: t.ownerId }),
        },
      }).catch(() => null);
      this.logger[res.up ? 'log' : 'warn'](`Monitor ${res.up ? 'UP' : 'DOWN'}: ${t.name} (${t.host})`);
    }
    return res;
  }

  // ── Poller ───────────────────────────────────────────────────
  @Cron(CronExpression.EVERY_30_SECONDS)
  async poll() {
    if (this.polling) return; // don't overlap slow runs
    this.polling = true;
    try {
      const targets = await this.prisma.monitorTarget.findMany({
        where: { enabled: true },
        select: { id: true, host: true, name: true, ownerId: true, isUp: true, history: true },
      });
      // Bounded concurrency so a big list doesn't spawn hundreds of pings at once.
      const BATCH = 12;
      for (let i = 0; i < targets.length; i += BATCH) {
        await Promise.all(targets.slice(i, i + BATCH).map((t) => this.runCheck(t).catch(() => null)));
      }
    } catch (e: any) {
      this.logger.warn(`Monitor poll failed: ${e?.message || e}`);
    } finally {
      this.polling = false;
    }
  }

  /** Nightly: drop samples older than the retention window (default 30 days). */
  @Cron('20 3 * * *')
  async pruneSamples() {
    const days = Number(process.env.MONITOR_RETENTION_DAYS || 30);
    const cutoff = new Date(Date.now() - days * 86400_000);
    const { count } = await this.prisma.monitorSample.deleteMany({ where: { at: { lt: cutoff } } });
    if (count) this.logger.log(`Monitoring retention: pruned ${count} sample(s) older than ${days}d`);
  }

  // ── History for the detail-page charts ───────────────────────
  async history(id: number, range: string, actor?: Actor) {
    await this.assertOwns(id, actor);
    const spans: Record<string, number> = {
      '5m': 5 * 60_000, '1h': 3600_000, '6h': 6 * 3600_000,
      '24h': 24 * 3600_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000,
    };
    const ms = spans[range] ?? spans['1h'];
    const from = new Date(Date.now() - ms);
    const rows = await this.prisma.monitorSample.findMany({
      where: { targetId: id, at: { gte: from } },
      orderBy: { at: 'asc' },
      select: { at: true, up: true, latencyMs: true, lossPct: true },
    });

    // Downsample long ranges to ~180 points so the chart stays light.
    const MAX = 180;
    let points = rows;
    if (rows.length > MAX) {
      const bucket = Math.ceil(rows.length / MAX);
      const out: typeof rows = [];
      for (let i = 0; i < rows.length; i += bucket) {
        const slice = rows.slice(i, i + bucket);
        const lat = slice.filter((s) => s.up && s.latencyMs != null).map((s) => s.latencyMs!);
        out.push({
          at: slice[Math.floor(slice.length / 2)].at,
          up: slice.some((s) => s.up),
          latencyMs: lat.length ? Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 10) / 10 : null,
          lossPct: Math.round((slice.reduce((a, s) => a + (s.lossPct ?? 0), 0) / slice.length)),
        });
      }
      points = out;
    }

    // Stats over the raw rows (not the downsampled set).
    const lats = rows.filter((s) => s.up && s.latencyMs != null).map((s) => s.latencyMs!);
    const upCount = rows.filter((s) => s.up).length;
    const stats = {
      samples: rows.length,
      min: lats.length ? Math.min(...lats) : null,
      avg: lats.length ? Math.round((lats.reduce((a, b) => a + b, 0) / lats.length) * 10) / 10 : null,
      max: lats.length ? Math.max(...lats) : null,
      uptimePct: rows.length ? Math.round((upCount / rows.length) * 10000) / 100 : null,
      lossPct: rows.length ? Math.round((rows.reduce((a, s) => a + (s.lossPct ?? 0), 0) / rows.length) * 100) / 100 : null,
    };
    return { range, from, points, stats };
  }
}
