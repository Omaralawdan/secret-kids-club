
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { t, useLanguage, type Language } from "./i18n";
import ReportsCenter from "./ReportsCenter";
import AuthGate, { type AuthUser } from "./AuthGate";
import AdminTools from "./AdminTools";
import CafeCenter from "./CafeCenter";

type MembershipPlan = { id:string; name:string; price_minor:number; included_minutes:number; validity_days:number; overtime_rate_minor:number; is_active:number };
type ChildMembership = { id:string; child_name_snapshot:string; guardian_phone_snapshot:string; plan_id:string; plan_name:string; purchased_at:string; expires_at:string; included_minutes:number; used_minutes:number; overtime_rate_minor:number; status:string; sale_id:string|null; paid_minor:number; remaining_minor:number };
type MembershipPayment = {created_at:string;amount_minor:number;method:string;external_reference:string|null};

type PricingRule = {
  id: string;
  name: string;
  pricing_type: "fixed" | "hourly" | "offer";
  amount_minor: number;
  duration_minutes: number;
  is_active: number;
};

type ChildDraft = {
  key: string;
  name: string;
  ruleId: string;
  durationHours: number;
  hourlyRateMinor: number | null;
  priceMinor: number | null;
};

type Screen = "reception" | "active" | "packages" | "pricing" | "settings" | "reports" | "admin" | "cafe";

type ActiveChild = {
  visit_id: string;
  visit_number: number;
  visit_child_id: string;
  child_name: string;
  guardian_name: string;
  guardian_phone: string;
  checked_in_at: string;
  pricing_id: string;
  pricing_type: "fixed" | "hourly" | "offer" | "membership";
  duration_minutes: number;
  base_amount_minor: number;
  discount_amount_minor: number;
  final_amount_minor: number;
  calculation_json: string;
};

const makeId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const money = (minor: number, language: Language = "en") =>
  new Intl.NumberFormat(language === "ar" ? "ar-EG" : "en-EG", {
    style: "currency",
    currency: "EGP",
  }).format(minor / 100);

function formatDate(value: string, language: Language) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-EG", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  }).format(date);
}


function formatDuration(minutes: number, language: Language) {
  const hours = minutes / 60;
  const formatted = Number(hours.toFixed(2)).toString();
  return language === "ar" ? `${formatted} ساعة` : `${formatted} h`;
}

type ReceiptChildLine = { name:string; bookedMinutes:number; baseAmountMinor:number; discountAmountMinor:number; overtimeMinutes?:number; overtimeAmountMinor?:number; overtimeWaived?:boolean; overtimeWaiverReason?:string|null; totalAmountMinor?:number };
type ReceiptData = {
  visitNumber: number; guardianName: string; guardianPhone: string; childName: string;
  children?: ReceiptChildLine[];
  checkedInAt: string; checkedOutAt?: string | null; expectedCheckoutAt?: string | null; bookedMinutes: number; actualMinutes?: number | null; paymentMethod?: string;
  baseAmountMinor: number; discountAmountMinor: number; overtimeMinutes?: number | null;
  overtimeAmountMinor?: number | null; overtimeWaived?: boolean; overtimeWaiverReason?: string | null; totalAmountMinor?: number | null;
  venueName: string; venueAddress: string; venuePhone: string; issuer: string;
};

function escapeReceipt(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
}

