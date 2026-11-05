
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { t, useLanguage, type Language } from "./i18n";

type PricingRule = {
  id: string;
  name: string;
  pricing_type: "fixed" | "hourly" | "offer";
  amount_minor: number;
  is_active: number;
};

type ChildDraft = {
  key: string;
  name: string;
  ruleId: string;
  durationHours: number;
};

type Screen = "reception" | "active" | "pricing" | "settings";


type ReceiptData = {
  kind: "checkin" | "checkout";
  visitNumber: number;
  guardianName: string;
  guardianPhone: string;
  childName: string;
  checkedInAt: string;
  expectedCheckoutAt?: string;
  checkedOutAt?: string;
  bookedMinutes: number;
  actualMinutes?: number;
  baseAmountMinor: number;
  discountAmountMinor: number;
  overtimeMinutes?: number;
  overtimeAmountMinor?: number;
  overtimeCollected?: boolean;
  overtimeCollectionNote?: string | null;
  finalAmountMinor: number;
  language: Language;
};

function escapeReceipt(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function receiptDate(value: string | undefined, language: Language): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(language === "ar" ? "ar-EG" : "en-EG");
}

function receiptMoney(value: number, language: Language): string {
  return new Intl.NumberFormat(language === "ar" ? "ar-EG" : "en-EG", {
    style: "currency", currency: "EGP",
  }).format(value / 100);
}

