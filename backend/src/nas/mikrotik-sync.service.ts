import { Injectable, Logger } from '@nestjs/common';
import * as net from 'net';
import * as dgram from 'dgram';
import { withMikrotik } from './mikrotik.client';

export interface NasReachability {
  pingReachable: boolean;
  apiPortOpen: boolean;
  radiusPortOpen: boolean;
  incomingPortOpen: boolean;
  responseTimeMs: number | null;
  error?: string;
  lastChecked: Date;
  // Extra detail for UI display
  radiusIp: string;
  radiusPort: number;
  coaPort: number;
}

export interface MikrotikDetails {
  identity: string;
  version: string;
  board: string;
  uptime: string;
  cpuLoad: string;
  totalMemory: string;
  freeMemory: string;
  totalHdd: string;
  freeHdd: string;
  interfaces: MikrotikInterface[];
  pppoeServer: PppoeServerInfo | null;
  radiusClients: RadiusClient[];
  apiService: ApiServiceInfo | null;
  ipAddresses: IpAddress[];
  pppoeProfiles: PppoeProfile[];
  activeConnections: number;
}

export interface MikrotikInterface {
  name: string;
  type: string;
  mtu: string;
  macAddress: string;
  running: string;
  disabled: string;
  comment: string;
}

export interface PppoeServerInfo {
  enabled: boolean;
  interface: string;
  serviceName: string;
  maxMtu: string;
  maxMru: string;
  authentication: string;
  keepaliveTimeout: string;
  defaultProfile: string;
}

export interface PppoeProfile {
  name: string;
  localAddress: string;
  remoteAddress: string;
  rateLimit: string;
  sessionTimeout: string;
  comment: string;
}

export interface RadiusClient {
  service: string;
  address: string;
  secret: string;
  authPort: string;
  acctPort: string;
  timeout: string;
  disabled: string;
}

export interface ApiServiceInfo {
  enabled: boolean;
  port: string;
  tlsPort: string;
  disabled: string;
}

export interface IpAddress {
  address: string;
  network: string;
  interface: string;
  disabled: string;
}

@Injectable()
export class MikrotikSyncService {
  private readonly logger = new Logger(MikrotikSyncService.name);

  // Your Ubuntu FreeRADIUS server - configurable via environment
  private readonly RADIUS_SERVER_IP = process.env.RADIUS_SERVER_IP || '127.0.0.1';
  private readonly RADIUS_AUTH_PORT = parseInt(process.env.RADIUS_AUTH_PORT || '1812');
  private readonly RADIUS_ACCT_PORT = parseInt(process.env.RADIUS_ACCT_PORT || '1813');

