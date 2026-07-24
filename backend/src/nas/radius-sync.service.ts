import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

/**
 * Resolved policy attributes from a package's linked RADIUS policies.
 * Each entry is written directly to radreply as (attribute, op, value).
 */
export interface RadiusPolicyAttr {
  attribute: string;
  op: string;
  value: string;
}

/**
 * POOL, NOT CLIENT.
 *
 * This service held a single `pg.Client` shared by everything that touches
 * RADIUS: the two-minute router-log poll, the NAS health sweep, every
 * subscriber save, and every delete. A `Client` is ONE connection and can
 * execute ONE query at a time — that is exactly what the
 *
 *   "Calling client.query() when the client is already executing a query"
 *
 * warning in the logs was reporting, on every single request.
 *
 * Overlapping callers queue behind each other on that one connection. A slow
 * or stuck query does not fail, it blocks everyone behind it, and the requests
 * waiting simply stop producing output — which is precisely the symptom: a
 * delete that logs "📝 Deleting: ali_khan" and then nothing at all, no error,
 * no completion. Retrying made it worse by adding more waiters to the queue.
 *
 * A Pool hands each caller its own connection and returns it afterwards, so
 * concurrent work no longer serialises behind one socket.
 */
@Injectable()
export class RadiusSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RadiusSyncService.name);
  private pgClient!: Pool;
  private connected = false;
  private reconnecting = false;
  private stopped = false;

  // ─────────────────────────────────────────────────────────────
  // STARTUP — connect to RADIUS PostgreSQL database
  // ─────────────────────────────────────────────────────────────
  async onModuleInit() {
    await this.connect();
  }

  private async connect() {
    const radiusDbUrl = process.env.RADIUS_DATABASE_URL;
    if (!radiusDbUrl) {
      this.logger.error('❌ RADIUS_DATABASE_URL not set in .env file');
      return;
    }

    const match = radiusDbUrl.match(
      /postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?]+)/,
    );
    if (!match) {
      this.logger.error('❌ Invalid RADIUS_DATABASE_URL format');
      return;
    }

    const [, user, password, host, port, database] = match;
    const client = new Pool({
      host,
      port: parseInt(port),
      user,
      password,
      database,
      // Enough for the pollers plus concurrent user actions, without opening
      // more sockets to the RADIUS box than it wants to hold.
      max: 10,
      idleTimeoutMillis: 30_000,
      // Never let a caller wait forever for a free connection. Failing fast
      // with a readable error beats a request that hangs with no output.
      connectionTimeoutMillis: 10_000,
    });

    // CRITICAL: a raw pg Client emits an 'error' event when the connection is
    // dropped by the server (VM restart, network blip, idle timeout). If nobody
    // listens, Node treats it as an unhandled 'error' and HARD-CRASHES the whole
    // backend. We swallow it, mark ourselves disconnected, and schedule a retry.
    client.on('error', (err: any) => {
      if (this.connected) {
        this.logger.warn(
          `⚠️ RADIUS DB connection lost: ${err?.message || err}. Will reconnect…`,
        );
      }
      this.connected = false;
      this.scheduleReconnect();
    });
    // A Pool has no 'end' event the way a Client does; it manages its own
    // sockets and replaces dead ones. Only hard errors need handling.

    this.pgClient = client;

    try {
      // Pool.query() connects lazily, so a probe query doubles as the
      // connectivity check that Client.connect() used to provide.
      this.connected = true;
      this.logger.log(
        `✅ Connected to RADIUS database: ${database} on ${host}:${port}`,
      );
      const result = await client.query('SELECT COUNT(*) FROM nas');
      this.logger.log(`📊 NAS table has ${result.rows[0].count} entries`);
    } catch (error: any) {
      this.connected = false;
      this.logger.error(
        `❌ Failed to connect to RADIUS database: ${error.message}`,
      );
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    // Best-effort close of the dead client so it stops emitting further events.
    try {
      this.pgClient?.end().catch((e) => { this.logger?.warn?.('scheduleReconnect: ' + (e?.message || e)); });
    } catch {
      /* ignore */
    }
    setTimeout(async () => {
      this.reconnecting = false;
      if (this.stopped || this.connected) return;
      this.logger.log('🔄 Attempting to reconnect to RADIUS database…');
      await this.connect();
    }, 10_000).unref?.();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.pgClient) {
      try {
        await this.pgClient.end();
      } catch {
        /* ignore */
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC ACCESSOR — for custom queries (used by SubscribersService)
  // ─────────────────────────────────────────────────────────────
  getPgClient(): Pool | null {
    return this.connected ? this.pgClient : null;
  }

  private ensureConnected() {
    if (!this.connected || !this.pgClient) {
      throw new Error(
        'Not connected to RADIUS database. Check RADIUS_DATABASE_URL in .env',
      );
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVATE HELPER: Build MikroTik rate-limit string
  // ─────────────────────────────────────────────────────────────
  private buildRateLimit(pkg: {
    downloadSpeed: number;
    uploadSpeed: number;
    burstDownload?: number | null;
    burstUpload?: number | null;
    burstThreshold?: number | null;
    burstTime?: number | null;
  }): string {
    const dl = pkg.downloadSpeed;
    const ul = pkg.uploadSpeed;

    // If any burst field is set, build full burst string
    if (pkg.burstDownload && pkg.burstUpload) {
      const bDl = pkg.burstDownload;
      const bUl = pkg.burstUpload;
      const bThr = pkg.burstThreshold ?? Math.floor(dl * 0.5);
      const bT = pkg.burstTime ?? 10;
      return `${dl}M/${ul}M ${bDl}M/${bUl}M ${bThr}M/${bThr}M ${bT}`;
    }

    // Simple no-burst rate limit
    return `${dl}M/${ul}M`;
  }

  /**
   * Resolved policy attributes from a package's linked RADIUS policies.
   * Each entry is written directly to radreply as (attribute, op, value).
   */
  async syncSubscriberProfile(
    username: string,
    password: string,
    pkg?: {
      downloadSpeed: number;
      uploadSpeed: number;
      burstDownload?: number | null;
      burstUpload?: number | null;
      burstThreshold?: number | null;
      burstTime?: number | null;
      pool?: { name: string } | null;
      /**
       * Resolved policy attributes from the package's linked RADIUS policies.
       * When set, these OVERRIDE the auto-computed Mikrotik-Rate-Limit and any
       * other computed attributes with the policy-defined values.
       */
      policyAttributes?: RadiusPolicyAttr[];
    } | null,
    /**
     * Optional service profile. Omitted → behaves exactly as before (PPPoE with
     * a pool), so every existing caller keeps working unchanged.
     */
    opts?: {
      serviceType?: 'PPPOE' | 'HOTSPOT' | 'STATIC' | 'DHCP';
      staticIp?: string | null;      // fixed address for business customers
      sessionTimeout?: number | null; // seconds — hotspot time limits
      idleTimeout?: number | null;    // seconds — free idle sessions
      macAddress?: string | null;     // DHCP/MAC-based auth
    },
  ): Promise<void> {
    this.ensureConnected();

    try {
      // Clean slate — remove old entries
      await this.pgClient.query('DELETE FROM radcheck WHERE username = $1', [username]);
      await this.pgClient.query('DELETE FROM radreply WHERE username = $1', [username]);

      // Write password to radcheck
      await this.pgClient.query(
        `INSERT INTO radcheck (username, attribute, op, value)
         VALUES ($1, 'Cleartext-Password', ':=', $2)`,
        [username, password],
      );

      // Tell the NAS how often to send interim accounting updates. Pushing this
      // from RADIUS is far more reliable than setting `/ppp aaa interim-update`
      // on each router: it is returned in the Access-Accept and every NAS obeys
      // it automatically. Without interim updates, live TX/RX counters stay at
      // 0 and a dropped session can never be detected as stale.
      const interim = Number(process.env.RADIUS_INTERIM_INTERVAL || 60);
      await this.pgClient.query(
        `INSERT INTO radreply (username, attribute, op, value)
         VALUES ($1, 'Acct-Interim-Interval', ':=', $2)`,
        [username, String(interim)],
      );

      const serviceType = opts?.serviceType || 'PPPOE';
      const addReply = (attr: string, value: string, op = ':=') =>
        this.pgClient.query(
          `INSERT INTO radreply (username, attribute, op, value) VALUES ($1, $2, $3, $4)`,
          [username, attr, op, value],
        );

      // If the package has linked RADIUS policies, use them as the source of truth
      // and skip the auto-computed speed/rate-limit entirely. This lets operators
      // define arbitrary RADIUS attributes (Mikrotik-Rate-Limit, Ascend-*,
      // Huawei-*, etc.) per package via the Policies UI.
      if (pkg?.policyAttributes && pkg.policyAttributes.length > 0) {
        for (const pa of pkg.policyAttributes) {
          await addReply(pa.attribute, pa.value, pa.op);
        }
        this.logger.log(
          `✅ RADIUS profile synced for "${username}" — ` +
            `${pkg.policyAttributes.length} policy attributes written`,
        );
        // Still write addressing (Framed-IP-Address / Framed-Pool) even when
        // policies are active — the pool is about connectivity, not speed.
        if (opts?.staticIp) {
          await addReply('Framed-IP-Address', opts.staticIp);
          await addReply('Framed-IP-Netmask', '255.255.255.255');
        } else if (pkg.pool?.name) {
          await addReply('Framed-Pool', pkg.pool.name);
        }
      } else {
        // ── No policy attributes — compute rate-limit from package speed fields ──
        if (pkg) {
          const rateLimit = this.buildRateLimit(pkg);
          await addReply('Mikrotik-Rate-Limit', rateLimit);

          // ── Addressing ────────────────────────────────────────
          // Priority: an explicit static IP beats the package pool. Business
          // customers are sold a fixed address and it must win.
          let addressing = 'none';
          if (opts?.staticIp) {
            await addReply('Framed-IP-Address', opts.staticIp);
            // /32 — the customer gets exactly this address, not a range.
            await addReply('Framed-IP-Netmask', '255.255.255.255');
            addressing = `static ${opts.staticIp}`;
          } else if (pkg.pool?.name) {
            // Framed-Pool ONLY. Do not also send Framed-IP-Address here.
            //
            // 255.255.255.254 is sometimes described as a "let the NAS choose"
            // sentinel (RFC 2865), but MikroTik does not treat it that way — it
            // takes the value literally, assigns 255.255.255.254 to the session,
            // finds it unusable and terminates immediately. The customer then
            // redials every few seconds forever. The router log gives it away:
            //   "logged in, 255.255.255.254" followed by "terminating..."
            //
            // With Framed-Pool alone the router allocates from the named pool,
            // which is the behaviour we actually want.
            await addReply('Framed-Pool', pkg.pool.name);
            addressing = `pool ${pkg.pool.name}`;
          }

          // ── Service-specific attributes ───────────────────────
          if (serviceType === 'HOTSPOT') {
            // Hotspot users are usually sold time or data, not a month of
            // always-on service, so limits are the norm rather than exception.
            if (opts?.sessionTimeout) {
              await addReply('Session-Timeout', String(opts.sessionTimeout));
            }
            // Free the session when the user walks away, so the slot and the
            // address return to the pool instead of idling all day.
            await addReply('Idle-Timeout', String(opts?.idleTimeout ?? 900));
            // MikroTik hotspot honours this for per-user queues.
            await addReply('Mikrotik-Address-List', 'hotspot-users');
          } else if (serviceType === 'PPPOE') {
            if (opts?.idleTimeout) {
              await addReply('Idle-Timeout', String(opts.idleTimeout));
            }
          }

          this.logger.log(
            `✅ RADIUS profile synced for "${username}" — ` +
              `${serviceType}, speed ${rateLimit}, ${addressing}`,
          );
        } else {
          this.logger.warn(
            `⚠️ "${username}" added to RADIUS with no package — no speed limit, no IP pool`,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(
        `❌ Failed to sync RADIUS profile for "${username}": ${error.message}`,
      );
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC: Update password only (used when only password changes)
  // ─────────────────────────────────────────────────────────────
  async updateSubscriberPasswordInRadius(
    username: string,
    newPassword: string,
  ): Promise<void> {
    this.ensureConnected();
    try {
      const result = await this.pgClient.query(
        `SELECT id FROM radcheck
         WHERE username = $1 AND attribute = 'Cleartext-Password'`,
        [username],
      );

      if (result.rows.length > 0) {
        await this.pgClient.query(
          `UPDATE radcheck SET value = $2
           WHERE username = $1 AND attribute = 'Cleartext-Password'`,
          [username, newPassword],
        );
        this.logger.log(`✅ Password updated in RADIUS for "${username}"`);
      } else {
        // User doesn't exist yet — create with just password
        await this.syncSubscriberProfile(username, newPassword, null);
      }
    } catch (error: any) {
      this.logger.error(
        `❌ Failed to update password in RADIUS: ${error.message}`,
      );
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC: Remove subscriber completely from RADIUS
  // ─────────────────────────────────────────────────────────────
  async removeSubscriberFromRadius(username: string): Promise<void> {
    this.ensureConnected();
    try {
      /**
       * "Fully removed" was not full.
       *
       * Only radcheck and radreply were cleared, leaving two things behind:
       *
       *   • radusergroup — group membership. FreeRADIUS resolves attributes
       *     through groups as well as through the user, so a leftover row can
       *     keep granting access on its own.
       *   • radacct — the OPEN session row. Left dangling, the panel still
       *     counts the customer as online and the pool address stays marked
       *     in use, so it cannot be reissued to anyone else.
       */
      await this.pgClient.query('DELETE FROM radcheck     WHERE username = $1', [username]);
      await this.pgClient.query('DELETE FROM radreply     WHERE username = $1', [username]);
      await this.pgClient.query('DELETE FROM radusergroup WHERE username = $1', [username]);

      // Close, do not delete, the accounting rows: they are the usage history
      // and the basis of any dispute. Just stop them looking live.
      const closed = await this.pgClient.query(
        `UPDATE radacct
            SET acctstoptime = NOW(),
                acctterminatecause = 'Admin-Reset'
          WHERE username = $1 AND acctstoptime IS NULL`,
        [username],
      );

      this.logger.log(
        `✅ "${username}" removed from RADIUS (radcheck, radreply, radusergroup` +
        `${closed.rowCount ? `, ${closed.rowCount} open session(s) closed` : ''})`,
      );
    } catch (error: any) {
      this.logger.error(
        `❌ Failed to remove "${username}" from RADIUS: ${error.message}`,
      );
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC: Check if subscriber exists in RADIUS (radcheck entry)
  // ─────────────────────────────────────────────────────────────
  async isSubscriberInRadius(username: string): Promise<boolean> {
    try {
      this.ensureConnected();
      const result = await this.pgClient.query(
        `SELECT id FROM radcheck WHERE username = $1 LIMIT 1`,
        [username],
      );
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC: Get full RADIUS profile (radcheck + radreply) for debugging
  // ─────────────────────────────────────────────────────────────
  async getSubscriberFromRadius(username: string): Promise<any> {
    this.ensureConnected();
    try {
      const [check, reply] = await Promise.all([
        this.pgClient.query(
          'SELECT attribute, value FROM radcheck WHERE username = $1',
          [username],
        ),
        this.pgClient.query(
          'SELECT attribute, value FROM radreply WHERE username = $1',
          [username],
        ),
      ]);
      return {
        username,
        radcheck: check.rows,
        radreply: reply.rows,
      };
    } catch (error: any) {
      this.logger.error(`❌ Failed to get subscriber from RADIUS: ${error.message}`);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // LEGACY: Add subscriber with only password (no package)
  // Used for backward compatibility; prefer syncSubscriberProfile.
  // ─────────────────────────────────────────────────────────────
  async addSubscriberToRadius(username: string, password: string): Promise<void> {
    await this.syncSubscriberProfile(username, password, null);
  }

  // ─────────────────────────────────────────────────────────────
  // BULK SYNC (used by syncAllToRadius in SubscribersService)
  // ─────────────────────────────────────────────────────────────
  async bulkSyncSubscribers(
    subscribers: Array<{ username: string; password: string }>,
  ): Promise<{ total: number; success: number; failed: number }> {
    this.ensureConnected();
    let success = 0;
    let failed = 0;

    for (const sub of subscribers) {
      try {
        await this.syncSubscriberProfile(sub.username, sub.password, null);
        success++;
      } catch {
        failed++;
        this.logger.error(`❌ Bulk sync failed for "${sub.username}"`);
      }
    }

    this.logger.log(
      `📊 Bulk sync complete: ${success} success, ${failed} failed of ${subscribers.length} total`,
    );
    return { total: subscribers.length, success, failed };
  }

  // ─────────────────────────────────────────────────────────────
  // NAS MANAGEMENT
  // ─────────────────────────────────────────────────────────────
  async addNasToRadius(
    nasIp: string,
    nasName: string,
    secret: string,
  ): Promise<void> {
    this.ensureConnected();
    try {
      const existing = await this.pgClient.query(
        'SELECT id FROM nas WHERE nasname = $1',
        [nasIp],
      );

      if (existing.rows.length > 0) {
        await this.pgClient.query(
          `UPDATE nas SET shortname=$1, secret=$2, description=$3, type='other'
           WHERE nasname=$4`,
          [nasName, secret, `Auto-synced from CRM: ${nasName}`, nasIp],
        );
        this.logger.log(`✅ NAS updated in FreeRADIUS: ${nasName} (${nasIp})`);
      } else {
        await this.pgClient.query(
          `INSERT INTO nas (nasname, shortname, type, secret, description)
           VALUES ($1, $2, 'other', $3, $4)`,
          [nasIp, nasName, secret, `Auto-synced from CRM: ${nasName}`],
        );
        this.logger.log(`✅ NAS added to FreeRADIUS: ${nasName} (${nasIp})`);
      }

      await this.reloadFreeradius();
    } catch (error: any) {
      this.logger.error(
        `❌ Failed to add/update NAS in RADIUS: ${error.message}`,
      );
      throw error;
    }
  }

  async removeNasFromRadius(nasIp: string): Promise<void> {
    this.ensureConnected();
    try {
      const result = await this.pgClient.query(
        'DELETE FROM nas WHERE nasname = $1 RETURNING id',
        [nasIp],
      );
      if (result.rows.length > 0) {
        this.logger.log(`✅ NAS removed from FreeRADIUS: ${nasIp}`);
        await this.reloadFreeradius();
      } else {
        this.logger.warn(`⚠️ NAS not found in FreeRADIUS: ${nasIp}`);
      }
    } catch (error: any) {
      this.logger.error(
        `❌ Failed to remove NAS from RADIUS: ${error.message}`,
      );
      throw error;
    }
  }

  async getAllNasFromRadius(): Promise<any[]> {
    this.ensureConnected();
    try {
      const result = await this.pgClient.query(
        'SELECT id, nasname, shortname, secret, type, description FROM nas ORDER BY id',
      );
      return result.rows;
    } catch (error: any) {
      this.logger.error(`❌ Failed to get NAS list: ${error.message}`);
      return [];
    }
  }

  async getNasByIp(nasIp: string): Promise<any> {
    this.ensureConnected();
    try {
      const result = await this.pgClient.query(
        'SELECT id, nasname, shortname, secret, type, description FROM nas WHERE nasname = $1',
        [nasIp],
      );
      return result.rows[0] || null;
    } catch (error: any) {
      this.logger.error(`❌ Failed to get NAS by IP: ${error.message}`);
      return null;
    }
  }

  async isNasRegistered(nasIp: string): Promise<boolean> {
    try {
      this.ensureConnected();
      const result = await this.pgClient.query(
        'SELECT id FROM nas WHERE nasname = $1',
        [nasIp],
      );
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }

  async updateNasSecret(nasIp: string, newSecret: string): Promise<void> {
    this.ensureConnected();
    try {
      await this.pgClient.query(
        'UPDATE nas SET secret = $1 WHERE nasname = $2',
        [newSecret, nasIp],
      );
      this.logger.log(`✅ NAS secret updated for ${nasIp}`);
      await this.reloadFreeradius();
    } catch (error: any) {
      this.logger.error(`❌ Failed to update NAS secret: ${error.message}`);
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // RADIUS STATUS & MONITORING
  // ─────────────────────────────────────────────────────────────
  async isRadiusAlive(): Promise<{
    alive: boolean;
    nasCount: number;
    activeSessionCount: number;
  }> {
    try {
      this.ensureConnected();
      const [nasResult, sessionResult] = await Promise.all([
        this.pgClient.query('SELECT COUNT(*) FROM nas'),
        this.pgClient.query(
          'SELECT COUNT(*) FROM radacct WHERE acctstoptime IS NULL',
        ),
      ]);
      return {
        alive: true,
        nasCount: parseInt(nasResult.rows[0].count),
        activeSessionCount: parseInt(sessionResult.rows[0].count),
      };
    } catch (error: any) {
      this.logger.error(`RADIUS health check failed: ${error.message}`);
      return { alive: false, nasCount: 0, activeSessionCount: 0 };
    }
  }

  async getActiveSessions(nasIp?: string): Promise<any[]> {
    try {
      this.ensureConnected();
      let query = `
        SELECT
          username,
          nasipaddress,
          framedipaddress,
          callingstationid,
          acctstarttime,
          GREATEST(
            0,
            COALESCE(NULLIF(acctsessiontime, 0),
                     EXTRACT(EPOCH FROM (NOW() - acctstarttime))::int)
          ) AS duration_seconds,
          acctinputoctets  AS upload_bytes,
          acctoutputoctets AS download_bytes
        FROM radacct
        WHERE acctstoptime IS NULL
          -- Same freshness rule as the subscriber list / overview: a session
          -- whose Accounting-Stop never arrived is not a live session.
          AND COALESCE(acctupdatetime, acctstarttime) > NOW() - INTERVAL '15 minutes'
      `;
      const params: any[] = [];
      if (nasIp) {
        query += ' AND nasipaddress = $1';
        params.push(nasIp);
      }
      query += ' ORDER BY acctstarttime DESC';
      const result = await this.pgClient.query(query, params);
      return result.rows;
    } catch (error: any) {
      this.logger.error(`Failed to get active sessions: ${error.message}`);
      return [];
    }
  }

  async getAuthStats(): Promise<{ accepts: number; rejects: number }> {
    try {
      this.ensureConnected();
      const result = await this.pgClient.query(`
        SELECT reply, COUNT(*) as count
        FROM radpostauth
        WHERE authdate > NOW() - INTERVAL '24 hours'
        GROUP BY reply
      `);
      let accepts = 0;
      let rejects = 0;
      for (const row of result.rows) {
        if (row.reply === 'Access-Accept') accepts = parseInt(row.count);
        if (row.reply === 'Access-Reject') rejects = parseInt(row.count);
      }
      return { accepts, rejects };
    } catch (error: any) {
      this.logger.error(`Failed to get auth stats: ${error.message}`);
      return { accepts: 0, rejects: 0 };
    }
  }

  async testRadiusConnection(): Promise<boolean> {
    try {
      this.ensureConnected();
      await this.pgClient.query('SELECT 1');
      return true;
    } catch (error: any) {
      this.logger.error(`RADIUS connection test failed: ${error.message}`);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PRIVATE: Reload FreeRADIUS after NAS changes
  // ─────────────────────────────────────────────────────────────
  async reloadFreeradius(): Promise<void> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      await execAsync('sudo systemctl reload freeradius 2>&1');
      this.logger.log('✅ FreeRADIUS reloaded successfully');
    } catch (error: any) {
      this.logger.warn(`⚠️ Could not reload FreeRADIUS: ${error.message}`);
      this.logger.warn(
        'NAS changes will take effect within 60 seconds or on next restart',
      );
    }
  }
}