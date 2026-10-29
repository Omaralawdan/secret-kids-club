
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { t, useLanguage, type Language } from "./i18n";
import ReportsCenter from "./ReportsCenter";
import AuthGate, { type AuthUser } from "./AuthGate";
import AdminTools from "./AdminTools";

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
};

type Screen = "reception" | "active" | "pricing" | "settings" | "reports" | "admin";

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
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  if (language === "ar") {
    if (hours && remainder) return `${hours} ساعة و${remainder} دقيقة`;
    if (hours) return `${hours} ساعة`;
    return `${remainder} دقيقة`;
  }



  if (hours && remainder) return `${hours}h ${remainder}m`;
  if (hours) return `${hours}h`;
  return `${remainder}m`;
}

type ReceiptData = {
  visitNumber: number; guardianName: string; guardianPhone: string; childName: string;
  checkedInAt: string; checkedOutAt?: string | null; expectedCheckoutAt?: string | null; bookedMinutes: number; actualMinutes?: number | null; paymentMethod?: string;
  baseAmountMinor: number; discountAmountMinor: number; overtimeMinutes?: number | null;
  overtimeAmountMinor?: number | null; totalAmountMinor?: number | null;
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
  html += row(label("Child", "اسم الطفل"), escapeReceipt(data.childName));
  html += row(label("Check-in", "وقت الدخول"), date(data.checkedInAt));
  if (!finalReceipt && data.expectedCheckoutAt) html += row(label("Expected check-out", "وقت الخروج المتوقع"), date(data.expectedCheckoutAt));
  if (finalReceipt) html += row(label("Check-out", "وقت الخروج"), date(data.checkedOutAt || ""));
  html += row(label("Booked duration", "المدة المحجوزة"), escapeReceipt(formatDuration(data.bookedMinutes, language)));
  if (finalReceipt) html += row(label("Actual duration", "المدة الفعلية"), escapeReceipt(formatDuration(data.actualMinutes || 0, language)));
  html += '<div class="section">' + label("Payment details", "تفاصيل الحساب") + '</div>';
  if (data.paymentMethod) html += row(label("Payment method", "طريقة الدفع"), escapeReceipt(({cash:"Cash",instapay:"InstaPay",wallet:"E-Wallet"} as Record<string,string>)[data.paymentMethod] || data.paymentMethod));
  html += amount(label("Base price", "السعر الأساسي"), data.baseAmountMinor);
  html += amount(label("Discount", "الخصم"), data.discountAmountMinor);
  if (finalReceipt) { html += row(label("Overtime duration", "مدة الوقت الإضافي"), escapeReceipt(formatDuration(data.overtimeMinutes || 0, language))); html += amount(label("Overtime amount", "قيمة الوقت الإضافي"), data.overtimeAmountMinor || 0); }
  html += '<div class="row total"><span>' + label(finalReceipt ? "FINAL TOTAL" : "INITIAL ESTIMATE", finalReceipt ? "الإجمالي النهائي" : "السعر المبدئي") + '</span><strong>' + escapeReceipt(money(finalReceipt ? (data.totalAmountMinor || 0) : (data.baseAmountMinor - data.discountAmountMinor), language)) + '</strong></div>';
  html += '<div class="section">' + label("Receipt details", "بيانات الإيصال") + '</div>' + row(label("Issued by", "مُصدر الإيصال"), escapeReceipt(data.issuer || label("Cashier", "الكاشير")));
  html += '<footer class="foot">' + label("Thank you for visiting! ❤️", "نورتونا في Secret Kids Club ❤️") + '<br>' + label("We loved having you. See you again soon! 🎈", "اتبسطنا بوجودكم، ومستنيينكم تنورونا تاني قريب! 🎈") + '</footer></main></body></html>';
  return html;
}
function readHourlyRate(json: string): number | null {
  try {
    const value = JSON.parse(json) as { hourlyRateMinor?: unknown };
    return typeof value.hourlyRateMinor === "number" &&
      Number.isFinite(value.hourlyRateMinor) &&
      value.hourlyRateMinor >= 0
      ? value.hourlyRateMinor
      : null;
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
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "instapay" | "wallet">("cash");
  const [customerLookupMessage, setCustomerLookupMessage] = useState("");
  const [previousChildren, setPreviousChildren] = useState<{name:string;lastVisit:string}[]>([]);
  const [children, setChildren] = useState<ChildDraft[]>([
    { key: makeId(), name: "", ruleId: "", durationHours: 1, hourlyRateMinor: null },
  ]);

  const [ruleName, setRuleName] = useState("");
  const [ruleType, setRuleType] =
    useState<PricingRule["pricing_type"]>("fixed");
  const [ruleAmount, setRuleAmount] = useState("");
  const [ruleDurationHours, setRuleDurationHours] = useState("1");

  const refreshData = useCallback(async (connection: Database) => {
    const loadedRules = await connection.select<PricingRule[]>(
      `SELECT id, name, pricing_type, amount_minor, duration_minutes, is_active
       FROM local_pricing_rules
       WHERE is_active = 1 AND calculation_type = 'fixed'
       ORDER BY priority, name`
    );
    setRules(loadedRules);

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
    field: "name" | "ruleId" | "durationHours" | "hourlyRateMinor",
    value: string | number | null
  ) {
    setChildren((current) =>
      current.map((child) => {
        if (child.key !== key) return child;
        if (field === "durationHours") return { ...child, durationHours: Number(value) };
        if (field === "hourlyRateMinor") {
          const rate = value === null ? null : Number(value);
          return { ...child, hourlyRateMinor: rate };
        }
        if (field === "ruleId") {
          const selected = rules.find(rule => rule.id === String(value));
          return { ...child, ruleId: String(value), hourlyRateMinor: selected?.pricing_type === "hourly" ? selected.amount_minor : null };
        }
        return { ...child, [field]: value as string };
      })
    );
  }

  function addChild() {
    setChildren((current) => [
      ...current,
      { key: makeId(), name: "", ruleId: "", durationHours: 1, hourlyRateMinor: null },
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

    if (rule.pricing_type === "hourly") {
      return Math.round((child.hourlyRateMinor ?? rule.amount_minor) * child.durationHours);
    }

    return rule.amount_minor;
  }

  const total = children.reduce((sum, child) => sum + priceFor(child), 0);
  const ready = databaseStatus === "Connected" && db !== null;
  const authRoles: string[] = (() => { try { return authUser ? JSON.parse(authUser.roles) : []; } catch { return []; } })();
  const isAdmin = authRoles.includes("admin");
  const canManage = isAdmin || authRoles.includes("manager");
  const canOperate = canManage || authRoles.includes("cashier");
  const reportAccess = canManage || authRoles.includes("viewer");
  if (!authUser) return <AuthGate onAuthenticated={(user) => { setAuthUser(user); try { if (JSON.parse(user.roles).includes("viewer")) setScreen("reports"); } catch {} }} databaseReady={ready} />;

  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db) return;

    const amount = Number(ruleAmount);
    if (!ruleName.trim() || !Number.isFinite(amount) || amount < 0 || !Number.isFinite(Number(ruleDurationHours)) || Number(ruleDurationHours) < 25/60 || Number(ruleDurationHours) > 12) {
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

  async function createVisit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db || saving) return;

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
          child.durationHours < (25 / 60) ||
          child.durationHours > 12
      )
    ) {
      setError(
        ar
          ? "أدخل اسم كل طفل وحدد السعر ومدة حجز من 25 دقيقة إلى 12 ساعة."
          : "Enter each child's name, pricing rule, and a duration between 25 minutes and 12 hours."
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
              hourlyRateMinor:
                selectedRule.pricing_type === "hourly"
                  ? (row.child.hourlyRateMinor ?? selectedRule.amount_minor)
                  : null,
            }),
            timestamp,
          ]
        );
      }

      await refreshData(db);
      for (const row of childRows) {
        setReceiptQueue((current) => [...current, buildReceiptHtml({
          visitNumber, guardianName: guardianName.trim(), guardianPhone: guardianPhone.trim(),
          childName: row.child.name, checkedInAt: timestamp, expectedCheckoutAt: new Date(new Date(timestamp).getTime() + Math.round(row.child.durationHours * 60) * 60000).toISOString(), paymentMethod,
          bookedMinutes: Math.round(row.child.durationHours * 60),
          baseAmountMinor: priceFor(row.child), discountAmountMinor: 0,
          venueName, venueAddress, venuePhone, issuer: "Cashier",
        }, language)]);
      }
      setGuardianName("");
      setGuardianPhone("");
      setGuardianRelation("Mother");
      setChildren([
        { key: makeId(), name: "", ruleId: "", durationHours: 1 },
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
    const estimatedOvertimeMinutes = child.pricing_type === "hourly" ? Math.max(0, elapsedMinutes - child.duration_minutes) : 0;
    let overtimeCollected = true;
    let overtimeCollectionNote: string | null = null;
    if (estimatedOvertimeMinutes > 0 && hourlyRate !== null) {
      overtimeCollected = window.confirm(ar
        ? "هل تم تحصيل قيمة الوقت الإضافي؟ اضغط موافق لو تم التحصيل، أو إلغاء لو لم يتم التحصيل."
        : "Was the overtime amount collected? Choose OK for collected, Cancel for not collected.");
      if (!overtimeCollected) {
        overtimeCollectionNote = window.prompt(ar ? "اكتب سبب عدم تحصيل الوقت الإضافي (إجباري):" : "Enter the reason overtime was not collected (required):", "")?.trim() || null;
        if (!overtimeCollectionNote) { setError(ar ? "لازم تكتب سبب عدم التحصيل قبل تسجيل الخروج." : "A reason is required when overtime is not collected."); return; }
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
      });

      const receiptRows = await db.select<{
        visit_number: number; guardian_name: string; guardian_phone: string; child_name: string;
        checked_in_at: string; checked_out_at: string; duration_minutes: number;
        actual_duration_minutes: number | null; base_amount_minor: number; discount_amount_minor: number;
        overtime_minutes: number | null; overtime_amount_minor: number | null; final_amount_minor: number; calculation_json: string;
      }[]>(
        `SELECT v.visit_number_local AS visit_number, v.guardian_name_snapshot AS guardian_name,
                v.guardian_phone_snapshot AS guardian_phone, vc.child_name_snapshot AS child_name,
                v.checked_in_at, vc.checked_out_at, p.duration_minutes, vc.actual_duration_minutes,
                p.base_amount_minor, p.discount_amount_minor, p.overtime_minutes,
                p.overtime_amount_minor, p.final_amount_minor, p.calculation_json
         FROM local_visits v JOIN local_visit_children vc ON vc.visit_id = v.id
         JOIN local_visit_child_pricing p ON p.visit_child_id = vc.id WHERE vc.id = ?`,
        [child.visit_child_id]
      );
      const receipt = receiptRows[0];
      if (receipt && receipt.checked_out_at) {
        setReceiptQueue((current) => [...current, buildReceiptHtml({
          visitNumber: receipt.visit_number, guardianName: receipt.guardian_name,
          guardianPhone: receipt.guardian_phone, childName: receipt.child_name,
          checkedInAt: receipt.checked_in_at, checkedOutAt: receipt.checked_out_at, paymentMethod: (() => { try { return JSON.parse(receipt.calculation_json).paymentMethod || "cash"; } catch { return "cash"; } })(),
          bookedMinutes: receipt.duration_minutes, actualMinutes: receipt.actual_duration_minutes || 0,
          baseAmountMinor: receipt.base_amount_minor, discountAmountMinor: receipt.discount_amount_minor,
          overtimeMinutes: receipt.overtime_minutes || 0, overtimeAmountMinor: receipt.overtime_amount_minor || 0,
          totalAmountMinor: receipt.final_amount_minor, venueName, venueAddress, venuePhone, issuer: "Cashier",
        }, language)]);
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
        {authRoles.some(role => ["admin","manager","cashier"].includes(role)) && <button className={screen === "reception" ? "active" : ""} onClick={() => setScreen("reception")}>
          {tr("Reception")}
        </button>}
        {authRoles.some(role => ["admin","manager","cashier"].includes(role)) && <button className={screen === "active" ? "active" : ""} onClick={() => setScreen("active")}>
          {ar ? "الزيارات النشطة" : "Active visits"}
          {activeChildren.length > 0 ? ` (${activeChildren.length})` : ""}
        </button>}
        {isAdmin && <button className={screen === "pricing" ? "active" : ""} onClick={() => setScreen("pricing")}>
          {tr("Pricing setup")}
        </button>}
        {isAdmin && <button className={screen === "settings" ? "active" : ""} onClick={() => setScreen("settings")}>
          {tr("Settings")}
        </button>}
        {reportAccess && <button className={screen === "reports" ? "active" : ""} onClick={() => setScreen("reports")}>
          {ar ? "التقارير والتصدير" : "Reports & Export"}
        </button>}
        {canOperate && <button className={screen === "admin" ? "active" : ""} onClick={() => setScreen("admin")}>
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

      {screen === "admin" ? (
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
                  child.pricing_type === "hourly" &&
                  rate !== null &&
                  booked > 0
                    ? Math.max(0, actual - booked)
                    : 0;

                return (
                  <article className="child-row active-visit-row" key={child.visit_child_id}>
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
                <input value={guardianPhone} onChange={(e) => { setGuardianPhone(e.target.value); setCustomerLookupMessage(""); }} onBlur={() => { if (!db || !guardianPhone.trim()) return; void (async()=>{ const found=await db!.select<{full_name:string}[]>("SELECT full_name FROM local_guardians WHERE phone = ? ORDER BY created_at DESC LIMIT 1",[guardianPhone.trim()]); if(found[0]) setGuardianName(found[0].full_name); const history=await db!.select<{name:string;lastVisit:string}[]>(`SELECT vc.child_name_snapshot AS name, MAX(v.checked_in_at) AS lastVisit FROM local_visits v JOIN local_visit_children vc ON vc.visit_id=v.id WHERE v.guardian_phone_snapshot=? GROUP BY vc.child_name_snapshot ORDER BY MAX(v.checked_in_at) DESC LIMIT 20`,[guardianPhone.trim()]); setPreviousChildren(history); setCustomerLookupMessage(history.length ? (ar ? "تم العثور على العميل وأطفاله السابقين. اضغط على اسم طفل لإضافته." : "Customer history found. Select a previous child to add them.") : (found[0] ? (ar ? "تم العثور على العميل السابق." : "Existing customer found.") : "")); })().catch(()=>{}); }}  required inputMode="tel" placeholder={tr("Guardian phone")} />
                {customerLookupMessage && <span className="muted">{customerLookupMessage}</span>}
              </label>
              {previousChildren.length>0 && <div className="full-width panel"><strong>{ar ? "الأطفال المسجلون سابقًا لنفس رقم الهاتف" : "Children previously registered to this phone"}</strong><div className="rule-list">{previousChildren.map((item,i)=><button type="button" className="secondary-button" key={item.name+i} onClick={()=>{setChildren(current=>[...current,{key:makeId(),name:item.name,ruleId:rules[0]?.id||"",durationHours:1,hourlyRateMinor:rules[0]?.pricing_type==="hourly"?rules[0].amount_minor:null}]);setMessage(ar ? "تمت إضافة الطفل؛ يمكنك تعديل الاسم والمدة والسعر." : "Child added. You can edit the name, duration and price.");}}>{item.name} · {formatDate(item.lastVisit,language)} · {ar ? "إضافة" : "Add"}</button>)}</div></div>}
              <label className="full-width">{ar ? "طريقة الدفع" : "Payment method"}
                <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value as "cash"|"instapay"|"wallet")}><option value="cash">{ar ? "كاش" : "Cash"}</option><option value="instapay">InstaPay</option><option value="wallet">{ar ? "محفظة إلكترونية" : "E-Wallet"}</option></select>
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
                    <label className="booked-hours-field">
                      {ar ? "مدة الحجز (بالساعات أو الدقائق)" : "Booked duration (hours or minutes)"}
                      <input
                        type="number"
                        min="25"
                        max="720"
                        step="5"
                        required
                        value={Number(child.durationHours.toFixed(2))}
                        step="0.25"
                        onChange={(e) => updateChild(child.key, "durationHours", Number(e.target.value))}
                      />
                      <span className="muted">
                        {selected?.pricing_type === "hourly"
                          ? (ar ? "السعر يتغير حسب عدد الساعات" : "Price is multiplied by booked hours")
                          : (ar ? "السعر الأساسي ثابت؛ الإضافي بالدقيقة متاح للتسعير بالساعة فقط" : "Base price stays fixed; per-minute overtime is available for hourly pricing only")}
                      </span>
                    </label>
                    {selected?.pricing_type === "hourly" && <label className="child-pricing">{ar ? "سعر الساعة لهذا الطفل (جنيه)" : "Hourly price for this child (EGP)"}<input type="number" min="0" step="0.01" value={((child.hourlyRateMinor ?? selected.amount_minor) / 100).toFixed(2)} onChange={e => { const v=Math.round(Number(e.target.value||0)*100); setChildren(current=>current.map(item=>item.key===child.key||current.every(x=>x.hourlyRateMinor===null||x.hourlyRateMinor===selected.amount_minor)?{...item,hourlyRateMinor:v}:item)); }} /><span className="muted">{ar ? "تغيير السعر هنا يطبّقه على باقي الأطفال، ويمكنك تعديل سعر أي طفل بعد ذلك." : "Changing this rate applies it to the other children; you can then adjust any child individually."}</span></label>}
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
            <label>{tr("Price in EGP")}
              <input type="number" min="0" step="0.01" value={ruleAmount} onChange={(e) => setRuleAmount(e.target.value)} required placeholder={tr("Enter actual price")} />
            </label>
            <label>{ar ? "مدة الحجز الافتراضية (بالساعات)" : "Default booking duration (hours)"}<input type="number" min="0.42" max="12" step="0.25" value={ruleDurationHours} onChange={e=>setRuleDurationHours(e.target.value)} required /></label>
            <div className="full-width">
              <button className="primary-button" type="submit" disabled={!ready}>{tr("Save pricing rule")}</button>
            </div>
          </form>
          <div className="rule-list">
            <h3>{tr("Active pricing rules")}</h3>
            {rules.length === 0 ? <p className="muted">{tr("No rules configured.")}</p> : rules.map((rule) => (
              <div className="rule-item" key={rule.id}>
                <div><strong>{rule.name}</strong><span>{tr(rule.pricing_type)}</span><span>{ar ? "المدة الافتراضية" : "Default duration"}: {formatDuration(rule.duration_minutes || 60, language)}</span></div>
                <strong>{money(rule.amount_minor, language)}</strong>
                {isAdmin && <button type="button" className="remove-button" onClick={()=>{if(!window.confirm(ar?"حذف/إيقاف قاعدة التسعير؟ إذا كانت مستخدمة في زيارات سابقة فسيتم إيقافها فقط للحفاظ على السجلات.":"Remove this pricing rule? If used in past visits, it will be deactivated to preserve history."))return;void invoke("delete_pricing_rule",{ruleId:rule.id}).then(()=>db&&refreshData(db)).then(()=>setMessage(ar?"تم حذف/إيقاف التسعير.":"Pricing rule removed.")).catch(e=>setError(String(e)));}}>{ar?"حذف":"Remove"}</button>}
              </div>
            ))}
          </div>
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