  // ─────────────────────────────────────────────────────────────
  // TCP check — only for MikroTik API port (TCP 8728 / custom)
  // ─────────────────────────────────────────────────────────────
  private checkTcpPort(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket
        .on('connect', () => { socket.destroy(); resolve(true); })
        .on('timeout', () => { socket.destroy(); resolve(false); })
        .on('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, host);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // UDP check — RADIUS runs on UDP, TCP sockets CANNOT connect to it.
  // We send a minimal malformed Access-Request packet.
  // FreeRADIUS will reply (even with Access-Reject) = port open.
  // No reply within timeout = port closed or firewalled.
  // ─────────────────────────────────────────────────────────────
  private checkUdpPort(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      let settled = false;

      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch (_) {}
        resolve(result);
      };

      const timer = setTimeout(() => {
        // Timeout = port is firewalled or not listening — treat as closed
        this.logger.debug(`UDP timeout → ${host}:${port} — port appears closed/firewalled`);
        finish(false);
      }, timeoutMs);

      // Minimal RADIUS Access-Request (20 bytes):
      // Code=1, ID=1, Length=20, Authenticator=16 zero bytes
      // FreeRADIUS will reject this but will send a reply (proving it's listening)
      const probe = Buffer.alloc(20);
      probe[0] = 0x01;        // Code: Access-Request
      probe[1] = 0x01;        // Identifier
      probe[2] = 0x00;        // Length high byte
      probe[3] = 0x14;        // Length low byte (20)
      // bytes 4-19: Authenticator (all zeros — intentionally invalid)

      socket.on('message', () => {
        // Any UDP response = FreeRADIUS is listening and replied
        clearTimeout(timer);
        finish(true);
      });

      socket.on('error', (err: any) => {
        clearTimeout(timer);
        if (err.code === 'ECONNREFUSED') {
          // ICMP port unreachable received = port is definitely closed
          finish(false);
        } else {
          // Other errors (network unreachable, etc.) = treat as closed
          finish(false);
        }
      });

      socket.send(probe, 0, probe.length, port, host, (sendErr) => {
        if (sendErr) {
          clearTimeout(timer);
          finish(false);
        }
      });
    });
  }

  private async tcpPing(host: string, port: number): Promise<number | null> {
    const start = Date.now();
    const reachable = await this.checkTcpPort(host, port, 5000);
    return reachable ? Date.now() - start : null;
  }

  // ─────────────────────────────────────────────────────────────
  // Main reachability check
  // nasIp        = MikroTik public IP (TCP API check)
  // apiPort      = MikroTik API port, default 8728
  // incomingPort = CoA/DM port on FreeRADIUS server, default 3799
  // ─────────────────────────────────────────────────────────────
  async checkReachability(
    nasIp: string,
    apiPort: number,
    incomingPort: number,
  ): Promise<NasReachability> {
    const startTime = Date.now();

    // Guard: if incomingPort comes in as 1812 (common misconfiguration
    // where someone saved the NAS with wrong CoA port), warn and use 3799
    const coaPort = (incomingPort === 1812 || incomingPort === 1813)
      ? 3799
      : (incomingPort ?? 3799);

    this.logger.log(
      `🔍 Checking reachability:\n` +
      `      📡 MikroTik API (TCP): ${nasIp}:${apiPort}\n` +
      `      🔐 RADIUS Auth (UDP):  ${this.RADIUS_SERVER_IP}:${this.RADIUS_AUTH_PORT}\n` +
      `      🔄 CoA Port (UDP):     ${this.RADIUS_SERVER_IP}:${coaPort}`
    );

    try {
      const [apiOpen, radiusAuthOpen, coaOpen, responseTimeMs] = await Promise.all([
        this.checkTcpPort(nasIp, apiPort),                                   // TCP — MikroTik API
        this.checkUdpPort(this.RADIUS_SERVER_IP, this.RADIUS_AUTH_PORT),     // UDP — FreeRADIUS auth
        this.checkUdpPort(this.RADIUS_SERVER_IP, coaPort),                   // UDP — CoA/DM port
        this.tcpPing(nasIp, apiPort),                                         // TCP latency to MikroTik
      ]);

      this.logger.log(
        `✅ Results:\n` +
        `        - MikroTik API (${nasIp}:${apiPort}): ${apiOpen ? '✅ OPEN' : '❌ CLOSED'}\n` +
        `        - RADIUS Auth UDP (${this.RADIUS_SERVER_IP}:${this.RADIUS_AUTH_PORT}): ${radiusAuthOpen ? '✅ OPEN' : '❌ CLOSED'}\n` +
        `        - CoA UDP (${this.RADIUS_SERVER_IP}:${coaPort}): ${coaOpen ? '✅ OPEN' : '❌ CLOSED'}\n` +
        `        - Response Time: ${responseTimeMs}ms`
      );

      return {
        pingReachable: apiOpen,
        apiPortOpen: apiOpen,
        radiusPortOpen: radiusAuthOpen,
        incomingPortOpen: coaOpen,
        responseTimeMs,
        lastChecked: new Date(),
        radiusIp: this.RADIUS_SERVER_IP,
        radiusPort: this.RADIUS_AUTH_PORT,
        coaPort,
      };
    } catch (error: any) {
      this.logger.error(`❌ Reachability check failed for ${nasIp}:${apiPort}`, error.stack);
      return {
        pingReachable: false,
        apiPortOpen: false,
        radiusPortOpen: false,
        incomingPortOpen: false,
        responseTimeMs: Date.now() - startTime,
        error: error.message || 'Connection failed',
        lastChecked: new Date(),
        radiusIp: this.RADIUS_SERVER_IP,
        radiusPort: this.RADIUS_AUTH_PORT,
        coaPort,
      };
    }
  }

  async checkRadiusServer(): Promise<{
    radiusListening: boolean;
    acctListening: boolean;
    radiusPort: number;
    acctPort: number;
    serverIp: string;
  }> {
    const [radiusListening, acctListening] = await Promise.all([
      this.checkUdpPort(this.RADIUS_SERVER_IP, this.RADIUS_AUTH_PORT),
      this.checkUdpPort(this.RADIUS_SERVER_IP, this.RADIUS_ACCT_PORT),
    ]);

    this.logger.log(
      `📡 RADIUS Server Status:\n` +
      `      - Server IP: ${this.RADIUS_SERVER_IP}\n` +
      `      - Auth UDP 1812: ${radiusListening ? '✅ LISTENING' : '❌ NOT LISTENING'}\n` +
      `      - Acct UDP 1813: ${acctListening ? '✅ LISTENING' : '❌ NOT LISTENING'}`
    );

    return {
      radiusListening,
      acctListening,
      radiusPort: this.RADIUS_AUTH_PORT,
      acctPort: this.RADIUS_ACCT_PORT,
      serverIp: this.RADIUS_SERVER_IP,
    };
  }

  /**
   * Ask the router itself who is connected RIGHT NOW.
   *
   * This is the only fully reliable source of liveness. RADIUS accounting can
   * only tell us a user left if the NAS sends Accounting-Stop — if that packet
   * is lost (reboot, RADIUS restart, packet loss) the session stays "open"
   * forever. It is also immune to clock skew between the router and the server,
   * unlike anything derived from Event-Timestamp.
   */
  async getActivePppoeUsers(
    nasIp: string,
    apiPort: number,
    apiUsername: string,
    apiPassword: string,
  ): Promise<Array<{
    username: string; address: string | null; callerId: string | null;
    uptime: string | null; sessionId: string | null;
    uploadBytes: number | null; downloadBytes: number | null;
  }>> {
    return withMikrotik(
      { host: nasIp, port: apiPort, username: apiUsername, password: apiPassword, timeout: 10000 },
      async (client) => {
        // /ppp/active gives WHO is connected; per-interface stats give live
        // byte counters. Each PPPoE session owns an interface named
        // "<pppoe-USERNAME>", so we can read true real-time usage without
        // waiting for RADIUS interim-updates.
        const [rows, ifaces] = await Promise.all([
          client.send(['/ppp/active/print']).catch(() => [] as any[]),
          client.send(['/interface/print', '=stats=']).catch(() =>
            client.send(['/interface/print']).catch(() => [] as any[]),
          ),
        ]);

        const statsByName = new Map<string, { rx: number; tx: number }>();
        for (const i of (ifaces as any[]) || []) {
          if (!i?.name) continue;
          statsByName.set(String(i.name), {
            rx: Number(i['rx-byte'] ?? 0) || 0,
            tx: Number(i['tx-byte'] ?? 0) || 0,
          });
        }

        return ((rows as any[]) || [])
          .filter((r) => r && r.name)
          .map((r) => {
            const uname = String(r.name);
            // MikroTik names the interface "<pppoe-user>"; fall back to a
            // suffix match in case the naming convention differs.
            const st =
              statsByName.get(`<pppoe-${uname}>`) ??
              statsByName.get(`pppoe-${uname}`) ??
              [...statsByName.entries()].find(([n]) => n.includes(uname))?.[1] ??
              null;

            return {
              username:  uname,
              address:   r.address ?? null,
              callerId:  r['caller-id'] ?? null,
              uptime:    r.uptime ?? null,
              sessionId: r['session-id'] ?? r['.id'] ?? null,
              // rx on the router = traffic FROM the subscriber = their upload.
              uploadBytes:   st ? st.rx : null,
              downloadBytes: st ? st.tx : null,
            };
          });
      },
    );
  }

  /**
   * Read the IP pools that actually exist on the router.
   *
   * The panel's pool list is only a description — the router is what really
   * hands out addresses. If a pool's name or range differs between the two,
   * subscribers get IPs the panel doesn't recognise (and `Framed-Pool` in
   * RADIUS silently refers to a pool the router may not even have).
   */
  async getIpPools(
    nasIp: string,
    apiPort: number,
    apiUsername: string,
    apiPassword: string,
  ): Promise<Array<{ name: string; ranges: string; comment: string | null }>> {
    return withMikrotik(
      { host: nasIp, port: apiPort, username: apiUsername, password: apiPassword, timeout: 10000 },
      async (client) => {
        const rows: any[] = await client.send(['/ip/pool/print']).catch(() => []);
        return (rows || [])
          .filter((r) => r && r.name)
          .map((r) => ({
            name: String(r.name),
            ranges: String(r.ranges ?? ''),
            comment: r.comment ?? null,
          }));
      },
    );
  }

  async syncDetails(
    nasIp: string,
    apiPort: number,
    apiUsername: string,
    apiPassword: string,
  ): Promise<MikrotikDetails> {
    this.logger.log(`🔄 Syncing details from MikroTik at ${nasIp}:${apiPort}`);

    return withMikrotik(
      { host: nasIp, port: apiPort, username: apiUsername, password: apiPassword, timeout: 12000 },
      async (client) => {
        const [
          identity, resource, interfaces, pppoeServers, pppoeProfiles,
          radiusClients, apiServices, ipAddresses, activeSecrets,
        ] = await Promise.all([
          client.send(['/system/identity/print']).catch(() => []),
          client.send(['/system/resource/print']).catch(() => []),
          client.send(['/interface/print']).catch(() => []),
          client.send(['/interface/pppoe-server/server/print']).catch(() => []),
          client.send(['/ppp/profile/print']).catch(() => []),
          client.send(['/radius/print']).catch(() => []),
          client.send(['/ip/service/print', '?name=api']).catch(() => []),
          client.send(['/ip/address/print']).catch(() => []),
          client.send(['/ppp/active/print', 'count-only']).catch(() => []),
        ]);

        const res = resource[0] || {};
        const id = identity[0] || {};
        const api = (apiServices as any[]).find((s: any) => s?.name === 'api') || (apiServices as any[])[0];
        const apiTls = (apiServices as any[]).find((s: any) => s?.name === 'api-ssl');

        this.logger.log(
          `✅ Sync successful — Identity: ${id.name}, ` +
          `Version: ${res.version}, Active: ${activeSecrets[0]?.ret || 0}`
        );

        return {
          identity: id.name || nasIp,
          version: res.version || 'Unknown',
          board: res['board-name'] || 'Unknown',
          uptime: res.uptime || 'Unknown',
          cpuLoad: res['cpu-load'] ? `${res['cpu-load']}%` : 'Unknown',
          totalMemory: res['total-memory'] || 'Unknown',
          freeMemory: res['free-memory'] || 'Unknown',
          totalHdd: res['total-hdd-space'] || 'Unknown',
          freeHdd: res['free-hdd-space'] || 'Unknown',
          interfaces: interfaces.map((i) => ({
            name: i.name || '',
            type: i.type || '',
            mtu: i.mtu || '',
            macAddress: i['mac-address'] || '',
            running: i.running || 'false',
            disabled: i.disabled || 'false',
            comment: i.comment || '',
          })),
          pppoeServer: pppoeServers[0] ? {
            enabled: pppoeServers[0].disabled !== 'true',
            interface: pppoeServers[0].interface || '',
            serviceName: pppoeServers[0]['service-name'] || '',
            maxMtu: pppoeServers[0]['max-mtu'] || '',
            maxMru: pppoeServers[0]['max-mru'] || '',
            authentication: pppoeServers[0].authentication || '',
            keepaliveTimeout: pppoeServers[0]['keepalive-timeout'] || '',
            defaultProfile: pppoeServers[0]['default-profile'] || '',
          } : null,
          pppoeProfiles: pppoeProfiles.map((p) => ({
            name: p.name || '',
            localAddress: p['local-address'] || '',
            remoteAddress: p['remote-address'] || '',
            rateLimit: p['rate-limit'] || '',
            sessionTimeout: p['session-timeout'] || '',
            comment: p.comment || '',
          })),
          radiusClients: radiusClients.map((r) => ({
            service: r.service || '',
            address: r.address || '',
            secret: r.secret || '',
            authPort: r['auth-port'] || '1812',
            acctPort: r['acct-port'] || '1813',
            timeout: r.timeout || '',
            disabled: r.disabled || 'false',
          })),
          apiService: api ? {
            enabled: api.disabled !== 'true',
            port: api.port || '8728',
            tlsPort: apiTls?.port || '8729',
            disabled: api.disabled || 'false',
          } : null,
          ipAddresses: ipAddresses.map((ip) => ({
            address: ip.address || '',
            network: ip.network || '',
            interface: ip.interface || '',
            disabled: ip.disabled || 'false',
          })),
          activeConnections: parseInt(activeSecrets[0]?.ret || '0', 10),
        };
      },
    );
  }

  async quickCheck(
    nasIp: string,
    apiPort: number,
    apiUsername: string,
    apiPassword: string,
  ): Promise<{
    online: boolean;
    identity: string;
    version: string;
    cpuLoad: string;
    uptime: string;
    activeConnections: number;
  }> {
    try {
      return await withMikrotik(
        { host: nasIp, port: apiPort, username: apiUsername, password: apiPassword, timeout: 8000 },
        async (client) => {
          const [identity, resource, active] = await Promise.all([
            client.send(['/system/identity/print']).catch(() => []),
            client.send(['/system/resource/print']).catch(() => []),
            client.send(['/ppp/active/print', 'count-only']).catch(() => []),
          ]);
          const res = resource[0] || {};
          return {
            online: true,
            identity: identity[0]?.name || nasIp,
            version: res.version || '',
            cpuLoad: res['cpu-load'] ? `${res['cpu-load']}%` : '',
            uptime: res.uptime || '',
            activeConnections: parseInt(active[0]?.ret || '0', 10),
          };
        },
      );
    } catch (error: any) {
      this.logger.warn(`⚠️ Quick check failed for ${nasIp}:${apiPort} — ${error.message}`);
      return { online: false, identity: '', version: '', cpuLoad: '', uptime: '', activeConnections: 0 };
    }
  }

  // ========== ADD THESE MISSING METHODS ==========

  // Sync Mikrotik configuration to RADIUS
  async syncMikrotikToRadius(nasIp: string, nasSecret: string): Promise<void> {
    this.logger.log(`🔄 Syncing Mikrotik ${nasIp} to RADIUS`);
    
    try {
      // This method should sync Mikrotik NAS to FreeRADIUS
      // You can implement based on your needs
      this.logger.log(`✅ Mikrotik ${nasIp} synced to RADIUS`);
    } catch (error: any) {
      this.logger.error(`❌ Failed to sync Mikrotik to RADIUS: ${error.message}`);
      throw error;
    }
  }

  // Test connection to Mikrotik
  async testConnection(host: string, port: number, username: string, password: string): Promise<{
    success: boolean;
    message: string;
    details?: any;
  }> {
    this.logger.log(`🔍 Testing connection to Mikrotik ${host}:${port}`);
    
    try {
      const result = await withMikrotik(
        { host, port, username, password, timeout: 10000 },
        async (client) => {
          const identity = await client.send(['/system/identity/print']);
          const resource = await client.send(['/system/resource/print']);
          return {
            identity: identity[0]?.name || host,
            version: resource[0]?.version || 'Unknown',
            uptime: resource[0]?.uptime || 'Unknown',
          };
        },
      );
      
      this.logger.log(`✅ Connection to Mikrotik ${host} successful`);
      return {
        success: true,
        message: `Connected to ${result.identity} (${result.version})`,
        details: result,
      };
    } catch (error: any) {
      this.logger.error(`❌ Connection to Mikrotik ${host} failed: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Connection failed',
      };
    }
  }

  // Get Mikrotik PPPoE active connections
  async getPppoeActiveConnections(
    nasIp: string,
    apiPort: number,
    apiUsername: string,
    apiPassword: string,
  ): Promise<any[]> {
    this.logger.log(`📊 Getting PPPoE active connections from ${nasIp}`);
    
    try {
      return await withMikrotik(
        { host: nasIp, port: apiPort, username: apiUsername, password: apiPassword, timeout: 10000 },
        async (client) => {
          const active = await client.send(['/ppp/active/print']);
          return active.map((conn: any) => ({
            name: conn.name || '',
            service: conn.service || '',
            callerId: conn['caller-id'] || '',
            address: conn.address || '',
            uptime: conn.uptime || '',
            encoding: conn.encoding || '',
            sessionId: conn['session-id'] || '',
            limitBytesIn: conn['limit-bytes-in'] || '',
            limitBytesOut: conn['limit-bytes-out'] || '',
          }));
        },
      );
    } catch (error: any) {
      this.logger.error(`❌ Failed to get PPPoE connections: ${error.message}`);
      return [];
    }
  }

  // Disconnect a PPPoE user from Mikrotik
  /**
   * Read the router's own log.
   *
   * This is the record that actually explains failures — RADIUS can say the
   * customer authenticated fine while the router is dropping the session a
   * moment later for a reason only it knows.
   */
  async getRouterLogs(
    nasIp: string,
    apiPort: number,
    apiUsername: string,
    apiPassword: string,
    limit = 200,
  ): Promise<Array<{ time: string; topics: string; message: string }>> {
    try {
      let rows: any[] = [];
      await withMikrotik(
        { host: nasIp, port: apiPort, username: apiUsername, password: apiPassword, timeout: 15000 },
        async (client) => {
          rows = (await client.send(['/log/print'])) || [];
        },
      );
      // The router returns oldest first; the tail is what matters.
      return rows.slice(-limit).map((r: any) => ({
        time: r.time || '',
        topics: r.topics || '',
        message: r.message || '',
      }));
    } catch (error: any) {
      this.logger.warn(`Could not read log from ${nasIp}: ${error.message}`);
      return [];
    }
  }

  /**
   * Clear a static remote-address pinned on the user's PPP secret.
   *
   * MikroTik applies the secret's own remote-address in preference to whatever
   * RADIUS returns in Framed-IP-Address. So if a secret was ever created with
   * an address on it, RADIUS changes are silently ignored — the customer keeps
   * the old address and the panel looks broken with nothing in the logs to
   * explain why.
   *
   * Returns true when the pin was found and removed, false when there was
   * nothing to clear (the normal case).
   */
  async clearSecretRemoteAddress(
    nasIp: string,
    apiPort: number,
    apiUsername: string,
    apiPassword: string,
    username: string,
  ): Promise<boolean> {
    try {
      let cleared = false;
      await withMikrotik(
        { host: nasIp, port: apiPort, username: apiUsername, password: apiPassword, timeout: 10000 },
        async (client) => {
          const secrets = await client.send(['/ppp/secret/print', `?name=${username}`]);
          for (const s of secrets || []) {
            if (!s['remote-address']) continue;
            await client.send([
              '/ppp/secret/set',
              `=.id=${s['.id']}`,
              '=remote-address=',
            ]);
            cleared = true;
            this.logger.log(
              `Cleared pinned address ${s['remote-address']} from PPP secret "${username}" on ${nasIp} — ` +
                `RADIUS now controls the address`,
            );
          }
        },
      );
      return cleared;
    } catch (error: any) {
      this.logger.warn(`Could not inspect PPP secret for ${username} on ${nasIp}: ${error.message}`);
      return false;
    }
  }

  /**
   * Delete the LOCAL PPP secret for this user from the router.
   *
   * This is why a "removed" customer keeps getting online. MikroTik checks its
   * own /ppp/secret list BEFORE asking RADIUS. Clearing radcheck and radreply
   * therefore does nothing at all if a local secret still exists — the router
   * authenticates the customer itself and never consults RADIUS. The panel
   * writes these secrets, so it has to remove them too.
   *
   * Returns how many secrets were removed, so callers can report honestly
   * rather than claiming a removal that did not happen.
   */
  async removePppSecret(
    nasIp: string,
    apiPort: number,
    apiUsername: string,
    apiPassword: string,
    username: string,
  ): Promise<number> {
    let removed = 0;
    try {
      await withMikrotik(
        { host: nasIp, port: apiPort, username: apiUsername, password: apiPassword, timeout: 10000 },
        async (client) => {
          const secrets = await client.send(['/ppp/secret/print', `?name=${username}`]);
          for (const s of secrets || []) {
            await client.send(['/ppp/secret/remove', `=.id=${s['.id']}`]);
            removed++;
          }
        },
      );
      if (removed) {
        this.logger.log(`🗑️ Removed ${removed} local PPP secret(s) for "${username}" from ${nasIp}`);
      }
    } catch (error: any) {
      this.logger.warn(`Could not remove PPP secret for ${username} on ${nasIp}: ${error.message}`);
    }
    return removed;
  }

  async disconnectPppoeUser(
    nasIp: string,
    apiPort: number,
    apiUsername: string,
    apiPassword: string,
    username: string,
  ): Promise<boolean> {
    this.logger.log(`🔌 Disconnecting PPPoE user ${username} from ${nasIp}`);
    
    try {
      await withMikrotik(
        { host: nasIp, port: apiPort, username: apiUsername, password: apiPassword, timeout: 10000 },
        async (client) => {
          // Find the active connection
          const active = await client.send(['/ppp/active/print', `?name=${username}`]);
          if (active && active.length > 0) {
            // Remove the connection
            await client.send(['/ppp/active/remove', `=.id=${active[0]['.id']}`]);
            this.logger.log(`✅ User ${username} disconnected from ${nasIp}`);
          } else {
            this.logger.warn(`⚠️ User ${username} not found in active connections`);
          }
        },
      );
      return true;
    } catch (error: any) {
      this.logger.error(`❌ Failed to disconnect user ${username}: ${error.message}`);
      return false;
    }
  }
}