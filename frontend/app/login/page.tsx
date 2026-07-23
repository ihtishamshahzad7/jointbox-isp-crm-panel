"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "../components/logo";

const NOVA = "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)";
const SUPPORT = "ehtisham@jointbox.net";

// Helper function to get backend URL - safely handles window object
const getBackendUrl = () => {
  // In production, use environment variable first
  if (process.env.NEXT_PUBLIC_BACKEND_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_URL;
  }
  
  // For client-side only - check if window exists
  if (typeof window !== 'undefined') {
    return `http://${window.location.hostname}:3001`;
  }
  
  // Fallback for server-side
  return 'http://localhost:3001';
};

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState("");
  const [needs2fa, setNeeds2fa] = useState(false);

  const router = useRouter();

  // Check if already logged in
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      router.push("/dashboard");
    }
  }, [router]);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setMessage("❌ Please enter both email and password");
      return;
    }

    setMessage("");
    setLoading(true);

    try {
      const backendUrl = getBackendUrl();
      console.log("Connecting to backend:", backendUrl);

      const response = await fetch(`${backendUrl}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password, code: code || undefined }),
      });

      let data: any = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (response.ok && data.requires2fa) {
        // Phase 4A: account has 2FA — ask for the 6-digit code
        setNeeds2fa(true);
        setMessage("🔐 Enter the 6-digit code from your authenticator app");
        setLoading(false);
        return;
      }

      if (response.ok && data.token) {
        localStorage.setItem("token", data.token);
        localStorage.setItem("user", JSON.stringify(data.user));
        
        // Save to login history
        const history = JSON.parse(localStorage.getItem("login_history") || "[]");
        history.unshift({
          id: Date.now(),
          email: email,
          user: { name: data.user.name || email.split("@")[0] },
          ipAddress: "127.0.0.1",
          status: "SUCCESS",
          createdAt: new Date().toISOString(),
        });
        localStorage.setItem("login_history", JSON.stringify(history.slice(0, 100)));
        
        setMessage("✅ Login successful! Redirecting...");
        
        setTimeout(() => {
          router.push("/dashboard");
        }, 1000);
      } else {
        setMessage(`❌ Login failed: ${data.message || "Invalid credentials"}`);
        
        const history = JSON.parse(localStorage.getItem("login_history") || "[]");
        history.unshift({
          id: Date.now(),
          email: email,
          user: { name: email.split("@")[0] },
          ipAddress: "127.0.0.1",
          status: "FAILED",
          failReason: data.message,
          createdAt: new Date().toISOString(),
        });
        localStorage.setItem("login_history", JSON.stringify(history.slice(0, 100)));
      }
    } catch (error: any) {
      const isNetworkError =
        error instanceof TypeError &&
        (error.message || "").toLowerCase().includes("failed to fetch");

      if (isNetworkError) {
        setMessage(
          `❌ Cannot reach backend at ${getBackendUrl()}. Ensure backend is running and database is reachable.`
        );
      } else {
        setMessage(`❌ Connection error: ${error?.message || "Unknown error"}`);
      }

      // Keep this as warning to avoid flooding the browser error overlay.
      console.warn("Login request failed:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !loading) {
      handleLogin();
    }
  };

  return (
    <div
      style={{
        background: "#080b12",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "hidden",
        margin: 0,
        padding: 20,
        fontFamily: "'Segoe UI', system-ui, sans-serif",
      }}
    >
      {/* Background grid pattern */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(233,64,139,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(233,64,139,0.04) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      {/* Glow effects */}
      <div
        style={{
          position: "absolute",
          width: "380px",
          height: "380px",
          top: "-160px",
          left: "-100px",
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(233,64,139,0.12) 0%, transparent 70%)",
          filter: "blur(60px)",
        }}
      />

      <div
        style={{
          position: "absolute",
          width: "300px",
          height: "300px",
          bottom: "-120px",
          right: "-80px",
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(100,80,255,0.1) 0%, transparent 70%)",
          filter: "blur(60px)",
        }}
      />

      {/* Main Card */}
      <div
        style={{
          display: "flex",
          width: "900px",
          maxWidth: "100%",
          minHeight: "520px",
          borderRadius: "24px",
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 25px 50px -12px rgba(0,0,0,0.5), 0 0 0 1px rgba(233,64,139,0.1)",
          position: "relative",
          zIndex: 2,
          flexWrap: "wrap",
          backdropFilter: "blur(2px)",
        }}
      >
        {/* Left Side - Branding */}
        <div
          style={{
            flex: 1,
            minWidth: "300px",
            background: "linear-gradient(135deg, #0a0f1a 0%, #0d1525 50%, #0a0f1c 100%)",
            padding: "48px 40px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: "radial-gradient(circle at 30% 70%, rgba(233,64,139,0.05) 0%, transparent 60%), radial-gradient(circle at 80% 20%, rgba(100,80,255,0.06) 0%, transparent 50%)",
            }}
          />

          <div style={{ position: "relative", zIndex: 2 }}>
            <div style={{ marginBottom: "40px" }}>
              <Logo size={44} withText subtitle="ISP Management" />
            </div>

            <h1
              style={{
                fontSize: "32px",
                fontWeight: 800,
                lineHeight: "1.3",
                color: "#fff",
                marginBottom: "16px",
                letterSpacing: "-0.02em",
              }}
            >
              Command Center
              <br />
              for{" "}
              <span style={{ background: NOVA, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                ISP Management
              </span>
            </h1>

            <p
              style={{
                color: "#94a3b8",
                lineHeight: "1.7",
                fontSize: "13px",
                marginBottom: "32px",
              }}
            >
              Secure. Fast. Always on.
              <br />
              Enterprise-grade infrastructure
              <br />
              built for modern ISPs.
            </p>
          </div>

          <div
            style={{
              display: "flex",
              gap: "32px",
              position: "relative",
              zIndex: 2,
              flexWrap: "wrap",
              paddingTop: "20px",
              borderTop: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            {[
              ["99.9%", "Uptime"],
              ["256-bit", "Encryption"],
              ["24/7", "Support"],
            ].map(([value, label]) => (
              <div key={label}>
                <div
                  style={{
                    fontSize: "20px",
                    fontWeight: 800,
                    color: "#E9408B",
                  }}
                >
                  {value}
                </div>
                <div
                  style={{
                    fontSize: "10px",
                    color: "#64748b",
                    marginTop: "4px",
                    letterSpacing: "0.5px",
                  }}
                >
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right Side - Login Form */}
        <div
          style={{
            width: "360px",
            background: "#0c0f17",
            padding: "48px 40px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            borderLeft: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <div
            style={{
              fontSize: "11px",
              letterSpacing: "0.15em",
              color: "#E9408B",
              textTransform: "uppercase",
              marginBottom: "12px",
              fontWeight: 600,
            }}
          >
            Secure Access
          </div>

          <div
            style={{
              fontSize: "28px",
              fontWeight: 800,
              color: "#fff",
              marginBottom: "8px",
              letterSpacing: "-0.02em",
            }}
          >
            Sign in
          </div>

          <div
            style={{
              fontSize: "12px",
              color: "#64748b",
              marginBottom: "32px",
            }}
          >
            Enter your credentials to continue
          </div>

          <div style={{ marginBottom: "20px" }}>
            <label
              style={{
                display: "block",
                marginBottom: "8px",
                fontSize: "11px",
                fontWeight: 600,
                color: "#94a3b8",
                letterSpacing: "0.5px",
              }}
            >
              Email Address
            </label>

            <input
              type="email"
              placeholder="admin@jointbox.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={handleKeyPress}
              style={{
                width: "100%",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: "10px",
                padding: "12px 14px",
                fontSize: "14px",
                color: "#fff",
                outline: "none",
                transition: "all 0.2s",
              }}
              onFocus={(e) => {
                e.target.style.borderColor = "#E9408B";
                e.target.style.boxShadow = "0 0 0 3px rgba(233,64,139,0.1)";
              }}
              onBlur={(e) => {
                e.target.style.borderColor = "rgba(255,255,255,0.08)";
                e.target.style.boxShadow = "none";
              }}
            />
          </div>

          <div style={{ marginBottom: "24px" }}>
            <label
              style={{
                display: "block",
                marginBottom: "8px",
                fontSize: "11px",
                fontWeight: 600,
                color: "#94a3b8",
                letterSpacing: "0.5px",
              }}
            >
              Password
            </label>

            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyPress}
              style={{
                width: "100%",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: "10px",
                padding: "12px 14px",
                fontSize: "14px",
                color: "#fff",
                outline: "none",
                transition: "all 0.2s",
              }}
              onFocus={(e) => {
                e.target.style.borderColor = "#E9408B";
                e.target.style.boxShadow = "0 0 0 3px rgba(233,64,139,0.1)";
              }}
              onBlur={(e) => {
                e.target.style.borderColor = "rgba(255,255,255,0.08)";
                e.target.style.boxShadow = "none";
              }}
            />
          </div>

          {needs2fa && (
            <div style={{ marginBottom: "16px" }}>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="6-digit authenticator code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                onKeyDown={handleKeyPress}
                autoFocus
                style={{
                  width: "100%",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid #E9408B",
                  borderRadius: "10px",
                  padding: "12px 14px",
                  fontSize: "16px",
                  letterSpacing: "6px",
                  textAlign: "center",
                  color: "#fff",
                  outline: "none",
                }}
              />
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={loading}
            style={{
              width: "100%",
              padding: "13px",
              borderRadius: "10px",
              border: "none",
              cursor: loading ? "not-allowed" : "pointer",
              fontSize: "14px",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              background: loading
                ? "#2a2a2a"
                : "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)",
              color: "#fff",
              boxShadow: loading ? "none" : "0 4px 14px rgba(233,64,139,0.35)",
              transition: "all 0.2s",
            }}
            onMouseEnter={(e) => {
              if (!loading) {
                e.currentTarget.style.transform = "translateY(-1px)";
                e.currentTarget.style.boxShadow = "0 8px 20px rgba(233,64,139,0.4)";
              }
            }}
            onMouseLeave={(e) => {
              if (!loading) {
                e.currentTarget.style.transform = "translateY(0)";
                e.currentTarget.style.boxShadow = "0 4px 14px rgba(233,64,139,0.35)";
              }
            }}
          >
            {loading ? "Signing In..." : "Sign In →"}
          </button>

          {message && (
            <p
              style={{
                textAlign: "center",
                marginTop: "20px",
                color: message.includes("✅") ? "#E9408B" : "#f87171",
                fontSize: "12px",
                padding: "10px",
                background: message.includes("✅")
                  ? "rgba(233,64,139,0.1)"
                  : "rgba(248,113,113,0.1)",
                borderRadius: "8px",
                border: message.includes("✅")
                  ? "1px solid rgba(233,64,139,0.2)"
                  : "1px solid rgba(248,113,113,0.2)",
              }}
            >
              {message}
            </p>
          )}

          {/* Support */}
          <div
            style={{
              marginTop: "24px",
              padding: "12px",
              background: "rgba(255,255,255,0.03)",
              borderRadius: "8px",
              textAlign: "center",
            }}
          >
            <p style={{ fontSize: "10.5px", color: "#64748b", margin: 0 }}>
              Need help? <a href={`mailto:${SUPPORT}`} style={{ color: "#F9A8D4", textDecoration: "none", fontWeight: 600 }}>{SUPPORT}</a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}