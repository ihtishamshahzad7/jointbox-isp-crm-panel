"use client";

/**
 * Router by router: is it in FreeRADIUS's list, and if not, why.
 *
 * The backend scopes the list (GET /nas/radius/vault/routers): the platform
 * account sees every router on the server by id and address; a company sees
 * only its own routers and whether the server's FreeRADIUS sync is healthy.
 * No secret ever reaches this screen.
 */
import { useCallback, useEffect, useState } from "react";
import API_BASE from "./api";
import s from "./radius-routers.module.css";

type Router = {
  id: number;
  name: string | null;
  ip: string | null;
  active: boolean;
  state: "in-freeradius" | "left-out" | "disabled";
  reason: string | null;
  hasSecret: boolean;
  legacyPlaintextKept: boolean;
  lastAccountingAt: string | null;
  onlineSessions: number;
};
type Report = {
  mode: "file" | "sql";
  freeradiusRunning: boolean | null;
  syncHealthy: boolean | null;
  lastOkAt: string | null;
  lastError: string | null;
  routers: Router[];
};

function headers(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") || "" : "";
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function ago(iso: string | null): string {
  if (!iso) return "—";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 90) return `${secs}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)} min ago`;
  if (secs < 129600) return `${Math.round(secs / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}

/** What the operator does about a router that is left out. */
function remedy(reason: string | null): string {
  const r = reason || "";
  if (/no RADIUS secret/i.test(r)) return "Enter the router's RADIUS secret on its router page.";
  if (/cannot be decrypted/i.test(r)) return "Re-enter the secret on the router page, or restore the original SECRETS_KEY in backend/.env.";
  if (/characters/i.test(r)) return "Re-enter the secret using letters, digits and ordinary symbols only.";
  if (/same address/i.test(r)) return "Two routers share this address — give each its own.";
  if (/clients\.conf/i.test(r)) return "This address is already a client in clients.conf — change the router's address or remove that client.";
  if (/single IP/i.test(r)) return "Edit the router and enter one IPv4 address.";
  return "Open the router and save it again.";
}

export default function RadiusRouters({ platform = false }: { platform?: boolean }) {
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/nas/radius/vault/routers`, { headers: headers() });
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.message || "Could not load the router list."); return; }
      setError("");
      setData(body as Report);
    } catch {
      setError("Could not reach the server.");
    }
  }, []);

  // Fetch on mount; state is only set after the request resolves.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const retire = async (all: boolean) => {
    if (all && !window.confirm("Remove the plain-text copy of EVERY router secret now?\n\nOnly do this after customers have logged in through each router since the switch. The encrypted copies stay; FreeRADIUS keeps working.")) return;
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`${API_BASE}/nas/radius/vault/retire-plaintext`, { method: "POST", headers: headers(), body: JSON.stringify({ all }) });
      const body = await r.json().catch(() => null);
      if (!r.ok) setNote({ tone: "bad", text: body?.message || "Could not retire the plain-text copies." });
      else setNote({ tone: body.kept?.length ? "warn" : "ok", text: `Retired ${body.retired} plain-text cop${body.retired === 1 ? "y" : "ies"}${body.kept?.length ? `; ${body.kept.length} kept until those routers are proven` : ""}.` });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const routers = data?.routers ?? [];
  const leftOut = routers.filter((r) => r.state === "left-out").length;
  const kept = routers.filter((r) => r.legacyPlaintextKept).length;
  const healthTone = !data ? "warn" : data.freeradiusRunning === false || data.syncHealthy === false ? "bad" : leftOut ? "warn" : "ok";

  return (
    <section className={s.panel} aria-label="FreeRADIUS routers">
      <div className={s.head}>
        <div>
          <div className={s.eyebrow}>{platform ? "Every router on this server" : "Your routers"}</div>
          <h3 className={s.title}>Routers known to FreeRADIUS</h3>
        </div>
        <div className={s.actions}>
          <button type="button" className={s.action} onClick={() => void load()} disabled={busy}>Refresh</button>
          {platform && kept > 0 && (
            <>
              <button type="button" className={s.action} onClick={() => void retire(false)} disabled={busy}>Retire proven plain-text copies</button>
              <button type="button" className={s.action} onClick={() => void retire(true)} disabled={busy}>Retire all after testing…</button>
            </>
          )}
        </div>
      </div>

      {error && <p className={`${s.message} ${s.badText}`}>{error}</p>}

      {data && (
        <div className={s.chips}>
          <span className={`${s.chip} ${data.freeradiusRunning === false ? s.bad : data.freeradiusRunning ? s.ok : s.warn}`}>
            <i className={s.dot} aria-hidden />FreeRADIUS {data.freeradiusRunning === false ? "stopped" : data.freeradiusRunning ? "running" : "not on this server"}
          </span>
          <span className={`${s.chip} ${s[healthTone]}`}>
            <i className={s.dot} aria-hidden />Sync {data.syncHealthy === false ? "failing" : "healthy"}
          </span>
          <span className={s.chip}>Last good sync: {ago(data.lastOkAt)}</span>
          <span className={s.chip}>{routers.filter((r) => r.state === "in-freeradius").length} of {routers.filter((r) => r.active).length} active in the list</span>
          {platform && <span className={`${s.chip} ${data.mode === "file" ? s.ok : s.warn}`}><i className={s.dot} aria-hidden />{data.mode === "file" ? "Encrypted vault file" : "Still reading SQL (not switched)"}</span>}
          {platform && kept > 0 && <span className={`${s.chip} ${s.warn}`}><i className={s.dot} aria-hidden />{kept} plain-text cop{kept === 1 ? "y" : "ies"} kept until proven</span>}
        </div>
      )}

      {data?.lastError && <p className={`${s.message} ${s.badText}`}>{data.lastError}</p>}
      {platform && data?.mode === "sql" && (
        <p className={`${s.message} ${s.warnText}`}>
          FreeRADIUS on this server still takes router secrets from the database. Run the update (or
          <span className={s.mono}> sudo bash backend/scripts/radius-vault-cutover.sh --dry-run</span> first) to switch it to the encrypted file.
        </p>
      )}
      {note && <p className={`${s.message} ${s[`${note.tone}Text`]}`}>{note.text}</p>}

      {data && (
        routers.length === 0 ? <p className={s.empty}>No routers yet.</p> : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Router</th>
                  <th scope="col">Address</th>
                  <th scope="col">In FreeRADIUS</th>
                  <th scope="col">Last accounting</th>
                  <th scope="col">Online</th>
                  {platform && <th scope="col">Plain-text copy</th>}
                </tr>
              </thead>
              <tbody>
                {routers.map((r) => (
                  <tr key={r.id}>
                    <td>#{r.id}{r.name ? ` · ${r.name}` : ""}</td>
                    <td className={s.mono}>{r.ip || "—"}</td>
                    <td>
                      {r.state === "in-freeradius" && <span className={`${s.state} ${s.okText}`}>Yes</span>}
                      {r.state === "disabled" && <span className={s.state}>Disabled</span>}
                      {r.state === "left-out" && (
                        <>
                          <span className={`${s.state} ${s.badText}`}>Left out — {r.reason}</span>
                          <span className={s.reason}>{remedy(r.reason)}</span>
                        </>
                      )}
                    </td>
                    <td>{ago(r.lastAccountingAt)}</td>
                    <td>{r.onlineSessions}</td>
                    {platform && <td>{r.legacyPlaintextKept ? <span className={s.warnText}>kept</span> : <span className={s.muted}>—</span>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </section>
  );
}
