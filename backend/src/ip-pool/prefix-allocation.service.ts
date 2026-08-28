import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * PrefixAllocationService — the routed-prefix register for corporate/P2P clients.
 *
 * Distinct from IpPool (PPPoE address pools) and StaticIp (single addresses):
 * here a business client receives a VLAN, a /30 transit link to the router and
 * a routed block of their own, plus a static route, uRPF and an ingress ACL.
 *
 * WHY THIS EXISTS. That information normally lives in a spreadsheet, which
 * fails in three expensive ways an ISP only notices once:
 *   • the sheet is always one allocation behind, so two clients get the same
 *     block and the second one's traffic blackholes;
 *   • nobody can answer "what is the next free /29?" without reading every row;
 *   • when abuse is reported months later, there is no record of who held the
 *     prefix at the time.
 *
 * The allocator below is therefore the point of the whole module: it computes
 * the next free subnet from real data and writes the record in the same call,
 * so the register cannot drift from what was actually handed out.
 */
@Injectable()
export class PrefixAllocationService {
  private readonly logger = new Logger(PrefixAllocationService.name);

  constructor(
    private prisma: PrismaService,
    private scope: ScopeService,
  ) {}

  // ── IPv4 maths ───────────────────────────────────────────────────────────
  private ipToInt(ip: string): number {
    const p = ip.trim().split('.');
    if (p.length !== 4) throw new BadRequestException(`"${ip}" is not a valid IPv4 address.`);
    let n = 0;
    for (const o of p) {
      const v = Number(o);
      if (!Number.isInteger(v) || v < 0 || v > 255) throw new BadRequestException(`"${ip}" is not a valid IPv4 address.`);
      n = (n << 8) + v;
    }
    return n >>> 0;
  }
  private intToIp(n: number): string {
    return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
  }
  /** Parse "10.152.0.0/30" → { base, size, first, last }. Base is normalised. */
  private parseCidr(cidr: string): { base: number; size: number; first: number; last: number } {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr || '').trim());
    if (!m) throw new BadRequestException(`"${cidr}" is not valid CIDR (expected e.g. 10.0.0.0/30).`);
    const size = Number(m[2]);
    if (size < 0 || size > 32) throw new BadRequestException(`Prefix length /${size} is out of range.`);
    const ip = this.ipToInt(m[1]);
    const mask = size === 0 ? 0 : (0xffffffff << (32 - size)) >>> 0;
    const base = (ip & mask) >>> 0;
    const count = size === 32 ? 1 : 2 ** (32 - size);
    return { base, size, first: base, last: (base + count - 1) >>> 0 };
  }
  private cidrStr(base: number, size: number) { return `${this.intToIp(base)}/${size}`; }
  private overlaps(a: { first: number; last: number }, b: { first: number; last: number }) {
    return a.first <= b.last && b.first <= a.last;
  }

  // ── Pools ────────────────────────────────────────────────────────────────
  async listPools(actor?: Actor) {
    this.assertAdmin(actor);
    const pools = await this.prisma.prefixPool.findMany({
      where: { isActive: true },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
    // Utilisation is computed, never stored — a cached count is exactly the
    // kind of thing that silently goes stale and re-creates the spreadsheet
    // problem this module exists to solve.
    const out: any[] = [];
    for (const p of pools) {
      const used = await this.prisma.prefixAllocation.count({ where: { poolId: p.id, status: 'ACTIVE' } });
      const range = this.parseCidr(p.cidr);
      const total = Math.floor((range.last - range.first + 1) / 2 ** (32 - p.defaultSize));
      out.push({
        ...p,
        blocksTotal: total,
        blocksUsed: used,
        blocksFree: Math.max(0, total - used),
        utilisationPercent: total ? Math.round((used / total) * 1000) / 10 : 0,
      });
    }
    return out;
  }

  async createPool(body: any, actor?: Actor) {
    this.assertAdmin(actor);
    const cidr = String(body?.cidr || '').trim();
    this.parseCidr(cidr); // validates
    const kind = String(body?.kind || 'PUBLIC').toUpperCase();
    if (!['PUBLIC', 'TRANSIT'].includes(kind)) throw new BadRequestException('Pool kind must be PUBLIC or TRANSIT.');
    const defaultSize = Number(body?.defaultSize) || (kind === 'TRANSIT' ? 30 : 29);
    if (defaultSize < 8 || defaultSize > 32) throw new BadRequestException('Default size must be between /8 and /32.');
    return this.prisma.prefixPool.create({
      data: {
        name: String(body?.name || cidr).slice(0, 120),
        cidr, kind, defaultSize,
        description: body?.description ? String(body.description).slice(0, 300) : null,
      },
    });
  }

  /**
   * Public address space is ISP-level infrastructure, not a per-reseller
   * resource: the register lists every corporate client, their prefixes and
   * their VLANs. A reseller reading it would see other branches' customers and
   * the ISP's whole addressing plan, so READS are restricted as tightly as
   * writes. This is deliberately stricter than IpPool, which IS shared
   * downstream by design.
   */
  private assertAdmin(actor?: Actor) {
    if (actor && !this.scope.isAdmin(actor.role)) {
      throw new ForbiddenException('Only ISP-level accounts can view or manage routed address space.');
    }
  }

  // ── The allocator ────────────────────────────────────────────────────────
  /**
   * Next free subnet of `size` from a pool.
   *
   * Walks the pool on subnet boundaries and returns the first block that does
   * not OVERLAP any live allocation. Overlap, not equality: a /29 that has been
   * handed out blocks the two /30s inside it, and equality-matching would
   * happily hand those out again.
   *
   * RELEASED allocations are ignored, so space genuinely returns to the pool,
   * while the historical row survives for the abuse-report case.
   */
  async nextFree(poolId: number, sizeRaw?: number, actor?: Actor) {
    this.assertAdmin(actor);
    const pool = await this.prisma.prefixPool.findUnique({ where: { id: poolId } });
    if (!pool) throw new NotFoundException(`Pool ${poolId} not found`);
    const size = Number(sizeRaw) || pool.defaultSize;
    if (size < pool.defaultSize - 8 || size > 32) {
      throw new BadRequestException(`Requested /${size} is not sensible for this pool.`);
    }

    const range = this.parseCidr(pool.cidr);
    if (size < range.size) {
      throw new BadRequestException(`A /${size} is larger than the pool itself (${pool.cidr}).`);
    }

    const live = await this.prisma.prefixAllocation.findMany({
      where: { status: 'ACTIVE' },
      select: { allocatedCidr: true, transitCidr: true, clientName: true },
    });
    // Both the delegated block AND the transit link consume address space.
    const taken = live.flatMap((a) => {
      const out: Array<{ first: number; last: number }> = [];
      try { out.push(this.parseCidr(a.allocatedCidr)); } catch { /* skip malformed */ }
      if (a.transitCidr) { try { out.push(this.parseCidr(a.transitCidr)); } catch { /* skip */ } }
      return out;
    });

    const step = 2 ** (32 - size);
    for (let base = range.first; base <= range.last; base += step) {
      const cand = { first: base, last: (base + step - 1) >>> 0 };
      if (cand.last > range.last) break;
      if (taken.some((t) => this.overlaps(cand, t))) continue;
      return {
        cidr: this.cidrStr(base, size),
        network: this.intToIp(base),
        firstUsable: this.intToIp(base + 1),
        lastUsable: this.intToIp(cand.last - 1),
        broadcast: this.intToIp(cand.last),
        usableHosts: Math.max(0, step - 2),
        pool: { id: pool.id, name: pool.name, cidr: pool.cidr, kind: pool.kind },
      };
    }
    throw new BadRequestException(
      `No free /${size} left in ${pool.name} (${pool.cidr}). Add another pool or release an old allocation.`,
    );
  }

  /**
   * Provision a client end to end: pick a free public block AND a free transit
   * /30, reserve both in one record, and return the router configuration.
   *
   * Deliberately ONE call. Allocating the block, allocating the link and
   * writing the record as separate steps is how a half-provisioned client ends
   * up holding address space nobody can account for.
   */
  async provision(body: any, actor?: Actor) {
    this.assertAdmin(actor);
    const clientName = String(body?.clientName || '').trim();
    if (!clientName) throw new BadRequestException('Client name is required.');

    const publicPoolId = Number(body?.poolId);
    const transitPoolId = Number(body?.transitPoolId);
    if (!publicPoolId) throw new BadRequestException('Choose the public pool to allocate from.');

    const size = Number(body?.size) || undefined;
    const block = body?.allocatedCidr
      ? { cidr: String(body.allocatedCidr).trim() }
      : await this.nextFree(publicPoolId, size);

    // Explicit CIDRs are still checked for collision — an operator typing a
    // block by hand is exactly when a clash happens.
    await this.assertFree(block.cidr, 'allocated prefix');

    let transitCidr: string | null = body?.transitCidr ? String(body.transitCidr).trim() : null;
    if (!transitCidr && transitPoolId) {
      transitCidr = (await this.nextFree(transitPoolId, 30)).cidr;
    }
    if (transitCidr) await this.assertFree(transitCidr, 'transit link');

    const t = transitCidr ? this.parseCidr(transitCidr) : null;
    const ourIp = body?.ourIp ? String(body.ourIp) : t ? this.intToIp(t.first + 1) : null;
    const clientIp = body?.clientIp ? String(body.clientIp) : t ? this.intToIp(t.first + 2) : null;

    const vlanId = body?.vlanId != null ? Number(body.vlanId) : null;
    if (vlanId != null) {
      if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) {
        throw new BadRequestException('VLAN id must be between 1 and 4094.');
      }
      const clash = await this.prisma.prefixAllocation.findFirst({
        where: { vlanId, status: 'ACTIVE' }, select: { clientName: true },
      });
      if (clash) throw new BadRequestException(`VLAN ${vlanId} is already used by ${clash.clientName}.`);
    }

    const slug = clientName.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
    const date = new Date();
    const dateTag = `${String(date.getDate()).padStart(2, '0')}${date.toLocaleString('en', { month: 'short' })}${date.getFullYear()}`;

    const row = await this.prisma.prefixAllocation.create({
      data: {
        clientName,
        poolId: publicPoolId,
        subscriberId: body?.subscriberId ? Number(body.subscriberId) : null,
        vlanId,
        vlanName: body?.vlanName ? String(body.vlanName).slice(0, 80)
          : vlanId ? `vlan${vlanId}-${clientName.replace(/\s+/g, '')}`.slice(0, 80) : null,
        linkType: String(body?.linkType || 'P2P').toUpperCase(),
        transitCidr, ourIp, clientIp,
        allocatedCidr: block.cidr,
        urpfEnabled: body?.urpfEnabled === undefined ? true : !!body.urpfEnabled,
        ingressAcl: body?.ingressAcl ? String(body.ingressAcl).slice(0, 120) : `ACL-CLIENT-${slug}-IN`,
        mtu: Number(body?.mtu) || 1500,
        description: body?.description ? String(body.description).slice(0, 300)
          : `Client-${clientName.replace(/\s+/g, '')}-${String(body?.linkType || 'P2P').toUpperCase()}-${dateTag}`,
        deviceName: body?.deviceName ? String(body.deviceName).slice(0, 120) : null,
        nasId: body?.nasId ? Number(body.nasId) : null,
        notes: body?.notes ? String(body.notes) : null,
        createdById: actor ? this.scope.actorId(actor) : null,
      },
    });

    this.logger.log(`Prefix allocated: ${block.cidr} → ${clientName} (VLAN ${vlanId ?? '—'})`);
    return { allocation: row, config: this.renderConfig(row), summary: this.renderSummary(row) };
  }

  private async assertFree(cidr: string, label: string) {
    const want = this.parseCidr(cidr);
    const live = await this.prisma.prefixAllocation.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, clientName: true, allocatedCidr: true, transitCidr: true },
    });
    for (const a of live) {
      for (const [field, val] of [['allocated prefix', a.allocatedCidr], ['transit link', a.transitCidr]] as const) {
        if (!val) continue;
        try {
          if (this.overlaps(want, this.parseCidr(val))) {
            throw new BadRequestException(
              `${cidr} (${label}) overlaps ${val}, already assigned to ${a.clientName}. ` +
              `Release that allocation first or pick another block.`,
            );
          }
        } catch (e: any) {
          if (e instanceof BadRequestException) throw e; // real clash
          /* malformed stored value — ignore rather than block provisioning */
        }
      }
    }
  }

  // ── Register ─────────────────────────────────────────────────────────────
  async list(query: any = {}, actor?: Actor) {
    this.assertAdmin(actor);
    const where: any = {};
    if (query.status && query.status !== 'ALL') where.status = String(query.status).toUpperCase();
    else where.status = { not: 'RELEASED' };
    if (query.q) {
      const q = String(query.q);
      where.OR = [
        { clientName: { contains: q, mode: 'insensitive' } },
        { allocatedCidr: { contains: q } },
        { transitCidr: { contains: q } },
        { vlanName: { contains: q, mode: 'insensitive' } },
        { ingressAcl: { contains: q, mode: 'insensitive' } },
      ];
    }
    return this.prisma.prefixAllocation.findMany({
      where, include: { pool: { select: { id: true, name: true, cidr: true } } },
      orderBy: { provisionedAt: 'desc' }, take: Number(query.limit) || 500,
    });
  }

  async getOne(id: number, actor?: Actor) {
    this.assertAdmin(actor);
    const row = await this.prisma.prefixAllocation.findUnique({
      where: { id }, include: { pool: true },
    });
    if (!row) throw new NotFoundException(`Allocation ${id} not found`);
    return { allocation: row, config: this.renderConfig(row), summary: this.renderSummary(row) };
  }

  /** Return the space to the pool, keeping the history. */
  async release(id: number, reason: string, actor?: Actor) {
    this.assertAdmin(actor);
    if (!String(reason || '').trim()) {
      throw new BadRequestException('A reason is required — this returns public address space to the pool.');
    }
    const row = await this.prisma.prefixAllocation.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Allocation ${id} not found`);
    if (row.status === 'RELEASED') return row;
    const updated = await this.prisma.prefixAllocation.update({
      where: { id },
      data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: String(reason).slice(0, 300) },
    });
    this.logger.warn(`Prefix released: ${row.allocatedCidr} (was ${row.clientName}) — ${reason}`);
    return { ...updated, teardown: this.renderTeardown(row) };
  }

  // ── Generated configuration ──────────────────────────────────────────────
  /**
   * Render the exact router configuration for an allocation.
   *
   * Generated from the stored record rather than typed per client, because the
   * register and the router must not be able to disagree — a hand-typed ACL
   * with the wrong prefix is a silent security hole, not a cosmetic error.
   */
  renderConfig(a: any): string {
    const L: string[] = [];
    const acl = a.ingressAcl || `ACL-CLIENT-${String(a.clientName).toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-IN`;
    if (a.vlanId) {
      L.push(`vlan ${a.vlanId}`);
      L.push(` name ${a.vlanName || `vlan${a.vlanId}-${a.clientName}`}`);
      L.push('!');
      L.push(`interface Vlan${a.vlanId}`);
      if (a.description) L.push(` description ${a.description}`);
      L.push(' no shutdown');
      if (a.mtu) L.push(` mtu ${a.mtu}`);
      if (a.ourIp && a.transitCidr) L.push(` ip address ${a.ourIp}/${this.parseCidr(a.transitCidr).size}`);
      // uRPF drops packets whose source is not reachable back out the same
      // interface — the cheapest possible anti-spoofing control on a customer
      // edge, and the reason the ACL below can stay simple.
      if (a.urpfEnabled) L.push(' ip verify unicast source reachable-via rx');
      L.push(` ip access-group ${acl} in`);
      L.push('!');
    }
    if (a.clientIp) {
      L.push(`ip route ${a.allocatedCidr} ${a.clientIp} name Client-${String(a.clientName).replace(/\s+/g, '')}`);
      L.push('!');
    }
    L.push(`ip access-list ${acl}`);
    L.push(` 10 permit ip ${a.allocatedCidr} any`);
    // Deny-and-log last: without it the implicit deny is invisible, and the
    // first question during an incident is always "is the ACL dropping this?".
    L.push(' 20 deny ip any any log');
    return L.join('\n');
  }

  /** The teardown a decommission needs — the config above, reversed. */
  renderTeardown(a: any): string {
    const L: string[] = [];
    const acl = a.ingressAcl;
    if (a.clientIp) L.push(`no ip route ${a.allocatedCidr} ${a.clientIp}`);
    if (a.vlanId) { L.push(`no interface Vlan${a.vlanId}`); L.push(`no vlan ${a.vlanId}`); }
    if (acl) L.push(`no ip access-list ${acl}`);
    return L.join('\n');
  }

  /** The handover sheet given to the client. */
  renderSummary(a: any): string {
    const d = new Date(a.provisionedAt || a.createdAt);
    const date = `${String(d.getDate()).padStart(2, '0')}-${d.toLocaleString('en', { month: 'short' })}-${d.getFullYear()}`;
    const row = (k: string, v: any) => `${k.padEnd(18)}: ${v ?? '—'}`;
    return [
      '='.repeat(52),
      row('Client Name', a.clientName),
      row('VLAN', a.vlanId),
      row('VLAN Name', a.vlanName),
      row('Link Type', `${a.linkType} ${a.transitCidr ? `/${this.parseCidr(a.transitCidr).size}` : ''}`.trim()),
      row('Client IP', a.clientIp && a.transitCidr ? `${a.clientIp}/${this.parseCidr(a.transitCidr).size}` : a.clientIp),
      row('Our End IP', a.ourIp && a.transitCidr ? `${a.ourIp}/${this.parseCidr(a.transitCidr).size}` : a.ourIp),
      row('Allocated Prefix', a.allocatedCidr),
      row('Static Route', a.clientIp ? `ip route ${a.allocatedCidr} ${a.clientIp}` : '—'),
      row('Provisioned Date', date),
      row('uRPF', a.urpfEnabled ? 'Enabled' : 'Disabled'),
      row('Ingress ACL', a.ingressAcl),
      row('Status', a.status),
      '='.repeat(52),
    ].join('\n');
  }
}
