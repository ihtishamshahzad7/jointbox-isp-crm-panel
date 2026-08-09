"use client";

import { useEffect, useState } from "react";
import { Icons as SIcons } from "../components/icons";
import API_BASE from "../components/api";

const API = API_BASE;

export default function FranchiseGroupsPage() {
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedGroup, setExpandedGroup] = useState<number | null>(null);
  const [groupDetail, setGroupDetail] = useState<any>(null);
  const [token, setToken] = useState<string | null>(null);
  const headers = token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : {};

  useEffect(() => {
    const t = localStorage.getItem("token");
    setToken(t);
    if (!t) return;
    loadGroups();
  }, []);

  const loadGroups = async () => {
    const t = localStorage.getItem("token");
    if (!t) return;
    setLoading(true);
    const res = await fetch(`${API}/groups`, { headers: { Authorization: `Bearer ${t}` } });
    if (res.ok) {
      const data = await res.json();
      setGroups(Array.isArray(data) ? data : data?.data || data?.items || []);
    }
    setLoading(false);
  };

  const loadGroupDetail = async (id: number) => {
    const t = localStorage.getItem("token");
    if (!t) return;
    const res = await fetch(`${API}/groups/${id}`, { headers: { Authorization: `Bearer ${t}` } });
    if (res.ok) setGroupDetail(await res.json());
    setExpandedGroup(id);
  };

  const closeDetail = () => { setExpandedGroup(null); setGroupDetail(null); };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "'DM Sans','Segoe UI',system-ui,sans-serif", fontSize: 13 }}>
      <div style={{ flex: 1, padding: "16px 20px", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0, letterSpacing: "-0.02em" }}>🏢 Franchise Groups</h1>
            <p style={{ fontSize: 11, color: "var(--muted)", margin: "4px 0 0" }}>Manage which franchises can see and sell which packages</p>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: 50, color: "var(--muted)" }}>
            <div style={{ width: 32, height: 32, border: "2px solid var(--border)", borderTopColor: "#818cf8", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 12px" }}></div>
            Loading groups...
          </div>
        ) : groups.length === 0 ? (
          <div style={{ textAlign: "center", padding: 50, background: "var(--surface)", borderRadius: 14, border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🏢</div>
            <h3 style={{ fontSize: 18, color: "var(--text)", marginBottom: 6 }}>No Franchise Groups</h3>
            <p style={{ color: "var(--muted)", fontSize: 13 }}>Groups are used to organize franchises and control which packages they can see.</p>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {groups.map((g: any) => (
              <div key={g.id} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", cursor: "pointer" }}
                  onClick={() => expandedGroup === g.id ? closeDetail() : loadGroupDetail(g.id)}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: g.color || "#818cf8" }}></div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{g.name}</div>
                      {g.description && <div style={{ fontSize: 11, color: "var(--muted)" }}>{g.description}</div>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: "var(--muted)" }}>{g._count?.members || 0} members · {g._count?.pkgResources || 0} packages</span>
                    <span style={{ fontSize: 10, color: "var(--muted)" }}>{expandedGroup === g.id ? "▲" : "▼"}</span>
                  </div>
                </div>

                {expandedGroup === g.id && groupDetail && groupDetail.id === g.id && (
                  <div style={{ borderTop: "1px solid var(--border)", padding: "16px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                      {/* Members */}
                      <div>
                        <h4 style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", margin: "0 0 8px" }}>
                          Members ({groupDetail.members?.length || 0})
                        </h4>
                        {groupDetail.members?.length === 0 ? (
                          <div style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>No members</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {groupDetail.members.map((m: any) => (
                              <div key={m.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", background: "rgba(255,255,255,0.02)", borderRadius: 6 }}>
                                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{m.user?.name || `User #${m.userId}`}</span>
                                <span style={{ fontSize: 10, color: "var(--muted)" }}>{m.user?.role}{m.propagate ? " (inherits)" : ""}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Packages */}
                      <div>
                        <h4 style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", margin: "0 0 8px" }}>
                          Packages ({groupDetail.pkgResources?.length || 0})
                        </h4>
                        {groupDetail.pkgResources?.length === 0 ? (
                          <div style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>No packages assigned</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {groupDetail.pkgResources.map((r: any) => (
                              <div key={r.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", background: "rgba(255,255,255,0.02)", borderRadius: 6 }}>
                                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{r.package?.name || `Package #${r.packageId}`}</span>
                                <span style={{ fontSize: 10, color: "var(--muted)" }}>{r.package?.price ? `$${r.package.price}` : ""}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--muted)", textAlign: "center" }}>
          Use the <strong>Franchise</strong> button on any package to set different wholesale prices per franchise group member.
        </div>
      </div>
    </div>
  );
}
