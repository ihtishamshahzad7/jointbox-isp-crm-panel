/**
 * TEMPORARY DIAGNOSTIC — reproduces the discover flow against the fake
 * RouterOS agent WITHOUT a database: instantiates the real NdmSnmpService
 * (snmp.service.ts) and calls readInterfaceTable exactly like
 * ndm.service.discover() does. Not committed. Delete after diagnosis.
 *
 * Usage:
 *   node scripts/repro-discover.js            # normal (well-behaved) device
 *   FAKE_STALL_AFTER=300 node ...             # device stops replying mid-walk
 *
 * The agent runs in-process (no harness needed).
 */
process.env.TS_NODE_TRANSPILE_ONLY = "1";
require("ts-node/register");

const { spawn } = require("child_process");
const path = require("path");
const net = require("net");

const TESTPORT = 1161;

// ── 1. start the fake agent as a child process ──────────────────────
let agentUp = false;
const agent = spawn(process.execPath, [path.join(__dirname, "snmp-fake-agent.js")], {
  env: { ...process.env, PORT: String(TESTPORT), FAKE_STALL_AFTER: process.env.FAKE_STALL_AFTER || "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
agent.stdout.on("data", (d) => { if (d.includes("[fake-agent]")) agentUp = true; process.stdout.write(`[agent] ${d}`); });
agent.stderr.on("data", (d) => process.stderr.write(`[agent:err] ${d}`));

const waitPort = () =>
  new Promise((res, rej) => {
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (tries > 300) { clearInterval(t); rej(new Error("fake agent never came up")); return; }
      if (agentUp) { clearInterval(t); res(); }
    }, 50);
  });

(async () => {
  await waitPort();
  console.log("[repro] fake agent up — loading real NdmSnmpService");

  const { NdmSnmpService } = require("../src/ndm/snmp.service");
  const svc = new NdmSnmpService({}, {}); // prisma/secrets stubs — never used (we pass _creds, like the wizard)

  const t0 = Date.now();
  const device = {
    id: -1,
    ip: "127.0.0.1",
    snmpVersion: "V2C",
    snmpPort: TESTPORT,
    snmpTimeoutMs: 5000,
    snmpRetries: 1,
    vendor: "MIKROTIK",
    _creds: { community: "public" }, // staged credentials (same as testBody())
  };

  console.log("[repro] calling readInterfaceTable (the discover path)…");
  const res = await svc.readInterfaceTable(device);
  const ms = Date.now() - t0;
  console.log(`[repro] DONE in ${ms} ms`);
  console.log(`[repro] ok=${res.ok} reachable=${res.reachable} interfaces=${res.interfaces.length} sysName=${res.sysName}`);
  if (res.error) console.log(`[repro] error=${res.error}`);
  console.log(`[repro] first rows: ${res.interfaces.slice(0, 3).map((r) => `${r.ifIndex}:${r.name} oper=${r.operStatus} spd=${r.speedMbps}`).join(" | ")}`);

  agent.kill();
  process.exit(0);
})().catch((e) => {
  console.error("[repro] FAILED:", e);
  agent.kill();
  process.exit(1);
});