function buildReceiptHtml(data: ReceiptData, language: Language): string {
  const ar = language === "ar";
  const finalReceipt = Boolean(data.checkedOutAt);
  const label = (en: string, arabic: string) => ar ? arabic : en;
  const row = (name: string, value: string) => '<div class="row"><span>' + name + '</span><strong>' + value + '</strong></div>';
  const amount = (name: string, value: number) => row(name, escapeReceipt(money(value, language)));
  const date = (value: string) => escapeReceipt(new Date(value).toLocaleString(ar ? "ar-EG" : "en-EG"));
  let html = '<!doctype html><html lang="' + (ar ? "ar" : "en") + '" dir="' + (ar ? "rtl" : "ltr") + '"><head><meta charset="utf-8"><title>Secret Kids Club Receipt</title>';
  html += '<style>@page{size:80mm auto;margin:3mm}*{box-sizing:border-box}body{margin:0;font:12px/1.45 Arial,Tahoma,sans-serif;color:#171717}.receipt{width:74mm;margin:auto;padding:2mm}.head{text-align:center;border-bottom:2px dashed #555;padding-bottom:10px;margin-bottom:8px}h1{font-size:18px;margin:0 0 3px;color:#b91c45}h2{font-size:14px;margin:5px 0}.sub{font-size:10px;color:#444}.row{display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dotted #ddd;align-items:flex-start}.row span{color:#444;max-width:48%}.row strong{text-align:end;max-width:58%;overflow-wrap:anywhere}.section{font-weight:700;margin:10px 0 3px;color:#b91c45}.total{margin-top:7px;padding:8px;background:#fff0f4;border:1px solid #f2b8c8;border-radius:6px;font-size:14px}.foot{text-align:center;border-top:2px dashed #555;margin-top:12px;padding-top:8px;font-size:10px}@media screen{body{background:#eee;padding:12px}.receipt{background:white;padding:10px;box-shadow:0 2px 14px #0002}}</style></head><body><main class="receipt">';
  html += '<header class="head"><h1>' + escapeReceipt(data.venueName || "Secret Kids Club") + '</h1>';
  if (data.venueAddress) html += '<div class="sub">' + escapeReceipt(data.venueAddress) + '</div>';
  html += '<div class="sub">' + label("Phone", "تليفون") + ': ' + escapeReceipt(data.venuePhone || "01122799113") + '</div><h2>' + label("VISIT RECEIPT", "إيصال زيارة طفل") + '</h2>';
  html += '<div class="sub">' + label("Receipt No.", "رقم الإيصال") + ': SKC-' + data.visitNumber + '-' + (finalReceipt ? "OUT" : "IN") + '-' + Date.now().toString().slice(-6) + '</div></header>';
  html += '<div class="section">' + label("Visit details", "بيانات الزيارة") + '</div>';
  html += row(label("Visit number", "رقم الزيارة"), String(data.visitNumber));
  html += row(label("Visit date", "تاريخ الزيارة"), date(data.checkedInAt));
  html += row(label("Guardian", "اسم المرافق"), escapeReceipt(data.guardianName));
  html += row(label("Guardian phone", "تليفون المرافق"), escapeReceipt(data.guardianPhone));
  if (data.children?.length) {
    html += row(label("Children count", "عدد الأطفال"), String(data.children.length));
    for (const child of data.children) {
      html += row(escapeReceipt(child.name), escapeReceipt(formatDuration(child.bookedMinutes, language)) + " · " + escapeReceipt(money(child.baseAmountMinor, language)));
      if ((child.discountAmountMinor || 0)>0) html += row(label("Child discount","خصم الطفل"),escapeReceipt(money(child.discountAmountMinor || 0,language)));
      if ((child.overtimeAmountMinor || 0)>0) html += row(label("Child overtime","إضافي الطفل"),escapeReceipt(money(child.overtimeAmountMinor || 0,language)));
    }
  } else html += row(label("Child", "اسم الطفل"), escapeReceipt(data.childName));
  html += row(label("Check-in", "وقت الدخول"), date(data.checkedInAt));
  if (!finalReceipt && data.expectedCheckoutAt) html += row(label("Expected check-out", "وقت الخروج المتوقع"), date(data.expectedCheckoutAt));
  if (finalReceipt) html += row(label("Check-out", "وقت الخروج"), date(data.checkedOutAt || ""));
  html += row(label("Booked duration", "المدة المحجوزة"), escapeReceipt(formatDuration(data.bookedMinutes, language)));
  // Actual elapsed duration is intentionally not shown on the customer receipt.
  html += '<div class="section">' + label("Payment details", "تفاصيل الحساب") + '</div>';
  if (data.paymentMethod) html += row(label("Payment method", "طريقة الدفع"), escapeReceipt(({cash:"Cash",instapay:"InstaPay",wallet:"E-Wallet",visa:"Visa",other:"Other"} as Record<string,string>)[data.paymentMethod] || data.paymentMethod));
  if (data.children?.length) {
    html += amount(label("Children subtotal", "إجمالي أسعار الأطفال"), data.children.reduce((sum, child) => sum + child.baseAmountMinor, 0));
    html += amount(label("Total discount", "إجمالي الخصم"), data.children.reduce((sum, child) => sum + child.discountAmountMinor, 0));
  } else {
    html += amount(label("Base price", "السعر الأساسي"), data.baseAmountMinor);
    html += amount(label("Discount", "الخصم"), data.discountAmountMinor);
  }
  if (finalReceipt) { html += row(label("Overtime duration", "مدة الوقت الإضافي"), escapeReceipt(formatDuration(data.overtimeMinutes || 0, language))); html += amount(label(data.overtimeWaived ? "Overtime amount waived" : "Overtime amount", data.overtimeWaived ? "قيمة الإضافي المعفاة" : "قيمة الوقت الإضافي"), data.overtimeAmountMinor || 0); if (data.overtimeWaived) html += row(label("Waiver reason", "سبب الإعفاء"), escapeReceipt(data.overtimeWaiverReason || "")); }
  html += '<div class="row total"><span>' + label(finalReceipt ? "FINAL TOTAL" : "INITIAL ESTIMATE", finalReceipt ? "الإجمالي النهائي" : "السعر المبدئي") + '</span><strong>' + escapeReceipt(money(finalReceipt ? (data.totalAmountMinor || 0) : (data.baseAmountMinor - data.discountAmountMinor), language)) + '</strong></div>';
  html += '<div class="section">' + label("Receipt details", "بيانات الإيصال") + '</div>' + row(label("Issued by", "مُصدر الإيصال"), escapeReceipt(data.issuer || label("Cashier", "الكاشير")));
  html += '<footer class="foot">' + label("Thank you for visiting! ❤️", "نورتونا في Secret Kids Club ❤️") + '<br>' + label("We loved having you. See you again soon! 🎈", "اتبسطنا بوجودكم، ومستنيينكم تنورونا تاني قريب! 🎈") + '</footer></main></body></html>';
  return html;
}
function readHourlyRate(json: string): number | null {
  try {
    const value = JSON.parse(json) as { hourlyRateMinor?: unknown; overtimeRateMinor?: unknown };
    const rate = typeof value.hourlyRateMinor === "number" ? value.hourlyRateMinor : value.overtimeRateMinor;
    return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

export default function App() {
  const { language, setLanguage } = useLanguage();
  const tr = (key: string) => t(language, key);
  const ar = language === "ar";

  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [db, setDb] = useState<Database | null>(null);
  const [databaseStatus, setDatabaseStatus] = useState("Connecting");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [screen, setScreen] = useState<Screen>("reception");
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [visits, setVisits] = useState(0);
  const [activeChildren, setActiveChildren] = useState<ActiveChild[]>([]);
  const [saving, setSaving] = useState(false);
  const [checkoutId, setCheckoutId] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [venueName, setVenueName] = useState("Secret Kids Club");
  const [venueAddress, setVenueAddress] = useState("");
  const [venuePhone, setVenuePhone] = useState("01122799113");
  const [fontScale, setFontScale] = useState("1");
  const [receiptQueue, setReceiptQueue] = useState<string[]>([]);
  const [receiptPreviewHtml, setReceiptPreviewHtml] = useState("");
  const receiptFrameRef = useRef<HTMLIFrameElement>(null);

  const [guardianName, setGuardianName] = useState("");
  const [guardianRelation, setGuardianRelation] = useState("Mother");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "instapay" | "wallet" | "visa" | "other">("cash");
  const [customerLookupMessage, setCustomerLookupMessage] = useState("");
  const [previousChildren, setPreviousChildren] = useState<{name:string;lastVisit:string}[]>([]);
  const [guardianSuggestions, setGuardianSuggestions] = useState<{phone:string;name:string}[]>([]);
  const [children, setChildren] = useState<ChildDraft[]>([
    { key: makeId(), name: "", ruleId: "", durationHours: 1, hourlyRateMinor: null, priceMinor: null },
  ]);

  const [ruleName, setRuleName] = useState("");
  const [ruleType, setRuleType] =
    useState<PricingRule["pricing_type"]>("fixed");
  const [ruleAmount, setRuleAmount] = useState("");
  const [ruleDurationHours, setRuleDurationHours] = useState("1");
  const [membershipPlans,setMembershipPlans]=useState<MembershipPlan[]>([]);
  const [memberships,setMemberships]=useState<ChildMembership[]>([]);
  const [planName,setPlanName]=useState(""); const [planPrice,setPlanPrice]=useState(""); const [planHours,setPlanHours]=useState("20"); const [planValidity,setPlanValidity]=useState("30"); const [planOvertimeRate,setPlanOvertimeRate]=useState("");
  const [memberName,setMemberName]=useState(""); const [memberPhone,setMemberPhone]=useState(""); const [memberPlanId,setMemberPlanId]=useState(""); const [memberPaymentMethod,setMemberPaymentMethod]=useState<"cash"|"instapay"|"wallet"|"visa"|"other">("cash"); const [memberPaymentAmount,setMemberPaymentAmount]=useState(""); const [memberPaymentNote,setMemberPaymentNote]=useState(""); const [membershipPaymentHistory,setMembershipPaymentHistory]=useState<Record<string,MembershipPayment[]>>({});

  const refreshData = useCallback(async (connection: Database) => {
    const loadedRules = await connection.select<PricingRule[]>(
      `SELECT id, name, pricing_type, amount_minor, duration_minutes, is_active
       FROM local_pricing_rules
       WHERE is_active = 1 AND calculation_type = 'fixed'
       ORDER BY priority, name`
    );
    setRules(loadedRules);
    try {
      setMembershipPlans(await connection.select<MembershipPlan[]>("SELECT id,name,price_minor,included_minutes,validity_days,overtime_rate_minor,is_active FROM local_membership_plans WHERE is_active=1 ORDER BY name"));
      setMemberships(await connection.select<ChildMembership[]>("SELECT m.id,m.child_name_snapshot,m.guardian_phone_snapshot,m.plan_id,p.name AS plan_name,m.purchased_at,m.expires_at,m.included_minutes,m.used_minutes,p.overtime_rate_minor,m.status,m.sale_id,COALESCE((SELECT SUM(pay.amount_minor) FROM local_payments pay WHERE pay.sale_id=m.sale_id AND pay.status='confirmed'),0) AS paid_minor,MAX(0,p.price_minor-COALESCE((SELECT SUM(pay.amount_minor) FROM local_payments pay WHERE pay.sale_id=m.sale_id AND pay.status='confirmed'),0)) AS remaining_minor FROM local_child_memberships m JOIN local_membership_plans p ON p.id=m.plan_id ORDER BY m.purchased_at DESC"));
    } catch { /* Membership tables are created by the installed schema migration. */ }

    const counts = await connection.select<{ total: number }[]>(
      "SELECT COUNT(*) AS total FROM local_visits"
    );
    setVisits(counts[0]?.total ?? 0);

    const active = await connection.select<ActiveChild[]>(
      `SELECT
         v.id AS visit_id,
         v.visit_number_local AS visit_number,
         vc.id AS visit_child_id,
         vc.child_name_snapshot AS child_name,
         v.guardian_name_snapshot AS guardian_name,
         v.guardian_phone_snapshot AS guardian_phone,
         v.checked_in_at,
         p.id AS pricing_id,
         p.pricing_type,
         p.duration_minutes,
         p.base_amount_minor,
         p.discount_amount_minor,
         p.final_amount_minor,
         p.calculation_json
       FROM local_visits v
       JOIN local_visit_children vc ON vc.visit_id = v.id
       JOIN local_visit_child_pricing p ON p.visit_child_id = vc.id
       WHERE v.status = 'active'
         AND vc.checked_out_at IS NULL
       ORDER BY v.checked_in_at ASC, v.visit_number_local ASC`
    );

    setActiveChildren(active);
  }, []);

  useEffect(() => {
    let mounted = true;

    async function connect() {
      try {
        const connection = await Database.load("sqlite:secret-kids-club.db");
        await refreshData(connection);
        if (mounted) {
          setDb(connection);
          setDatabaseStatus("Connected");
        }
      } catch (err) {
        if (mounted) {
          setDatabaseStatus("Unavailable");
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void connect();
    return () => {
      mounted = false;
    };
  }, [refreshData]);

  useEffect(() => {
    try {
      setVenueName(localStorage.getItem("skc.venueName") || "Secret Kids Club");
      setVenueAddress(localStorage.getItem("skc.venueAddress") || "");
      setVenuePhone(localStorage.getItem("skc.venuePhone") || "01122799113");
      setFontScale(localStorage.getItem("skc.fontScale") || "1");
    } catch { /* Use in-memory defaults if storage is unavailable. */ }
  }, []);

  useEffect(() => {
    setReceiptPreviewHtml(receiptQueue[0] || "");
  }, [receiptQueue]);

  useEffect(() => {
    document.documentElement.style.setProperty("--app-scale", fontScale);
    try {
      localStorage.setItem("skc.venueName", venueName);
      localStorage.setItem("skc.venueAddress", venueAddress);
      localStorage.setItem("skc.venuePhone", venuePhone);
      localStorage.setItem("skc.fontScale", fontScale);
    } catch { /* Current settings remain usable for this session. */ }
  }, [venueName, venueAddress, venuePhone, fontScale]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  function updateChild(
    key: string,
    field: "name" | "ruleId" | "durationHours" | "hourlyRateMinor" | "priceMinor",
    value: string | number | null
  ) {
    setChildren((current) =>
      current.map((child) => {
        if (child.key !== key) return child;
        if (field === "durationHours") return { ...child, durationHours: Number(value) };
        if (field === "priceMinor") return { ...child, priceMinor: value === null ? null : Number(value) };
        if (field === "hourlyRateMinor") {
          const rate = value === null ? null : Number(value);
          return { ...child, hourlyRateMinor: rate };
        }
        if (field === "ruleId") {
          const selected = rules.find(rule => rule.id === String(value));
          return { ...child, ruleId: String(value), durationHours: selected?.duration_minutes ? selected.duration_minutes / 60 : child.durationHours, hourlyRateMinor: null };
        }
        return { ...child, [field]: value as string };
      })
    );
  }

  function addChild() {
    setChildren((current) => [
      ...current,
      { key: makeId(), name: "", ruleId: "", durationHours: 1, hourlyRateMinor: null, priceMinor: null },
    ]);
  }

  function removeChild(key: string) {
    setChildren((current) =>
      current.length > 1 ? current.filter((child) => child.key !== key) : current
    );
  }

  function priceFor(child: ChildDraft) {
    const rule = rules.find((item) => item.id === child.ruleId);
    if (!rule) return 0;

    return child.priceMinor === null ? 0 : Math.round(child.priceMinor);
  }

  const total = children.reduce((sum, child) => sum + priceFor(child), 0);
  const ready = databaseStatus === "Connected" && db !== null;
  const authRoles: string[] = (() => { try { return authUser ? JSON.parse(authUser.roles) : []; } catch { return []; } })();
  const authPermissionKeys: string[] = (() => { if(authRoles.includes("admin"))return ["all"]; try { const p=authUser?.permissions?JSON.parse(authUser.permissions):[]; if(Array.isArray(p)&&p.includes("all"))return ["all"]; if(Array.isArray(p)&&p.includes("__custom__"))return p.filter((x:string)=>x!=="__custom__"); } catch {} return authRoles.includes("admin")?["all"]:authRoles.includes("manager")?["reception","active","packages","cafe","reports","shift","pricing"]:authRoles.includes("cashier")?["reception","active","packages","cafe","shift"]:authRoles.includes("viewer")?["reports"]:[]; })();
  const hasPermission = (key:string) => authPermissionKeys.includes("all") || authPermissionKeys.includes(key);
  const isAdmin = authRoles.includes("admin");
  const canManage = isAdmin || authRoles.includes("manager");
  const canOperate = canManage || authRoles.includes("cashier");
  const reportAccess = (canManage || authRoles.includes("viewer")) && hasPermission("reports");
  if (!authUser) return <AuthGate onAuthenticated={(user) => { setAuthUser(user); try { const roles=JSON.parse(user.roles) as string[];let perms:string[]=[];try{perms=user.permissions?JSON.parse(user.permissions):[]}catch{};if(roles.includes("viewer"))setScreen("reports");else if(perms.includes("__custom__")){const selected=perms.filter(x=>x!=="__custom__");setScreen(selected.includes("reception")?"reception":selected.includes("packages")?"packages":selected.includes("active")?"active":selected.includes("cafe")?"cafe":selected.includes("reports")?"reports":"admin");} } catch {} }} databaseReady={ready} />;

  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db) return;

    const amount = ruleType === "hourly" ? 0 : Number(ruleAmount);
    if (!ruleName.trim() || (ruleType !== "hourly" && (!Number.isFinite(amount) || amount < 0)) || !Number.isFinite(Number(ruleDurationHours)) || Number(ruleDurationHours) < 0.25 || Number(ruleDurationHours) > 12 || !Number.isInteger(Number(ruleDurationHours) * 4)) {
      setError(tr("Enter a rule name and a valid non-negative price."));
      return;
    }

    setError("");
    setMessage("");

    try {
      await invoke("create_pricing_rule", {
        name: ruleName.trim(),
        pricingType: ruleType,
        amountMinor: Math.round(amount * 100),
        durationMinutes: Math.round(Number(ruleDurationHours) * 60),
      });

      setRuleName("");
      setRuleAmount("");
      setRuleDurationHours("1");
      await refreshData(db);
      setMessage(tr("Pricing rule saved."));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createMembershipPlan(e:FormEvent<HTMLFormElement>) {
    e.preventDefault(); if(!db)return;
    const hours=Number(planHours), price=Number(planPrice), days=Number(planValidity), overtimeRate=Number(planOvertimeRate);
    if(!planName.trim()||!Number.isFinite(hours)||hours<=0||!Number.isFinite(price)||price<0||![7,30].includes(days)||!Number.isFinite(overtimeRate)||overtimeRate<=0){setError("راجع اسم الباقة والسعر وعدد الساعات وسعر ساعة الإضافي.");return}
    try { await db.execute("INSERT INTO local_membership_plans(id,name,price_minor,included_minutes,validity_days,overtime_rate_minor,description,is_active,created_at) VALUES(?,?,?,?,?,?,NULL,1,?)",[makeId(),planName.trim(),Math.round(price*100),Math.round(hours*60),days,Math.round(overtimeRate*100),now()]);setPlanName("");setPlanPrice("");setPlanOvertimeRate("");await refreshData(db);setMessage("تم حفظ الباقة.");setError("") } catch(e){setError(String(e))}
  }
  async function enrollMembership(e:FormEvent<HTMLFormElement>) {
    e.preventDefault(); if(!db)return;
    const plan=membershipPlans.find(p=>p.id===memberPlanId);
    if(!plan||!memberName.trim()||!memberPhone.trim()){setError("أدخل اسم الطفل ورقم الهاتف واختار الباقة.");return} if(plan.price_minor<=0){setError("سعر الباقة يجب أن يكون أكبر من صفر لتسجيل التحصيل.");return} const initialPaid=memberPaymentAmount.trim()===""?plan.price_minor:Math.round(Number(memberPaymentAmount)*100); if(!Number.isFinite(initialPaid)||initialPaid<=0||initialPaid>plan.price_minor){setError("المبلغ المدفوع الآن يجب أن يكون أكبر من صفر ولا يتجاوز سعر الباقة.");return}
    const purchased=new Date(), expires=new Date(purchased.getTime()+plan.validity_days*86400000);
    try {
      const membershipId=makeId(), saleId=makeId();
      const saleNoRows=await db.select<{n:number}[]>("SELECT COALESCE(MAX(sale_number_local),0)+1 AS n FROM local_sales");
      const saleNo=saleNoRows[0]?.n||1;
      const cashierRows=await db.select<{id:string}[]>("SELECT actor_user_id AS id FROM local_session WHERE singleton_id=1");
      const cashierId=cashierRows[0]?.id;
      if(!cashierId) throw new Error("يجب تسجيل الدخول قبل تسجيل بيع الباقة.");
      const shiftRows=await db.select<{id:string}[]>("SELECT id FROM local_cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1");
      const cashSessionId=shiftRows[0]?.id;
      if(!cashSessionId) throw new Error("افتح وردية قبل تسجيل تحصيل الباقة.");
      await db.execute("INSERT INTO local_sales(id,sale_number_local,visit_id,status,subtotal_minor,discount_minor,total_minor,cashier_user_id,created_at,sync_state) VALUES(?, ?, NULL,'completed',?,0,?,?,?,'pending')",[saleId,saleNo,plan.price_minor,plan.price_minor,cashierId,purchased.toISOString()]);
      await db.execute("INSERT INTO local_sale_items(id,sale_id,item_type,inventory_item_id,description_snapshot,quantity_milli,unit_price_minor,line_total_minor) VALUES(?, ?, 'other', NULL, ?,1000,?,?)",[makeId(),saleId,"Membership package: "+plan.name+" - "+memberName.trim(),plan.price_minor,plan.price_minor]);
      await db.execute("INSERT INTO local_child_memberships(id,child_id,child_name_snapshot,guardian_phone_snapshot,plan_id,purchased_at,starts_at,expires_at,included_minutes,used_minutes,status,sync_state,sale_id) VALUES(?,NULL,?,?,?,?,?,?,?,0,'active','pending',?)",[membershipId,memberName.trim(),memberPhone.trim(),plan.id,purchased.toISOString(),purchased.toISOString(),expires.toISOString(),plan.included_minutes,saleId]);
      const storedMemberMethod=memberPaymentMethod==="visa"||memberPaymentMethod==="other"?"wallet":memberPaymentMethod;
       await db.execute("INSERT INTO local_payments(id,sale_id,visit_id,method,method_label,status,amount_minor,external_reference,received_by,created_at,sync_state,cash_session_id) VALUES(?,?,NULL,?,?,'confirmed',?,?,?,?, 'pending',?)",[makeId(),saleId,storedMemberMethod,memberPaymentMethod,initialPaid,memberPaymentNote.trim()||null,cashierId,purchased.toISOString(),cashSessionId]);
      setMemberName("");setMemberPhone("");setMemberPaymentAmount("");setMemberPaymentNote("");await refreshData(db);setMessage(initialPaid<plan.price_minor?"تم تسجيل الباقة مع وجود مبلغ متبقٍ للتحصيل.":"تم تسجيل الطفل في الباقة وتحصيل قيمتها بالكامل.");setError("")
    } catch(e){setError(String(e))}
  }
  async function collectMembershipPayment(m:ChildMembership){
    if(!db||!m.sale_id||m.remaining_minor<=0)return;
    const amountText=window.prompt("المبلغ المطلوب تحصيله الآن بالجنيه. المتبقي: "+(m.remaining_minor/100).toFixed(2),String((m.remaining_minor/100).toFixed(2)));
    if(amountText===null)return;
    const amountMinor=Math.round(Number(amountText)*100);
    if(!Number.isFinite(amountMinor)||amountMinor<=0||amountMinor>m.remaining_minor){setError("راجع مبلغ الدفعة؛ لا يجوز أن يتجاوز المتبقي.");return}
    const method=window.prompt("طريقة الدفع: cash / instapay / wallet / visa / other","cash")||"";
    const note=window.prompt("ملاحظة الدفعة (اختياري):","")||"";
    try{const result=await invoke<{paidMinor:number;remainingMinor:number}>("record_membership_payment",{membershipId:m.id,amountMinor,method,note});await refreshData(db);setMessage("تم تسجيل الدفعة. المتبقي: "+money(result.remainingMinor,language));setError("")}catch(e){setError(String(e))}
  }
  async function toggleMembershipHistory(m:ChildMembership){
    if(!db||!m.sale_id)return;
    if(membershipPaymentHistory[m.id]){setMembershipPaymentHistory(old=>{const next={...old};delete next[m.id];return next});return}
    try{const rows=await db.select<MembershipPayment[]>("SELECT created_at,amount_minor,COALESCE(method_label,method) AS method,external_reference FROM local_payments WHERE sale_id=? AND status='confirmed' ORDER BY created_at",[m.sale_id]);setMembershipPaymentHistory(old=>({...old,[m.id]:rows}))}catch(e){setError(String(e))}
  }
  async function updateMembershipOvertimeRate(m:ChildMembership) {
    const entered=window.prompt(ar?"سعر ساعة الإضافي للباقة بالجنيه:":"Membership overtime hourly rate (EGP):",(m.overtime_rate_minor/100).toFixed(2));
    if(entered===null)return;
    const value=Number(entered);
    if(!Number.isFinite(value)||value<=0){setError(ar?"أدخل سعرًا أكبر من صفر.":"Enter a rate greater than zero.");return;}
    try{await invoke("update_membership_overtime_rate",{planId:m.plan_id,overtimeRateMinor:Math.round(value*100)});if(db)await refreshData(db);setMessage(ar?"تم تحديث سعر الإضافي للباقة.":"Package overtime rate updated.");setError("")}catch(e){setError(String(e))}
  }
  async function checkInMember(m:ChildMembership) {
    if(!db)return;
    const activeShift=await db.select<{id:string}[]>("SELECT id FROM local_cash_sessions WHERE closed_at IS NULL LIMIT 1");
    if(!activeShift.length){setError(ar?"افتح الوردية قبل تسجيل دخول الطفل.":"Open a cash shift before checking in a child.");return}
    if(m.overtime_rate_minor<=0){setError(ar?"يجب على المدير تحديد سعر ساعة الإضافي لهذه الباقة قبل تسجيل الدخول.":"A manager must set this package's overtime rate before check-in.");return}
    const remaining=m.included_minutes-m.used_minutes;
    if(m.status!=="active"||new Date(m.expires_at)<=new Date()||remaining<=0){setError("الباقة منتهية أو لا يوجد بها وقت متبقٍ.");return}
    if(!window.confirm("تسجيل دخول "+m.child_name_snapshot+" على باقة "+m.plan_name+"؟ الوقت المتبقي: "+formatDuration(remaining,language)))return;
    try {
      const visitId=makeId(), childId=makeId(), pricingId=makeId(), stamp=now();
      const numRows=await db.select<{n:number}[]>("SELECT COALESCE(MAX(visit_number_local),0)+1 AS n FROM local_visits");
      const guardian=await db.select<{full_name:string;id:string}[]>("SELECT id,full_name FROM local_guardians WHERE phone=? ORDER BY created_at DESC LIMIT 1",[m.guardian_phone_snapshot]);
      const visitNo=numRows[0]?.n||1, guardianName=guardian[0]?.full_name||"ولي الأمر";
      await db.execute("INSERT INTO local_visits(id,visit_number_local,guardian_id,guardian_name_snapshot,guardian_relation,guardian_phone_snapshot,child_count,checked_in_at,checked_out_at,status,pricing_type,amount_before_discount_minor,discount_amount_minor,final_amount_minor,cashier_user_id,sync_state,created_at) VALUES(?,?,?,?,?, ?,1,?,NULL,'active','membership',0,0,0,(SELECT actor_user_id FROM local_session WHERE singleton_id=1),'pending',?)",[visitId,visitNo,guardian[0]?.id||null,guardianName,"Guardian",m.guardian_phone_snapshot,stamp,stamp]);
      await db.execute("INSERT INTO local_visit_children(id,visit_id,child_id,child_name_snapshot) VALUES(?,?,NULL,?)",[childId,visitId,m.child_name_snapshot]);
      await db.execute("INSERT INTO local_visit_child_pricing(id,visit_child_id,pricing_type,pricing_rule_id,membership_id,base_amount_minor,discount_amount_minor,final_amount_minor,duration_minutes,included_minutes,calculation_json,created_at) VALUES(?,?,'membership',NULL,?,0,0,0,?,?,?,?)",[pricingId,childId,m.id,remaining,remaining,JSON.stringify({membershipId:m.id,membershipPlan:m.plan_name,initialEstimate:true,overtimeRateMinor:m.overtime_rate_minor}),stamp]);
      await refreshData(db);setMessage("تم تسجيل دخول الطفل على الباقة. الوقت المتاح: "+formatDuration(remaining,language));setError("");setScreen("active");
    } catch(e){setError(String(e))}
  }

  async function createVisit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db || saving) return;
    const activeShift = await db.select<{id:string}[]>("SELECT id FROM local_cash_sessions WHERE closed_at IS NULL LIMIT 1");
    if (!activeShift.length) { setError(ar ? "افتح الوردية قبل تسجيل دخول الأطفال." : "Open a cash shift before checking in children."); return; }

    const cleanChildren = children.map((child) => ({
      ...child,
      name: child.name.trim(),
    }));

    if (!guardianName.trim() || !guardianPhone.trim()) {
      setError(tr("Enter the guardian's name and phone number."));
      return;
    }

    if (
      cleanChildren.some(
        (child) =>
          !child.name ||
          !child.ruleId ||
          !Number.isFinite(child.durationHours) ||
          child.durationHours < 0.25 ||
          child.durationHours > 12 ||
          !Number.isInteger(child.durationHours * 4) ||
          (child.priceMinor === null || !Number.isFinite(child.priceMinor) || child.priceMinor < 0) ||
          (child.hourlyRateMinor === null || !Number.isFinite(child.hourlyRateMinor) || child.hourlyRateMinor <= 0)
      )
    ) {
      setError(
        ar
          ? "أدخل اسم كل طفل وسعره يدويًا وسعر ساعة الإضافي، والمدة من 0.25 إلى 12 ساعة."
          : "Enter each child's name and individual price, overtime hourly rate, and duration from 0.25 to 12 hours."
      );
      return;
    }

    if (
      cleanChildren.some(
        (child) => !rules.some((rule) => rule.id === child.ruleId)
      )
    ) {
      setError(tr("A selected pricing rule is no longer available. Refresh and try again."));
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");

    const visitId = makeId();
    const childRows = cleanChildren.map((child) => ({
      id: makeId(),
      pricingId: makeId(),
      child,
    }));
    const createdVisitChildIds: string[] = [];
    let visitInserted = false;

    try {
      const timestamp = now();
      const matchingGuardians = await db.select<{ id: string }[]>(
        "SELECT id FROM local_guardians WHERE phone = ? ORDER BY created_at DESC LIMIT 1",
        [guardianPhone.trim()]
      );

      let guardianId = matchingGuardians[0]?.id;

      if (!guardianId) {
        guardianId = makeId();
        await db.execute(
          "INSERT INTO local_guardians (id, full_name, phone, created_at) VALUES (?, ?, ?, ?)",
          [guardianId, guardianName.trim(), guardianPhone.trim(), timestamp]
        );
      } else {
        await db.execute(
          "UPDATE local_guardians SET full_name = ? WHERE id = ?",
          [guardianName.trim(), guardianId]
        );
      }

      const numberRows = await db.select<{ next_number: number }[]>(
        "SELECT COALESCE(MAX(visit_number_local), 0) + 1 AS next_number FROM local_visits"
      );
      const visitNumber = numberRows[0]?.next_number ?? 1;

      const amountBeforeDiscount = cleanChildren.reduce(
        (sum, child) => sum + priceFor(child),
        0
      );
      const firstRule = rules.find((rule) => rule.id === cleanChildren[0].ruleId);

      await db.execute(
        `INSERT INTO local_visits
         (id, visit_number_local, guardian_id, guardian_name_snapshot,
          guardian_relation, guardian_phone_snapshot, child_count,
          checked_in_at, checked_out_at, status, pricing_type,
          amount_before_discount_minor, discount_amount_minor,
          final_amount_minor, cashier_user_id, sync_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, 0, ?, (SELECT actor_user_id FROM local_session WHERE singleton_id=1), 'pending', ?)`,
        [
          visitId,
          visitNumber,
          guardianId,
          guardianName.trim(),
          guardianRelation,
          guardianPhone.trim(),
          cleanChildren.length,
          timestamp,
          firstRule?.pricing_type ?? "fixed",
          amountBeforeDiscount,
          amountBeforeDiscount,
          timestamp,
        ]
      );
      visitInserted = true;

      for (const row of childRows) {
        const selectedRule = rules.find((rule) => rule.id === row.child.ruleId);
        if (!selectedRule) throw new Error(tr("Pricing rule not found."));

        const bookedMinutes = Math.round(row.child.durationHours * 60);
        const baseAmount = priceFor(row.child);

        await db.execute(
          `INSERT INTO local_visit_children
           (id, visit_id, child_id, child_name_snapshot)
           VALUES (?, ?, NULL, ?)`,
          [row.id, visitId, row.child.name]
        );
        createdVisitChildIds.push(row.id);

        await db.execute(
          `INSERT INTO local_visit_child_pricing
           (id, visit_child_id, pricing_type, pricing_rule_id,
            base_amount_minor, discount_amount_minor, final_amount_minor,
            duration_minutes, included_minutes, calculation_json, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?)`,
          [
            row.pricingId,
            row.id,
            selectedRule.pricing_type,
            selectedRule.id,
            baseAmount,
            baseAmount,
            bookedMinutes,
            JSON.stringify({
              ruleName: selectedRule.name,
              pricingType: selectedRule.pricing_type,
              initialEstimate: selectedRule.pricing_type === "hourly",
              paymentMethod,
              bookedDurationMinutes: bookedMinutes,
              hourlyRateMinor: row.child.hourlyRateMinor,
            }),
            timestamp,
          ]
        );
      }

      await refreshData(db);
      const visitExpectedCheckout = new Date(Math.max(...childRows.map(row => new Date(timestamp).getTime() + Math.round(row.child.durationHours * 60) * 60000))).toISOString();
      setReceiptQueue((current) => [...current, buildReceiptHtml({
        visitNumber, guardianName: guardianName.trim(), guardianPhone: guardianPhone.trim(),
        childName: childRows.map(row => row.child.name).join("، "),
        children: childRows.map(row => ({name:row.child.name,bookedMinutes:Math.round(row.child.durationHours*60),baseAmountMinor:priceFor(row.child),discountAmountMinor:0})),
        checkedInAt: timestamp, expectedCheckoutAt: visitExpectedCheckout, paymentMethod,
        bookedMinutes: Math.max(...childRows.map(row => Math.round(row.child.durationHours*60))),
        baseAmountMinor: amountBeforeDiscount, discountAmountMinor: 0,
        venueName, venueAddress, venuePhone, issuer: "Cashier",
      }, language)]);
      setGuardianName("");
      setGuardianPhone("");
      setGuardianRelation("Mother");
      setChildren([
        { key: makeId(), name: "", ruleId: "", durationHours: 1, hourlyRateMinor: null, priceMinor: null },
      ]);
      setMessage(
        ar
          ? `تم تسجيل الزيارة رقم ${visitNumber}. السعر المبدئي: ${money(amountBeforeDiscount, language)}`
          : `Visit #${visitNumber} saved. Initial total: ${money(amountBeforeDiscount, language)}.`
      );
    } catch (err) {
      try {
        for (const childId of createdVisitChildIds) {
          await db.execute(
            "DELETE FROM local_visit_child_pricing WHERE visit_child_id = ?",
            [childId]
          );
          await db.execute("DELETE FROM local_visit_children WHERE id = ?", [childId]);
        }
        if (visitInserted) {
          await db.execute("DELETE FROM local_visits WHERE id = ?", [visitId]);
        }
      } catch {
        // Preserve the original error for the cashier.
      }

      setError(
        `Could not save the visit: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setSaving(false);
    }
  }

  async function checkOutChild(child: ActiveChild) {
    if (!db || checkoutId) return;

    const confirmMessage = ar
      ? `تأكيد تسجيل خروج الطفل ${child.child_name}؟`
      : `Confirm checkout for ${child.child_name}?`;

    if (!window.confirm(confirmMessage)) return;
    const elapsedMinutes = Math.max(0, Math.ceil((Date.now() - new Date(child.checked_in_at).getTime()) / 60000));
    const hourlyRate = readHourlyRate(child.calculation_json);
    const estimatedOvertimeMinutes = Math.max(0, elapsedMinutes - child.duration_minutes);
    let overtimeCollected = true;
    let overtimeCollectionNote: string | null = null;
    let overtimeWaived = false;
    let overtimeWaiverReason: string | null = null;
    if (estimatedOvertimeMinutes > 0 && hourlyRate === null) {
      setError(ar ? "لا يوجد سعر ساعة محفوظ لحساب الوقت الإضافي. لا يمكن تسجيل الخروج قبل تحديد السعر." : "No hourly overtime rate is saved. Checkout cannot continue until a valid rate is available.");
      return;
    }
    if (estimatedOvertimeMinutes > 0 && hourlyRate !== null) {
      if (canManage) {
        overtimeWaived = window.confirm(ar
          ? "هل المدير سيعفي الطفل من قيمة الوقت الإضافي؟ موافق = إعفاء، إلغاء = متابعة التحصيل."
          : "Manager: waive this child's overtime charge? OK = waive, Cancel = continue to collection.");
        if (overtimeWaived) {
          overtimeWaiverReason = window.prompt(ar ? "اكتب سبب إعفاء الوقت الإضافي (إجباري):" : "Enter the mandatory reason for waiving overtime:", "")?.trim() || null;
          if (!overtimeWaiverReason) { setError(ar ? "سبب الإعفاء مطلوب." : "A waiver reason is required."); return; }
        }
      }
      if (!overtimeWaived) {
        overtimeCollected = window.confirm(ar
          ? "هل تم تحصيل قيمة الوقت الإضافي؟ اضغط موافق لو تم التحصيل، أو إلغاء لو لم يتم التحصيل."
          : "Was the overtime amount collected? Choose OK for collected, Cancel for not collected.");
        if (!overtimeCollected) {
          overtimeCollectionNote = window.prompt(ar ? "اكتب سبب عدم تحصيل الوقت الإضافي (إجباري):" : "Enter the reason overtime was not collected (required):", "")?.trim() || null;
          if (!overtimeCollectionNote) { setError(ar ? "لازم تكتب سبب عدم التحصيل قبل تسجيل الخروج." : "A reason is required when overtime is not collected."); return; }
        }
      }
    }

    setCheckoutId(child.visit_child_id);
    setError("");
    setMessage("");

    try {
      await invoke<void>("checkout_child", {
        visitChildId: child.visit_child_id,
        overtimeCollected,
        overtimeCollectionNote,
        overtimeWaived,
        overtimeWaiverReason,
      });

      const receiptRows = await db.select<{
        visit_number:number; guardian_name:string; guardian_phone:string; child_name:string;
        checked_in_at:string; checked_out_at:string|null; duration_minutes:number;
        actual_duration_minutes:number|null; base_amount_minor:number; discount_amount_minor:number;
        overtime_minutes:number|null; overtime_amount_minor:number|null; overtime_waived:number;
        overtime_waiver_reason:string|null; final_amount_minor:number; calculation_json:string;
      }[]>(`SELECT v.visit_number_local AS visit_number,v.guardian_name_snapshot AS guardian_name,
        v.guardian_phone_snapshot AS guardian_phone,vc.child_name_snapshot AS child_name,v.checked_in_at,
        vc.checked_out_at,p.duration_minutes,vc.actual_duration_minutes,p.base_amount_minor,p.discount_amount_minor,
        p.overtime_minutes,p.overtime_amount_minor,p.overtime_waived,p.overtime_waiver_reason,p.final_amount_minor,p.calculation_json
        FROM local_visits v JOIN local_visit_children vc ON vc.visit_id=v.id
        JOIN local_visit_child_pricing p ON p.visit_child_id=vc.id WHERE v.id=? ORDER BY vc.rowid`,[child.visit_id]);
      const stillActive = receiptRows.some(row => !row.checked_out_at);
      if (receiptRows.length && !stillActive) {
        const first=receiptRows[0];
        const methods=receiptRows.map(row=>{try{return JSON.parse(row.calculation_json).paymentMethod||"cash"}catch{return "cash"}}).filter((v,i,a)=>a.indexOf(v)===i).join(", ");
        const childLines=receiptRows.map(row=>({name:row.child_name,bookedMinutes:row.duration_minutes,baseAmountMinor:row.base_amount_minor,discountAmountMinor:row.discount_amount_minor,overtimeMinutes:row.overtime_minutes||0,overtimeAmountMinor:row.overtime_amount_minor||0,overtimeWaived:row.overtime_waived===1,overtimeWaiverReason:row.overtime_waiver_reason,totalAmountMinor:row.final_amount_minor}));
        setReceiptQueue(current=>[...current,buildReceiptHtml({
          visitNumber:first.visit_number,guardianName:first.guardian_name,guardianPhone:first.guardian_phone,
          childName:childLines.map(x=>x.name).join("، "),children:childLines,
          checkedInAt:first.checked_in_at,checkedOutAt:(()=>{const times=receiptRows.map(row=>row.checked_out_at||"").sort();return times[times.length-1]||null})(),
          paymentMethod:methods,bookedMinutes:Math.max(...childLines.map(x=>x.bookedMinutes)),
          baseAmountMinor:childLines.reduce((sum,x)=>sum+x.baseAmountMinor,0),
          discountAmountMinor:childLines.reduce((sum,x)=>sum+x.discountAmountMinor,0),
          overtimeMinutes:childLines.reduce((sum,x)=>sum+(x.overtimeMinutes||0),0),
          overtimeAmountMinor:childLines.reduce((sum,x)=>sum+(x.overtimeAmountMinor||0),0),
          totalAmountMinor:childLines.reduce((sum,x)=>sum+(x.totalAmountMinor||0),0),
          venueName,venueAddress,venuePhone,issuer:"Cashier"
        },language)]);
      }

      await refreshData(db);

      setMessage(
        ar
          ? `تم تسجيل خروج ${child.child_name} وحفظ الحساب بنجاح.`
          : `${child.child_name} checked out and the final price was saved.`
      );
    } catch (err) {
      setError(
        `${ar ? "تعذر تسجيل الخروج: " : "Checkout failed: "}${
          err instanceof Error ? err.message : String(err)
        }`
      );
      // A failed transaction leaves the child active; refresh from SQLite.
      try {
        await refreshData(db);
      } catch {
        // Keep the original checkout error visible.
      }
    } finally {
      setCheckoutId("");
    }
  }

  async function cancelVisit(visitId: string) {
    if (!db || !canOperate) return;
    if (!window.confirm(ar ? "سيتم إلغاء الزيارة بالكامل مع الاحتفاظ بسجلها والمدفوعات. هل تريد المتابعة؟" : "This will cancel the entire visit while retaining its history and payments. Continue?")) return;
    const reason = window.prompt(ar ? "اكتب سبب إلغاء الزيارة (إجباري):" : "Enter the mandatory visit cancellation reason:", "")?.trim();
    if (!reason) { setError(ar ? "سبب الإلغاء مطلوب." : "A cancellation reason is required."); return; }
    try {
      await invoke("cancel_visit", { visitId, reason });
      await refreshData(db);
      setMessage(ar ? "تم إلغاء الزيارة مع الاحتفاظ بسجلها." : "Visit cancelled; its history and payments were retained.");
      setError("");
    } catch (e) { setError(String(e)); }
  }

  return (
    <main className="app-shell" style={{ zoom: Number(fontScale) || 1 }}>
      <header className="topbar">
        <div className="brand-mark">SK</div>
        <div className="brand-copy">
          <h1>Secret Kids Club</h1>
          <p>{tr("Point of Sale · Local System")}</p>
        </div>
        <span className={`connection ${ready ? "online" : "offline"}`}>
          {tr(databaseStatus)}
        </span>
      </header>

      <nav className="nav-tabs">
        {canOperate && hasPermission("reception") && <button className={screen === "reception" ? "active" : ""} onClick={() => setScreen("reception")}>
          {tr("Reception")}
        </button>}
        {canOperate && hasPermission("active") && <button className={screen === "active" ? "active" : ""} onClick={() => setScreen("active")}>
          {ar ? "الزيارات النشطة" : "Active visits"}
          {activeChildren.length > 0 ? ` (${activeChildren.length})` : ""}
        </button>}
        {canOperate && hasPermission("packages") && <button className={screen === "packages" ? "active" : ""} onClick={() => setScreen("packages")}>{ar ? "الباقات" : "Packages"}</button>}
        {canManage && hasPermission("pricing") && <button className={screen === "pricing" ? "active" : ""} onClick={() => setScreen("pricing")}>
          {tr("Pricing setup")}
        </button>}
        {isAdmin && hasPermission("settings") && <button className={screen === "settings" ? "active" : ""} onClick={() => setScreen("settings")}>
          {tr("Settings")}
        </button>}
        {reportAccess && <button className={screen === "reports" ? "active" : ""} onClick={() => setScreen("reports")}>
          {ar ? "التقارير والتصدير" : "Reports & Export"}
        </button>}
        {canOperate && hasPermission("cafe") && <button className={screen === "cafe" ? "active" : ""} onClick={() => setScreen("cafe")}>{ar ? "الكافيه والمخزون" : "Café & Inventory"}</button>}
        {canOperate && hasPermission("shift") && <button className={screen === "admin" ? "active" : ""} onClick={() => setScreen("admin")}>
          {ar ? "الوردية والصندوق" : "Shift & Cash"}
        </button>}
      </nav>

      <section className="page-heading">
        <p className="eyebrow">{tr("CASHIER WORKSPACE")}</p>
        <h2>
          {screen === "reception"
            ? tr("New visit")
            : screen === "active"
              ? ar ? "الزيارات النشطة" : "Active visits"
              : screen === "packages"
                ? (ar ? "الباقات والاشتراكات" : "Packages & Memberships")
              : screen === "pricing"
                ? tr("Pricing rules")
                : screen === "reports"
                  ? (ar ? "مركز التقارير والتصدير" : "Reports Center")
                  : screen === "admin"
                    ? (ar ? "الموظفون والورديات" : "Staff & Shifts")
                    : tr("Settings")}
        </h2>
        <p>
          {screen === "reception"
            ? tr("Register a guardian and each child, then review their individual pricing.")
            : screen === "active"
              ? ar
                ? "تابع الأطفال الموجودين وسجّل خروج كل طفل عند مغادرته."
                : "Track children currently in the club and check each child out individually."
              : screen === "packages"
                ? (ar ? "متابعة أرصدة الباقات وحالة اشتراك كل طفل." : "View package balances and membership status.")
              : screen === "pricing"
                ? tr("Configure the prices available to cashiers. No prices are preloaded.")
                : screen === "reports"
                  ? (ar ? "اختار البيانات والفلاتر والأعمدة وشكل التقرير ثم صدّره." : "Choose data, filters, columns, and export format.")
                  : screen === "admin"
                    ? (ar ? "إدارة الحسابات وكلمات المرور والورديات وسجل المراجعة." : "Manage accounts, passwords, shifts and audit history.")
                    : tr("Choose the language used throughout the application.")}
        </p>
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice success" role="status">{message}</div>}

      {!ready && screen !== "settings" && (
        <section className="panel database-warning" role="status">
          <h3>{tr("Local database")}</h3>
          <p>{databaseStatus === "Connecting" ? tr("Connecting to SQLite…") : tr("The database is unavailable.")}</p>
          <p>{tr("The screens are available, but saving requires the app database connection.")}</p>
        </section>
      )}

      {screen === "packages" ? (
        <section className="panel"><h3>{ar?"المشتركون وحالة الباقات":"Subscribers and package status"}</h3>
          <div className="report-table-wrap"><table className="report-table"><thead><tr><th>{ar?"الطفل":"Child"}</th><th>{ar?"الهاتف":"Phone"}</th><th>{ar?"الباقة":"Package"}</th><th>{ar?"المستخدم / الإجمالي":"Used / included"}</th><th>{ar?"المتبقي":"Remaining"}</th><th>{ar?"الانتهاء":"Expires"}</th><th>{ar?"الحالة":"Status"}</th><th>{ar?"إجراء":"Action"}</th></tr></thead><tbody>{memberships.map(m=>{const remaining=Math.max(0,m.included_minutes-m.used_minutes);const status=new Date(m.expires_at)<=new Date()&&m.status==="active"?"expired":m.status;return <tr key={m.id}><td>{m.child_name_snapshot}</td><td>{m.guardian_phone_snapshot}</td><td>{m.plan_name}</td><td>{formatDuration(m.used_minutes,language)} / {formatDuration(m.included_minutes,language)}</td><td>{formatDuration(remaining,language)}</td><td>{formatDate(m.expires_at,language)}</td><td>{status!=="active"||remaining<=0?(ar?"انتهت الباقة":"Package ended"):status}</td><td><button className="primary-button" disabled={!canOperate||status!=="active"||remaining<=0||m.overtime_rate_minor<=0} onClick={()=>void checkInMember(m)}>{ar?"تسجيل دخول":"Check in"}</button></td></tr>})}{memberships.length===0&&<tr><td colSpan={8}>{ar?"لا توجد اشتراكات مسجلة.":"No memberships found."}</td></tr>}</tbody></table></div>
          {isAdmin&&<button className="secondary-button" onClick={()=>setScreen("pricing")}>{ar?"إدارة وإنشاء الباقات":"Manage and create packages"}</button>}
        </section>
      ) : screen === "cafe" ? (
        <CafeCenter canManage={canManage} />
      ) : screen === "admin" ? (
        <AdminTools user={authUser} onLogout={() => { void invoke("logout_user").finally(() => setAuthUser(null)); }}  />
      ) : screen === "reports" ? (
        <ReportsCenter db={db} language={language} isAdmin={isAdmin} canManage={canManage} />
      ) : screen === "settings" && isAdmin ? (
        <section className="panel settings-panel">
          <div className="panel-title">
            <div><span className="step">01</span><h3>{tr("Settings")}</h3></div>
          </div>
          <p className="muted intro">{ar ? "خصص شكل البرنامج وبيانات المكان التي ستظهر على الإيصالات." : "Customize the app appearance and the venue details printed on receipts."}</p>
          <div className="settings-grid">
            <label>{tr("Language")}
              <select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>
                <option value="en">{tr("English")}</option><option value="ar">{tr("Arabic")}</option>
              </select>
            </label>
            <label>{ar ? "حجم الخط" : "App font size"}
              <select value={fontScale} onChange={(event) => setFontScale(event.target.value)}>
                <option value="0.9">{ar ? "صغير" : "Small"}</option>
                <option value="1">{ar ? "متوسط" : "Medium"}</option>
                <option value="1.1">{ar ? "كبير" : "Large"}</option>
              </select>
            </label>
            <label>{ar ? "اسم المكان على الإيصال" : "Venue name on receipt"}
              <input value={venueName} onChange={(event) => setVenueName(event.target.value)} required />
            </label>
            <label>{ar ? "رقم تليفون المكان" : "Venue phone number"}
              <input value={venuePhone} onChange={(event) => setVenuePhone(event.target.value)} inputMode="tel" required />
            </label>
            <label className="full-width">{ar ? "عنوان المكان (اختياري)" : "Venue address (optional)"}
              <input value={venueAddress} onChange={(event) => setVenueAddress(event.target.value)} />
            </label>
          </div>
          <div className="settings-preview"><strong>{ar ? "معاينة الإيصال" : "Receipt preview"}</strong><span>{venueName || "Secret Kids Club"}</span><span>{venuePhone || "01122799113"}</span></div>
        </section>
      ) : screen === "active" ? (
        <section className="panel">
          <div className="panel-title">
            <div>
              <span className="step">01</span>
              <h3>{ar ? "الأطفال الموجودون حاليًا" : "Children currently checked in"}</h3>
            </div>
            <button type="button" className="secondary-button" disabled={!ready} onClick={() => db && void refreshData(db)}>
              {ar ? "تحديث" : "Refresh"}
            </button>
          </div>

          {activeChildren.length === 0 ? (
            <div className="empty-state">
              <strong>{ar ? "لا توجد زيارات نشطة حاليًا." : "There are no active visits."}</strong>
              <p>{ar ? "ستظهر هنا الزيارات المسجلة بمجرد تأكيد الدخول." : "Confirmed check-ins will appear here."}</p>
            </div>
          ) : (
            <div className="children-list">
              {activeChildren.map((child) => {
               const actual = Math.max(
  0,
  Math.ceil(
    (clock - new Date(child.checked_in_at).getTime()) / 60000
  )
);
                const booked = child.duration_minutes;
                const rate = readHourlyRate(child.calculation_json);
                const estimatedOvertime =
                  rate !== null && booked > 0
                    ? Math.max(0, actual - booked)
                    : 0;

                const visitChildrenCount=activeChildren.filter(item=>item.visit_id===child.visit_id).length;
                const firstInVisit=activeChildren.findIndex(item=>item.visit_id===child.visit_id)===activeChildren.indexOf(child);
                return (
                  <article className="child-row active-visit-row" key={child.visit_child_id}>
                    {firstInVisit && <div className="full-width panel"><strong>{ar ? "زيارة واحدة للمرافق" : "Single guardian visit"} · #{child.visit_number}</strong><span className="muted"> · {child.guardian_name} · {child.guardian_phone} · {visitChildrenCount} {ar ? "أطفال" : "children"}</span></div>}
                    <div className="child-number">#{child.visit_number}</div>
                    <div className="child-name">
                      <strong>{child.child_name}</strong>
                      <span className="muted active-visit-detail">{ar ? "اسم المرافق: " : "Guardian: "}{child.guardian_name}</span>
                      <span className="muted active-visit-detail">{ar ? "رقم التليفون: " : "Phone: "}{child.guardian_phone}</span>
                      <span className="muted active-visit-detail">{ar ? "تاريخ ووقت الدخول: " : "Check-in date & time: "}{formatDate(child.checked_in_at, language)}</span>
                    </div>
                    <div className="child-price">
                      <span>{ar ? "المدة المحجوزة" : "Booked duration"}</span>
                      <strong>{booked > 0 ? formatDuration(booked, language) : (ar ? "غير محددة" : "Not recorded")}</strong>
                      <span>{ar ? "المدة الفعلية" : "Elapsed time"}</span>
                      <strong>{formatDuration(actual, language)}</strong>
                      {actual >= booked && booked > 0 && <strong className="notice error">{ar ? "انتهى وقت الطفل — يلزم تمديد أو تسجيل خروج" : "Time expired — extend or check out"}</strong>}
                      <span>{ar ? "مدة الوقت الإضافي" : "Overtime duration"}</span>
                      <strong>{formatDuration(estimatedOvertime, language)}</strong>
                    </div>
                    <div className="child-price">
                      <span>{ar ? "السعر الأساسي" : "Base price"}</span>
                      <strong>{money(child.base_amount_minor, language)}</strong>
                      <span>{ar ? "إضافي تقديري" : "Estimated overtime"}</span>
                      <strong>{money(
                        estimatedOvertime > 0 && rate !== null
                          ? Math.round(rate * estimatedOvertime / 60)
                          : 0,
                        language
                      )}</strong>
                    </div>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!ready || checkoutId !== ""}
                      onClick={() => void checkOutChild(child)}
                    >
                      {checkoutId === child.visit_child_id
                        ? (ar ? "جارٍ الخروج..." : "Checking out...")
                        : (ar ? "تسجيل الخروج" : "Check out")}
                    </button>
                    <button type="button" className="remove-button" disabled={!ready || checkoutId !== ""} onClick={() => void cancelVisit(child.visit_id)}>
                      {ar ? "إلغاء الزيارة" : "Cancel visit"}
                    </button>
                  </article>
                );
              })}
            </div>
          )}
          <p className="muted intro">
            {ar
              ? "الوقت الإضافي المعروض تقديري؛ المبلغ النهائي يُحفظ عند تسجيل الخروج."
              : "Overtime shown here is an estimate. The final amount is saved when checking out."}
          </p>
        </section>
      ) : screen === "reception" ? (
        <form className="workspace" onSubmit={createVisit}>
          <section className="panel">
            <div className="panel-title">
              <div><span className="step">01</span><h3>{tr("Guardian information")}</h3></div>
              <span className="muted">{tr("Required")}</span>
            </div>
            <div className="form-grid">
              <label>{tr("Guardian full name")}
                <input value={guardianName} onChange={(e) => setGuardianName(e.target.value)} required placeholder={tr("Full name")} />
              </label>
              <label>{tr("Relationship")}
                <select value={guardianRelation} onChange={(e) => setGuardianRelation(e.target.value)}>
                  {["Mother", "Father", "Guardian", "Relative", "Other"].map((item) => <option key={item} value={item}>{tr(item)}</option>)}
                </select>
              </label>
              <label className="full-width">{tr("Phone number")}
                <input value={guardianPhone} onChange={(e) => {
                  const value=e.target.value.replace(/[^0-9+]/g,""); setGuardianPhone(value); setCustomerLookupMessage(""); setPreviousChildren([]); setGuardianSuggestions([]);
                  if(db && value.replace(/\\D/g,"").length>=3) void db.select<{phone:string;name:string}[]>("SELECT phone,full_name AS name FROM local_guardians WHERE phone LIKE ? ORDER BY created_at DESC LIMIT 8",[value+"%"]).then(rows=>setGuardianSuggestions(rows)).catch(()=>setGuardianSuggestions([]));
                }} onBlur={() => { window.setTimeout(()=>setGuardianSuggestions([]),180); if (!db || !guardianPhone.trim()) return; void (async()=>{ const found=await db!.select<{full_name:string}[]>("SELECT full_name FROM local_guardians WHERE phone = ? ORDER BY created_at DESC LIMIT 1",[guardianPhone.trim()]); if(found[0]) setGuardianName(found[0].full_name); const history=await db!.select<{name:string;lastVisit:string}[]>(`SELECT vc.child_name_snapshot AS name, MAX(v.checked_in_at) AS lastVisit FROM local_visits v JOIN local_visit_children vc ON vc.visit_id=v.id WHERE v.guardian_phone_snapshot=? GROUP BY vc.child_name_snapshot ORDER BY MAX(v.checked_in_at) DESC LIMIT 20`,[guardianPhone.trim()]); setPreviousChildren(history); setCustomerLookupMessage(history.length ? (ar ? "تم العثور على العميل وأطفاله السابقين. اضغط على اسم طفل لإضافته." : "Customer history found. Select a previous child to add them.") : (found[0] ? (ar ? "تم العثور على العميل السابق." : "Existing customer found.") : "")); })().catch(()=>{}); }} required inputMode="tel" placeholder={tr("Guardian phone")} />
                {guardianSuggestions.length>0 && <div className="rule-list">{guardianSuggestions.map((g,i)=><button type="button" className="secondary-button" key={g.phone+i} onMouseDown={e=>e.preventDefault()} onClick={()=>{setGuardianPhone(g.phone);setGuardianName(g.name);setGuardianSuggestions([]);void (async()=>{if(!db)return;const history=await db.select<{name:string;lastVisit:string}[]>(`SELECT vc.child_name_snapshot AS name,MAX(v.checked_in_at) AS lastVisit FROM local_visits v JOIN local_visit_children vc ON vc.visit_id=v.id WHERE v.guardian_phone_snapshot=? GROUP BY vc.child_name_snapshot ORDER BY MAX(v.checked_in_at) DESC LIMIT 20`,[g.phone]);setPreviousChildren(history);setCustomerLookupMessage(ar?"تم تحميل بيانات المرافق والأطفال السابقين.":"Guardian and previous children loaded.");})().catch(()=>{});}}>{g.phone} · {g.name}</button>)}</div>}
                {customerLookupMessage && <span className="muted">{customerLookupMessage}</span>}
              </label>
              {previousChildren.length>0 && <div className="full-width panel"><strong>{ar ? "الأطفال المسجلون سابقًا لنفس رقم الهاتف" : "Children previously registered to this phone"}</strong><div className="rule-list">{previousChildren.map((item,i)=><button type="button" className="secondary-button" key={item.name+i} onClick={()=>{setChildren(current=>[...current,{key:makeId(),name:item.name,ruleId:rules[0]?.id||"",durationHours:1,hourlyRateMinor:rules[0]?.pricing_type==="hourly"?rules[0].amount_minor:null,priceMinor:null}]);setMessage(ar ? "تمت إضافة الطفل؛ يمكنك تعديل الاسم والمدة والسعر." : "Child added. You can edit the name, duration and price.");}}>{item.name} · {formatDate(item.lastVisit,language)} · {ar ? "إضافة" : "Add"}</button>)}</div></div>}
              <label className="full-width">{ar ? "طريقة الدفع" : "Payment method"}
                <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value as "cash"|"instapay"|"wallet"|"visa"|"other")}><option value="cash">{ar ? "كاش" : "Cash"}</option><option value="instapay">InstaPay</option><option value="wallet">{ar ? "محفظة إلكترونية" : "E-Wallet"}</option><option value="visa">{ar ? "فيزا" : "Visa"}</option><option value="other">{ar ? "أخرى" : "Other"}</option></select>
              </label>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <div><span className="step">02</span><h3>{tr("Children and pricing")}</h3></div>
              <span className="muted">{children.length} {tr(children.length === 1 ? "child" : "children")}</span>
            </div>
            {rules.length === 0 && (
              <div className="empty-state">
                <strong>{tr("No pricing rules configured yet.")}</strong>
                <p>{tr("Open Pricing setup and add your actual prices before registering a visit.")}</p>
                <button type="button" className="secondary-button" onClick={() => setScreen("pricing")}>{tr("Set up pricing")}</button>
              </div>
            )}
            <div className="children-list">
              {children.map((child, index) => {
                const selected = rules.find((rule) => rule.id === child.ruleId);
                return (
                  <div className="child-row" key={child.key}>
                    <div className="child-number">{index + 1}</div>
                    <label className="child-name">{tr("Child name")}
                      <input value={child.name} onChange={(e) => updateChild(child.key, "name", e.target.value)} required placeholder={tr("Child's name")} />
                    </label>
                    <label className="child-pricing">{tr("Pricing rule")}
                      <select value={child.ruleId} onChange={(e) => updateChild(child.key, "ruleId", e.target.value)} required>
                        <option value="">{tr("Select price")}</option>
                        {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name} · {tr(rule.pricing_type)}</option>)}
                      </select>
                    </label>
                    <label className="child-pricing">{ar ? "سعر الطفل (جنيه)" : "Child price (EGP)"}<input type="number" min="0" step="0.01" required value={child.priceMinor === null ? "" : (child.priceMinor / 100).toFixed(2)} onChange={e => updateChild(child.key, "priceMinor", e.target.value === "" ? null : Math.round(Number(e.target.value) * 100))} placeholder={ar ? "اكتب سعر هذا الطفل" : "Enter this child's price"} /></label>
                    <label className="booked-hours-field">
                      {ar ? "مدة الحجز (بالساعات)" : "Booked duration (hours)"}
                      <input
                        type="number"
                        min="0.25"
                        max="12"
                        required
                        value={Number(child.durationHours.toFixed(2))}
                        step="0.25"
                        onChange={(e) => updateChild(child.key, "durationHours", Number(e.target.value))}
                      />
                      <span className="muted">{ar ? "المدة مستقلة لكل طفل؛ السعر الأساسي الذي أدخلته لهذا الطفل لا يتغير مع الأطفال الآخرين." : "Duration is set per child; this child's manually entered base price is independent of other children."}</span>
                    </label>
                    {selected && <label className="child-pricing">{ar ? "سعر الساعة / ساعة الإضافي (جنيه)" : "Hourly / overtime rate (EGP)"}<input type="number" min="0.01" step="0.01" required value={child.hourlyRateMinor === null ? "" : (child.hourlyRateMinor / 100).toFixed(2)} onChange={e => updateChild(child.key, "hourlyRateMinor", e.target.value === "" ? null : Math.round(Number(e.target.value) * 100))} placeholder={ar ? "اكتب سعر الساعة" : "Enter hourly rate"} /><span className="muted">{selected.pricing_type === "hourly" ? (ar ? "يُستخدم لحساب السعر الأساسي والوقت الإضافي." : "Used for the booked hourly price and overtime.") : (ar ? "يُستخدم لحساب أي وقت يتجاوز مدة الحجز." : "Used to calculate time beyond the booked duration.")}</span></label>}
                    <div className="child-price">
                      <span>{tr("Price estimate")}</span>
                      <strong>{selected ? money(priceFor(child), language) : "—"}</strong>
                    </div>
                    <button type="button" className="remove-button" onClick={() => removeChild(child.key)} disabled={children.length === 1} aria-label={`Remove child ${index + 1}`}>×</button>
                  </div>
                );
              })}
            </div>
            <button type="button" className="secondary-button add-child" onClick={addChild}>{`+ ${tr("Add another child")}`}</button>
          </section>

          <section className="summary-panel">
            <div>
              <span className="muted">{tr("Initial visit total")}</span>
              <strong className="total">{money(total, language)}</strong>
              <p>{ar ? "قبل الخصومات؛ يتم حساب الوقت الإضافي عند الخروج بالدقيقة." : "Before discounts; applicable overtime is calculated per minute at checkout."}</p>
            </div>
            <button className="primary-button" type="submit" disabled={!ready || saving || rules.length === 0}>
              {saving ? tr("Saving visit…") : (ar ? "حفظ ودخول" : "Save & Check In")}
            </button>
          </section>
        </form>
      ) : (
        <section className="panel">
          <div className="panel-title">
            <div><span className="step">01</span><h3>{tr("Add a pricing rule")}</h3></div>
          </div>
          <p className="muted intro">{tr("Enter the real price used by your club. Prices are stored in EGP.")}</p>
          <form className="form-grid" onSubmit={createRule}>
            <label>{tr("Rule name")}
              <input value={ruleName} onChange={(e) => setRuleName(e.target.value)} required placeholder={tr("e.g. Standard entry")} />
            </label>
            <label>{tr("Pricing type")}
              <select value={ruleType} onChange={(e) => setRuleType(e.target.value as PricingRule["pricing_type"])}>
                <option value="fixed">{tr("Fixed price")}</option>
                <option value="hourly">{tr("Hourly (first-hour estimate)")}</option>
                <option value="offer">{tr("Offer (fixed price)")}</option>
              </select>
            </label>
            {ruleType !== "hourly" && <label>{tr("Price in EGP")}
              <input type="number" min="0" step="0.01" value={ruleAmount} onChange={(e) => setRuleAmount(e.target.value)} required placeholder={tr("Enter actual price")} />
            </label>}
            {ruleType === "hourly" && <p className="muted full-width">{ar ? "سعر الساعة لا يُحفظ هنا؛ ستدخله يدويًا لكل طفل عند تسجيل الزيارة." : "The hourly rate is not preset here. Enter it separately for each child when registering a visit."}</p>}
            <label>{ar ? "مدة الحجز الافتراضية (بالساعات)" : "Default booking duration (hours)"}<input type="number" min="0.25" max="12" step="0.25" value={ruleDurationHours} onChange={e=>setRuleDurationHours(e.target.value)} required /></label>
            <div className="full-width">
              <button className="primary-button" type="submit" disabled={!ready}>{tr("Save pricing rule")}</button>
            </div>
          </form>
          <div className="rule-list">
            <h3>{tr("Active pricing rules")}</h3>
            {rules.length === 0 ? <p className="muted">{tr("No rules configured.")}</p> : rules.map((rule) => (
              <div className="rule-item" key={rule.id}>
                <div><strong>{rule.name}</strong><span>{tr(rule.pricing_type)}</span><span>{ar ? "المدة الافتراضية" : "Default duration"}: {formatDuration(rule.duration_minutes || 60, language)}</span></div>
                <strong>{rule.pricing_type === "hourly" ? (ar ? "السعر عند التسجيل" : "Set at check-in") : money(rule.amount_minor, language)}</strong>
                {isAdmin && <button type="button" className="remove-button" onClick={()=>{if(!window.confirm(ar?"حذف/إيقاف قاعدة التسعير؟ إذا كانت مستخدمة في زيارات سابقة فسيتم إيقافها فقط للحفاظ على السجلات.":"Remove this pricing rule? If used in past visits, it will be deactivated to preserve history."))return;void invoke("delete_pricing_rule",{ruleId:rule.id}).then(()=>db&&refreshData(db)).then(()=>setMessage(ar?"تم حذف/إيقاف التسعير.":"Pricing rule removed.")).catch(e=>setError(String(e)));}}>{ar?"حذف":"Remove"}</button>}
              </div>
            ))}
          </div>
          <section className="report-field-panel">
            <h3>{ar ? "باقات الاشتراك الأسبوعية والشهرية" : "Weekly and monthly packages"}</h3>
            <p className="muted">{ar ? "أنشئ باقة بعدد ساعات وصلاحية 7 أيام أو 30 يومًا، ثم سجّل الطفل في الباقة. وقت الباقة يُخصم عند تسجيل الخروج." : "Create a package with included hours and 7-day or 30-day validity. Enroll a child; used minutes are deducted at checkout."}</p>
            <form className="form-grid" onSubmit={createMembershipPlan}>
              <label>{ar?"اسم الباقة":"Package name"}<input value={planName} onChange={e=>setPlanName(e.target.value)} required/></label>
              <label>{ar?"السعر بالجنيه":"Price (EGP)"}<input type="number" min="0" step="0.01" value={planPrice} onChange={e=>setPlanPrice(e.target.value)} required/></label>
              <label>{ar?"عدد الساعات":"Included hours"}<input type="number" min="0.25" step="0.25" value={planHours} onChange={e=>setPlanHours(e.target.value)} required/></label>
              <label>{ar?"سعر ساعة الوقت الإضافي (جنيه)":"Overtime hourly rate (EGP)"}<input type="number" min="0.01" step="0.01" value={planOvertimeRate} onChange={e=>setPlanOvertimeRate(e.target.value)} required/></label>
              <label>{ar?"مدة الباقة":"Validity"}<select value={planValidity} onChange={e=>setPlanValidity(e.target.value)}><option value="7">{ar?"أسبوع (7 أيام)":"Weekly (7 days)"}</option><option value="30">{ar?"شهر (30 يومًا)":"Monthly (30 days)"}</option></select></label>
              <div className="full-width"><button className="primary-button" type="submit">{ar?"حفظ الباقة":"Save package"}</button></div>
            </form>
            <h4>{ar?"تسجيل طفل في باقة":"Enroll a child"}</h4>
            <form className="form-grid" onSubmit={enrollMembership}>
              <label>{ar?"اسم الطفل":"Child name"}<input value={memberName} onChange={e=>setMemberName(e.target.value)} required/></label>
              <label>{ar?"رقم هاتف ولي الأمر":"Guardian phone"}<input value={memberPhone} onChange={e=>setMemberPhone(e.target.value)} required inputMode="tel"/></label>
              <label>{ar?"الباقة":"Package"}<select value={memberPlanId} onChange={e=>setMemberPlanId(e.target.value)} required><option value="">{ar?"اختار الباقة":"Choose a package"}</option>{membershipPlans.map(p=><option key={p.id} value={p.id}>{p.name} · {p.validity_days===7?(ar?"أسبوع":"Weekly"):(ar?"شهر":"Monthly")} · {money(p.price_minor,language)} · {formatDuration(p.included_minutes,language)}</option>)}</select></label><label>{ar?"طريقة تحصيل الباقة":"Package payment method"}<select value={memberPaymentMethod} onChange={e=>setMemberPaymentMethod(e.target.value as "cash"|"instapay"|"wallet")}><option value="cash">{ar?"كاش":"Cash"}</option><option value="instapay">InstaPay</option><option value="wallet">{ar?"محفظة إلكترونية":"E-Wallet"}</option><option value="visa">{ar?"فيزا":"Visa"}</option><option value="other">{ar?"أخرى":"Other"}</option></select></label>
              <div className="full-width"><button className="primary-button" type="submit" disabled={!membershipPlans.length}>{ar?"تسجيل الاشتراك":"Enroll"}</button></div>
            </form>
            <h4>{ar?"المشتركون وحالة الباقات":"Subscribers and package status"}</h4>
            <div className="report-table-wrap"><table className="report-table"><thead><tr><th>{ar?"الطفل":"Child"}</th><th>{ar?"الهاتف":"Phone"}</th><th>{ar?"الباقة":"Package"}</th><th>{ar?"المستخدم / الإجمالي":"Used / included"}</th><th>{ar?"الانتهاء":"Expires"}</th><th>{ar?"سعر ساعة الإضافي":"Overtime rate/hour"}</th><th>{ar?"الحالة":"Status"}</th><th>{ar?"إجراء":"Action"}</th></tr></thead><tbody>{memberships.map(m=>{const remaining=Math.max(0,m.included_minutes-m.used_minutes);const status=new Date(m.expires_at)<=new Date()&&m.status==="active"?"expired":m.status;return <tr key={m.id}><td>{m.child_name_snapshot}</td><td>{m.guardian_phone_snapshot}</td><td>{m.plan_name}</td><td>{formatDuration(m.used_minutes,language)} / {formatDuration(m.included_minutes,language)}<br/>{ar?"متبقي":"Remaining"}: {formatDuration(remaining,language)}</td><td>{formatDate(m.expires_at,language)}</td><td>{money(m.overtime_rate_minor,language)}</td><td>{status!=="active"||remaining<=0 ? (ar?"انتهت الباقة — تجديد أو إلغاء":"Package ended — renew or cancel") : status}</td><td><button className="secondary-button" onClick={()=>void updateMembershipOvertimeRate(m)}>{ar?"تعديل سعر الإضافي":"Edit overtime rate"}</button> <button className="primary-button" disabled={status!=="active"||remaining<=0||m.overtime_rate_minor<=0} onClick={()=>void checkInMember(m)}>{ar?"تسجيل دخول":"Check in"}</button></td></tr>})}</tbody></table></div>
          </section>
        </section>
      )}

      <footer>
        <span>Secret Kids Club POS</span>
        <span>{authUser.name} · {authRoles.join(", ")} · {visits} {tr(visits === 1 ? "saved visit" : "saved visits")} · {tr("Local SQLite")}</span>
        <button type="button" className="secondary-button" onClick={() => { void invoke("logout_user").finally(() => setAuthUser(null)); }}>{ar ? "تسجيل الخروج" : "Log out"}</button>
      </footer>
      {receiptPreviewHtml && (
        <div className="receipt-modal-backdrop" role="dialog" aria-modal="true" aria-label={ar ? "معاينة الإيصال" : "Receipt preview"}>
          <section className="receipt-modal">
            <header className="receipt-modal-header">
              <div>
                <h3>{ar ? "معاينة الإيصال" : "Receipt preview"}</h3>
                <p className="muted">{ar ? "راجع الإيصال، ثم اختار الطباعة أو الإلغاء." : "Review the receipt, then choose Print or Cancel."}</p>
              </div>
              <button type="button" className="secondary-button" onClick={() => setReceiptQueue((current) => current.slice(1))} aria-label={ar ? "إغلاق المعاينة" : "Close preview"}>×</button>
            </header>
            <iframe ref={receiptFrameRef} className="receipt-preview-frame" title={ar ? "معاينة الإيصال" : "Receipt preview"} srcDoc={receiptPreviewHtml} />
            <footer className="receipt-modal-actions">
              <button type="button" className="secondary-button" onClick={() => setReceiptQueue((current) => current.slice(1))}>{ar ? "إلغاء / بدون طباعة" : "Cancel / Don't print"}</button>
              <button type="button" className="primary-button" onClick={() => receiptFrameRef.current?.contentWindow?.print()}>{ar ? "طباعة الإيصال" : "Print receipt"}</button>
            </footer>
          </section>
        </div>
      )}

    </main>
  );
}
