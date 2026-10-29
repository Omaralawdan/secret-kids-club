import { useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./AuthGate.css";
export type AuthUser={id:string;name:string;roles:string};
export default function AuthGate({onAuthenticated}:{onAuthenticated:(user:AuthUser)=>void}){
 const [needsSetup,setNeedsSetup]=useState(false),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [username,setUsername]=useState(""),[displayName,setDisplayName]=useState(""),[password,setPassword]=useState("");
 useEffect(()=>{void invoke<{needsSetup:boolean}>("auth_status").then(s=>{setNeedsSetup(s.needsSetup);setReady(true)}).catch(e=>{setError(String(e));setReady(true)})},[]);
 async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError("");try{const user=needsSetup?await invoke<AuthUser>("setup_first_admin",{username,displayName,password}):await invoke<AuthUser>("login_user",{username,password});onAuthenticated(user)}catch(e){setError(String(e))}finally{setBusy(false)}}
 if(!ready)return <main className="auth-screen"><section className="auth-card">جارٍ تجهيز تسجيل الدخول…</section></main>;
 return <main className="auth-screen" dir="rtl"><form className="auth-card" onSubmit={e=>void submit(e)}><div className="auth-brand">SK</div><h1>Secret Kids Club</h1><h2>{needsSetup?"إعداد حساب المدير الأول":"تسجيل دخول الموظفين"}</h2><p>{needsSetup?"أنشئ حساب المدير لتأمين البرنامج قبل الاستخدام.":"اكتب اسم المستخدم وكلمة المرور للمتابعة."}</p>
 <label>اسم المستخدم<input autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required minLength={3}/></label>
 {needsSetup&&<label>اسم الموظف / المدير<input value={displayName} onChange={e=>setDisplayName(e.target.value)} required/></label>}
 <label>كلمة المرور<input type="password" autoComplete={needsSetup?"new-password":"current-password"} value={password} onChange={e=>setPassword(e.target.value)} required minLength={needsSetup?12:1}/></label>
 {needsSetup&&<small>استخدم 12 حرفًا على الأقل. يتم تخزين بصمة مملحة لكلمة المرور، وليس كلمة المرور نفسها.</small>}
 {error&&<div className="notice error">{error}</div>}<button className="primary-button" disabled={busy}>{busy?"جارٍ التحقق…":needsSetup?"إنشاء حساب المدير":"دخول"}</button>
 </form></main>;
}