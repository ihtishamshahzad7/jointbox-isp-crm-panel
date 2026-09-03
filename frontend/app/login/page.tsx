"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "../components/logo";
import API_BASE from "../components/api";
import { BRAND } from "../../lib/brand";
import { LANGS, useI18n } from "../../lib/i18n";

const NOVA = "linear-gradient(135deg,#6C3CE1,#E9408B,#F27121)";
const SUPPORT = BRAND.supportEmail;
const getBackendUrl = () => API_BASE;

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState("");
  const [needs2fa, setNeeds2fa] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [demoCredentials, setDemoCredentials] = useState<{email:string;password:string}|null>(null);
  const { t, setLang, lang } = useI18n();
  const router = useRouter();

  useEffect(() => {
    if (localStorage.getItem("token")) router.push("/dashboard");
  }, [router]);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) { setMessage("❌ Please enter both email and password"); return; }
    setMessage(""); setLoading(true);
    try {
      const response = await fetch(`${getBackendUrl()}/auth/login`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({email:email.trim().toLowerCase(),password,code:code||undefined}) });
      let data:any={}; try { data=await response.json(); } catch {}
      if (response.ok && data.requires2fa) { setNeeds2fa(true); setMessage("🔐 Enter the 6-digit code from your authenticator app"); return; }
      if (response.ok && data.token) { localStorage.setItem("token",data.token); localStorage.setItem("user",JSON.stringify(data.user)); setMessage("✅ Login successful! Redirecting..."); setTimeout(()=>router.push("/dashboard"),700); }
      else setMessage(`❌ Login failed: ${data.message || "Invalid credentials"}`);
    } catch { setMessage("❌ Unable to connect to the server. Please try again in a moment."); }
    finally { setLoading(false); }
  };

  const handleKeyPress=(e:React.KeyboardEvent)=>{if(e.key==="Enter"&&!loading)handleLogin();};

  const handleDemo = async () => {
    setLoading(true); setMessage("Creating a demo account…"); setDemoCredentials(null);
    try {
      const shared=await fetch(`${API_BASE}/demo/public`).then(x=>x.ok?x.json():null).catch(()=>null);
      if(shared?.enabled && shared.email && shared.password){const c={email:shared.email,password:shared.password};setEmail(c.email);setPassword(c.password);setDemoCredentials(c);setMessage("✅ Demo account ready. Credentials are shown below.");return;}
      const r=await fetch(`${API_BASE}/demo/create`,{method:"POST",headers:{"Content-Type":"application/json"}}); const d=await r.json();
      if(!r.ok||!d.email||!d.password)throw new Error(d?.message||"Could not create a demo account");
      const c={email:d.email,password:d.password};setEmail(c.email);setPassword(c.password);setDemoCredentials(c);setMessage("✅ Demo account created. Credentials are shown below.");
    } catch { setMessage("❌ Could not create a demo account right now. Please try again."); }
    finally { setLoading(false); }
  };

  const copy=async(v:string,label:string)=>{try{await navigator.clipboard.writeText(v);setMessage(`✅ ${label} copied to clipboard`);}catch{setMessage(`${label}: ${v}`);}};

  return <div style={{background:"#080b12",minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,fontFamily:"'Segoe UI',system-ui,sans-serif"}}>
    <div style={{display:"flex",width:900,maxWidth:"100%",minHeight:520,borderRadius:24,overflow:"hidden",border:"1px solid rgba(255,255,255,.08)",boxShadow:"0 25px 50px -12px rgba(0,0,0,.5)"}}>
      <div style={{flex:1,minWidth:300,background:"linear-gradient(135deg,#0a0f1a,#0d1525,#0a0f1c)",padding:"48px 40px",display:"flex",flexDirection:"column",justifyContent:"space-between"}}><div><div style={{marginBottom:40}}><Logo size={44} withText subtitle={BRAND.subtitle}/></div><h1 style={{fontSize:32,fontWeight:800,lineHeight:1.3,color:"#fff"}}>{t("Command Center")}<br/>{t("for")} <span style={{background:NOVA,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>{BRAND.subtitle}</span></h1><p style={{color:"#94a3b8",lineHeight:1.7,fontSize:13}}>{t("Secure. Fast. Always on.")}<br/>{t("Enterprise-grade infrastructure")}<br/>{t("built for modern ISPs.")}</p></div><div style={{display:"flex",gap:32,borderTop:"1px solid rgba(255,255,255,.06)",paddingTop:20}}>{[["99.9%","Uptime"],["256-bit","Encryption"],["24/7","Support"]].map(x=><div key={x[1]}><b style={{fontSize:20,color:"#E9408B"}}>{x[0]}</b><div style={{fontSize:10,color:"#64748b"}}>{x[1]}</div></div>)}</div></div>
      <div style={{width:360,background:"#0c0f17",padding:"48px 40px",display:"flex",flexDirection:"column",justifyContent:"center"}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}><span style={{fontSize:11,color:"#E9408B",letterSpacing:".15em"}}>{t("Secure Access")}</span><div style={{position:"relative"}}><button type="button" onClick={()=>setLangOpen(x=>!x)} style={{background:"transparent",border:"1px solid rgba(255,255,255,.12)",color:"#94a3b8",borderRadius:8,padding:"5px 10px"}}>🌐 {LANGS.find(l=>l.code===lang)?.native??"English"}</button>{langOpen&&<div style={{position:"absolute",right:0,top:34,zIndex:50,width:180,background:"#0f1625",padding:6,borderRadius:12}}>{LANGS.map(l=><button key={l.code} type="button" onClick={()=>{setLang(l.code);setLangOpen(false)}} style={{display:"block",width:"100%",background:"transparent",border:0,color:"#fff",padding:8,textAlign:"left"}}>{l.native}</button>)}</div>}</div></div><div style={{fontSize:28,fontWeight:800,color:"#fff",marginBottom:8}}>{t("Sign in")}</div><div style={{fontSize:12,color:"#64748b",marginBottom:28}}>{t("Enter your credentials to continue")}</div>
      <label style={{color:"#94a3b8",fontSize:11,marginBottom:7}}>{t("Email Address")}</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={handleKeyPress} style={{width:"100%",boxSizing:"border-box",background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:10,padding:"12px 14px",color:"#fff",marginBottom:16}}/>
      <label style={{color:"#94a3b8",fontSize:11,marginBottom:7}}>{t("Password")}</label><input type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={handleKeyPress} style={{width:"100%",boxSizing:"border-box",background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:10,padding:"12px 14px",color:"#fff",marginBottom:18}}/>
      {needs2fa&&<input inputMode="numeric" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,""))} onKeyDown={handleKeyPress} placeholder="6-digit authenticator code" style={{width:"100%",boxSizing:"border-box",padding:12,marginBottom:16}}/>}
      <button type="button" disabled={loading} onClick={handleLogin} style={{width:"100%",padding:13,border:0,borderRadius:10,color:"#fff",fontWeight:700,background:NOVA}}>{loading?t("Signing In..."):t("Sign In →")}</button>
      <button type="button" disabled={loading} onClick={handleDemo} style={{width:"100%",marginTop:10,padding:11,borderRadius:10,border:"1px solid rgba(255,255,255,.15)",background:"transparent",color:"#c4b5fd",fontWeight:700}}>✦ {t("Try a demo account")}</button>
      {demoCredentials&&<div style={{marginTop:16,padding:15,borderRadius:12,background:"rgba(233,64,139,.08)",border:"1px solid rgba(233,64,139,.35)"}}><div style={{fontSize:13,fontWeight:800,color:"#fff",marginBottom:10}}>🎉 Demo Login Credentials</div><div style={{fontSize:10,color:"#94a3b8"}}>EMAIL</div><div style={{display:"flex",gap:6,alignItems:"center",marginBottom:9}}><code style={{flex:1,color:"#fff",overflowWrap:"anywhere"}}>{demoCredentials.email}</code><button type="button" onClick={()=>copy(demoCredentials.email,"Email")} style={{padding:"4px 8px",borderRadius:6,border:"1px solid rgba(255,255,255,.12)",background:"#151b29",color:"#fff"}}>Copy</button></div><div style={{fontSize:10,color:"#94a3b8"}}>PASSWORD</div><div style={{display:"flex",gap:6,alignItems:"center"}}><code style={{flex:1,color:"#fff",overflowWrap:"anywhere"}}>{demoCredentials.password}</code><button type="button" onClick={()=>copy(demoCredentials.password,"Password")} style={{padding:"4px 8px",borderRadius:6,border:"1px solid rgba(255,255,255,.12)",background:"#151b29",color:"#fff"}}>Copy</button></div><button type="button" onClick={handleLogin} style={{marginTop:12,width:"100%",padding:9,borderRadius:8,border:"1px solid rgba(255,255,255,.12)",background:"#151b29",color:"#fff",fontWeight:700}}>Sign in with demo account</button></div>}
      {message&&<p style={{textAlign:"center",marginTop:18,color:message.includes("❌")?"#f87171":"#E9408B",fontSize:12,padding:10,borderRadius:8,background:message.includes("❌")?"rgba(248,113,113,.1)":"rgba(233,64,139,.1)"}}>{message}</p>}<div style={{marginTop:20,padding:12,background:"rgba(255,255,255,.03)",borderRadius:8,textAlign:"center",fontSize:10,color:"#64748b"}}>{t("Need help?")} <a href={`mailto:${SUPPORT}`} style={{color:"#F9A8D4"}}>{SUPPORT}</a></div></div>
    </div></div>;
}