function buildReceiptHtml(receipt: ReceiptData): string {
  const ar = receipt.language === "ar";
  const row = (label: string, value: string) =>
    `<div class="line"><span>${escapeReceipt(label)}</span><strong>${escapeReceipt(value)}</strong></div>`;
  const lines = [
    row(ar ? "رقم الزيارة" : "Visit number", `#${receipt.visitNumber}`),
    row(ar ? "اسم المرافق" : "Guardian", receipt.guardianName),
    row(ar ? "رقم الهاتف" : "Phone", receipt.guardianPhone),
    row(ar ? "اسم الطفل" : "Child", receipt.childName),
    row(ar ? "وقت الدخول" : "Check-in", receiptDate(receipt.checkedInAt, receipt.language)),
    row(ar ? "المدة المحجوزة" : "Booked duration", formatDuration(receipt.bookedMinutes, receipt.language)),
    receipt.kind === "checkin"
      ? row(ar ? "الخروج المتوقع" : "Expected checkout", receiptDate(receipt.expectedCheckoutAt, receipt.language))
      : row(ar ? "وقت الخروج الفعلي" : "Actual checkout", receiptDate(receipt.checkedOutAt, receipt.language)),
    ...(receipt.kind === "checkout" ? [
      row(ar ? "المدة الفعلية" : "Actual duration", formatDuration(receipt.actualMinutes ?? 0, receipt.language)),
      row(ar ? "الوقت الإضافي" : "Overtime", formatDuration(receipt.overtimeMinutes ?? 0, receipt.language)),
      row(ar ? "قيمة الوقت الإضافي" : "Overtime amount", receiptMoney(receipt.overtimeAmountMinor ?? 0, receipt.language)),
      row(ar ? "تحصيل الوقت الإضافي" : "Overtime collected", receipt.overtimeCollected ? (ar ? "نعم" : "Yes") : (ar ? "لا" : "No")),
      ...(receipt.overtimeCollectionNote ? [row(ar ? "سبب عدم التحصيل" : "Not collected reason", receipt.overtimeCollectionNote)] : []),
    ] : []),
    row(ar ? "السعر الأساسي" : "Base amount", receiptMoney(receipt.baseAmountMinor, receipt.language)),
    row(ar ? "الخصم" : "Discount", receiptMoney(receipt.discountAmountMinor, receipt.language)),
    row(ar ? "الإجمالي" : "Total", receiptMoney(receipt.finalAmountMinor, receipt.language)),
  ].join("");
  const title = receipt.kind === "checkin"
    ? (ar ? "إيصال دخول" : "CHECK-IN RECEIPT")
    : (ar ? "إيصال خروج" : "CHECK-OUT RECEIPT");
  return `<!doctype html><html lang="${ar ? "ar" : "en"}" dir="${ar ? "rtl" : "ltr"}"><head><meta charset="utf-8"><title>${title}</title><style>
    @page{size:80mm auto;margin:3mm}*{box-sizing:border-box}body{width:74mm;margin:0 auto;padding:2mm 0;color:#111;font:12px/1.45 Arial,sans-serif}
    h1{text-align:center;font-size:17px;margin:0 0 3px}h2{text-align:center;font-size:13px;margin:0 0 10px;border-bottom:1px dashed #555;padding-bottom:8px}
    .line{display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dotted #bbb;align-items:flex-start}
    .line span{max-width:48%;color:#444}.line strong{max-width:52%;text-align:end;overflow-wrap:anywhere}
    .thanks{text-align:center;margin:14px 0 4px;font-weight:700}.foot{text-align:center;font-size:10px;margin-top:8px}
    @media screen{body{border:1px solid #ddd;padding:8px;margin:8px auto}}
  </style></head><body><h1>Secret Kids Club</h1><h2>${title}</h2>${lines}
  <div class="thanks">${ar ? "شرفتنا ونورتنا، مستنينكم تيجوا تنورونا تاني ❤️" : "Thank you for visiting! We look forward to seeing you again ❤️"}</div>
  <div class="foot">${receiptDate(new Date().toISOString(), receipt.language)}</div></body></html>`;
}

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
  const [receiptQueue, setReceiptQueue] = useState<ReceiptData[]>([]);
  const [receiptIndex, setReceiptIndex] = useState(0);
  const activeReceipt = receiptQueue[receiptIndex] ?? null;

  function closeReceiptQueue() {
    setReceiptQueue([]);
    setReceiptIndex(0);
  }

  function skipReceipt() {
    if (receiptIndex + 1 < receiptQueue.length) setReceiptIndex((index) => index + 1);
    else closeReceiptQueue();
  }

  function printCurrentReceipt() {
    const frame = document.getElementById("receipt-print-frame") as HTMLIFrameElement | null;
    frame?.contentWindow?.focus();
    frame?.contentWindow?.print();
    skipReceipt();
  }


  const [guardianName, setGuardianName] = useState("");
  const [guardianRelation, setGuardianRelation] = useState("Mother");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [children, setChildren] = useState<ChildDraft[]>([
    { key: makeId(), name: "", ruleId: "", durationHours: 1 },
  ]);

  const [ruleName, setRuleName] = useState("");
  const [ruleType, setRuleType] =
    useState<PricingRule["pricing_type"]>("fixed");
  const [ruleAmount, setRuleAmount] = useState("");

  const refreshData = useCallback(async (connection: Database) => {
    const loadedRules = await connection.select<PricingRule[]>(
      `SELECT id, name, pricing_type, amount_minor, is_active
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
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  function updateChild(
    key: string,
    field: "name" | "ruleId" | "durationHours",
    value: string | number
  ) {
    setChildren((current) =>
      current.map((child) => {
        if (child.key !== key) return child;
        if (field === "durationHours") {
          return { ...child, durationHours: Number(value) };
        }
        return { ...child, [field]: value };
      })
    );
  }

  function addChild() {
    setChildren((current) => [
      ...current,
      { key: makeId(), name: "", ruleId: "", durationHours: 1 },
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
      return Math.round(rule.amount_minor * child.durationHours);
    }

    return rule.amount_minor;
  }

  const total = children.reduce((sum, child) => sum + priceFor(child), 0);
  const ready = databaseStatus === "Connected" && db !== null;

  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db) return;

    const amount = Number(ruleAmount);
    if (!ruleName.trim() || !Number.isFinite(amount) || amount < 0) {
      setError(tr("Enter a rule name and a valid non-negative price."));
      return;
    }

    setError("");
    setMessage("");

    try {
      await db.execute(
        `INSERT INTO local_pricing_rules
         (id, name, pricing_type, calculation_type, amount_minor,
          duration_minutes, free_minutes, priority, weekdays_json,
          is_active, created_at)
         VALUES (?, ?, ?, 'fixed', ?, 60, 0, 100, '[]', 1, ?)`,
        [makeId(), ruleName.trim(), ruleType, Math.round(amount * 100), now()]
      );

      setRuleName("");
      setRuleAmount("");
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
          child.durationHours < 0.5 ||
          child.durationHours > 12
      )
    ) {
      setError(
        ar
          ? "أدخل اسم كل طفل وحدد السعر ومدة حجز من نصف ساعة إلى 12 ساعة."
          : "Enter each child's name, pricing rule, and a duration between 0.5 and 12 hours."
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, 0, ?, 'local-cashier', 'pending', ?)`,
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
              bookedDurationMinutes: bookedMinutes,
              hourlyRateMinor:
                selectedRule.pricing_type === "hourly"
                  ? selectedRule.amount_minor
                  : null,
            }),
            timestamp,
          ]
        );
      }

      await refreshData(db);
      const checkinReceipts: ReceiptData[] = childRows.map((row) => {
        const bookedMinutes = Math.round(row.child.durationHours * 60);
        const baseAmount = priceFor(row.child);
        const expected = new Date(timestamp);
        expected.setMinutes(expected.getMinutes() + bookedMinutes);
        return {
          kind: "checkin",
          visitNumber,
          guardianName: guardianName.trim(),
          guardianPhone: guardianPhone.trim(),
          childName: row.child.name,
          checkedInAt: timestamp,
          expectedCheckoutAt: expected.toISOString(),
          bookedMinutes,
          baseAmountMinor: baseAmount,
          discountAmountMinor: 0,
          finalAmountMinor: baseAmount,
          language,
        };
      });
      setReceiptQueue(checkinReceipts);
      setReceiptIndex(0);
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

    setCheckoutId(child.visit_child_id);
    setError("");
    setMessage("");

    try {
      await invoke<void>("checkout_child", {
        visitChildId: child.visit_child_id,
      });

      await refreshData(db);

      try {
        const savedRows = await db.select<{
          visit_number: number; guardian_name: string; guardian_phone: string;
          child_name: string; checked_in_at: string; checked_out_at: string;
          booked_minutes: number; actual_minutes: number; base_amount_minor: number;
          discount_amount_minor: number; overtime_minutes: number;
          overtime_amount_minor: number; overtime_collected: number;
          overtime_collection_note: string | null; final_amount_minor: number;
        }[]>(`
          SELECT v.visit_number_local AS visit_number,
                 v.guardian_name_snapshot AS guardian_name,
                 v.guardian_phone_snapshot AS guardian_phone,
                 vc.child_name_snapshot AS child_name,
                 v.checked_in_at, vc.checked_out_at,
                 p.duration_minutes AS booked_minutes,
                 vc.actual_duration_minutes AS actual_minutes,
                 p.base_amount_minor, p.discount_amount_minor,
                 p.overtime_minutes, p.overtime_amount_minor,
                 p.overtime_collected, p.overtime_collection_note,
                 p.final_amount_minor
          FROM local_visit_children vc
          JOIN local_visits v ON v.id = vc.visit_id
          JOIN local_visit_child_pricing p ON p.visit_child_id = vc.id
          WHERE vc.id = ?
        `, [child.visit_child_id]);
        const saved = savedRows[0];
        if (saved) {
          setReceiptQueue([{
            kind: "checkout", visitNumber: saved.visit_number,
            guardianName: saved.guardian_name, guardianPhone: saved.guardian_phone,
            childName: saved.child_name, checkedInAt: saved.checked_in_at,
            checkedOutAt: saved.checked_out_at, bookedMinutes: saved.booked_minutes,
            actualMinutes: saved.actual_minutes, baseAmountMinor: saved.base_amount_minor,
            discountAmountMinor: saved.discount_amount_minor,
            overtimeMinutes: saved.overtime_minutes,
            overtimeAmountMinor: saved.overtime_amount_minor,
            overtimeCollected: saved.overtime_collected === 1,
            overtimeCollectionNote: saved.overtime_collection_note,
            finalAmountMinor: saved.final_amount_minor, language,
          }]);
          setReceiptIndex(0);
        }
      } catch (receiptError) {
        setError(ar
          ? `تم تسجيل الخروج، لكن تعذر تجهيز الإيصال: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`
          : `Checkout was saved, but the receipt could not be prepared: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`);
      }

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
    <main className="app-shell">
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
        <button className={screen === "reception" ? "active" : ""} onClick={() => setScreen("reception")}>
          {tr("Reception")}
        </button>
        <button className={screen === "active" ? "active" : ""} onClick={() => setScreen("active")}>
          {ar ? "الزيارات النشطة" : "Active visits"}
          {activeChildren.length > 0 ? ` (${activeChildren.length})` : ""}
        </button>
        <button className={screen === "pricing" ? "active" : ""} onClick={() => setScreen("pricing")}>
          {tr("Pricing setup")}
        </button>
        <button className={screen === "settings" ? "active" : ""} onClick={() => setScreen("settings")}>
          {tr("Settings")}
        </button>
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

      {screen === "settings" ? (
        <section className="panel settings-panel">
          <div className="panel-title">
            <div><span className="step">01</span><h3>{tr("Settings")}</h3></div>
          </div>
          <p className="muted intro">{tr("Choose the language used throughout the application.")}</p>
          <label>
            {tr("Language")}
            <select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>
              <option value="en">{tr("English")}</option>
              <option value="ar">{tr("Arabic")}</option>
            </select>
          </label>
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
                      <span className="muted">{child.guardian_name} · {child.guardian_phone}</span>
                      <span className="muted">
                        {ar ? "الدخول: " : "Checked in: "}{formatDate(child.checked_in_at, language)}
                      </span>
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
                <input value={guardianPhone} onChange={(e) => setGuardianPhone(e.target.value)} required inputMode="tel" placeholder={tr("Guardian phone")} />
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
                      {ar ? "مدة الحجز لكل طفل (بالساعات)" : "Booked duration per child (hours)"}
                      <input
                        type="number"
                        min="0.5"
                        max="12"
                        step="0.5"
                        required
                        value={child.durationHours}
                        onChange={(e) => updateChild(child.key, "durationHours", Number(e.target.value))}
                      />
                      <span className="muted">
                        {selected?.pricing_type === "hourly"
                          ? (ar ? "السعر يتغير حسب عدد الساعات" : "Price is multiplied by booked hours")
                          : (ar ? "السعر الأساسي ثابت؛ الإضافي بالدقيقة متاح للتسعير بالساعة فقط" : "Base price stays fixed; per-minute overtime is available for hourly pricing only")}
                      </span>
                    </label>
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
              {saving ? tr("Saving visit…") : tr("Confirm check-in")}
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
            <div className="full-width">
              <button className="primary-button" type="submit" disabled={!ready}>{tr("Save pricing rule")}</button>
            </div>
          </form>
          <div className="rule-list">
            <h3>{tr("Active pricing rules")}</h3>
            {rules.length === 0 ? <p className="muted">{tr("No rules configured.")}</p> : rules.map((rule) => (
              <div className="rule-item" key={rule.id}>
                <div><strong>{rule.name}</strong><span>{tr(rule.pricing_type)}</span></div>
                <strong>{money(rule.amount_minor, language)}</strong>
              </div>
            ))}
          </div>
        </section>
      )}

      {activeReceipt && (
        <div className="receipt-overlay" role="dialog" aria-modal="true" aria-label={ar ? "معاينة الإيصال" : "Receipt preview"}>
          <section className="receipt-dialog">
            <div className="receipt-dialog-heading">
              <div>
                <strong>{ar ? "معاينة الإيصال" : "Receipt preview"}</strong>
                <span>{receiptIndex + 1} / {receiptQueue.length} · {activeReceipt.kind === "checkin" ? (ar ? "دخول" : "Check-in") : (ar ? "خروج" : "Check-out")}</span>
              </div>
              <button type="button" className="remove-button" onClick={closeReceiptQueue} aria-label={ar ? "إغلاق" : "Close"}>×</button>
            </div>
            <iframe id="receipt-print-frame" title={ar ? "معاينة الإيصال" : "Receipt preview"} srcDoc={buildReceiptHtml(activeReceipt)} />
            <div className="receipt-actions">
              <button type="button" className="primary-button" onClick={printCurrentReceipt}>{ar ? "طباعة الإيصال" : "Print receipt"}</button>
              <button type="button" className="secondary-button" onClick={skipReceipt}>{ar ? "بدون طباعة / التالي" : "Skip printing / Next"}</button>
            </div>
          </section>
        </div>
      )}

      <footer>
        <span>Secret Kids Club POS</span>
        <span>{visits} {tr(visits === 1 ? "saved visit" : "saved visits")} · {tr("Local SQLite")}</span>
      </footer>
    </main>
  );
}
