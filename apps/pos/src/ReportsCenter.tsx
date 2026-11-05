import { useEffect, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import "./ReportsCenter.css";

type ReportKey = "visits" | "customers" | "payments" | "shifts" | "expenses" | "audit" | "users" | "financials";
type ReportRow = Record<string, string | number | null>;
type Field = { key: string; label: string };

const reports: { key: ReportKey; label: string; description: string; fields: Field[] }[] = [
  { key: "visits", label: "الزيارات والحجوزات", description: "بيانات الدخول والخروج والمدة والأسعار.", fields: [
    {key:"visit_number",label:"رقم الزيارة"},{key:"payment_method",label:"طريقة الدفع"},{key:"child_name",label:"اسم الطفل"},{key:"guardian_name",label:"اسم ولي الأمر"},{key:"phone",label:"رقم التليفون"},{key:"checked_in_at",label:"وقت الدخول"},{key:"expected_checkout",label:"وقت الخروج المتوقع"},{key:"checked_out_at",label:"وقت الخروج الفعلي"},{key:"duration_minutes",label:"المدة المحجوزة بالدقائق"},{key:"actual_duration_minutes",label:"المدة الفعلية بالدقائق"},{key:"base_amount",label:"السعر الأساسي"},{key:"discount_amount",label:"الخصم"},{key:"overtime_amount",label:"الإضافي المستحق"},{key:"overtime_collected",label:"تم تحصيل الإضافي؟"},{key:"overtime_collection_note",label:"سبب عدم التحصيل"},{key:"overtime_waived",label:"إعفاء الإضافي؟"},{key:"overtime_waiver_reason",label:"سبب الإعفاء"},{key:"cancellation_reason",label:"سبب الإلغاء"},{key:"cancelled_by",label:"أُلغي بواسطة"},{key:"cancelled_at",label:"وقت الإلغاء"},{key:"total_amount",label:"الإجمالي المستحق"},{key:"group_count",label:"عدد العمليات بالمجموعة"},{key:"group_total",label:"إجمالي المجموعة"},{key:"group_average",label:"متوسط العملية"},{key:"status",label:"الحالة"}]},
  { key: "customers", label: "العملاء والأطفال", description: "بيانات العملاء وعدد الزيارات وآخر زيارة.", fields: [
    {key:"guardian_name",label:"اسم ولي الأمر"},{key:"phone",label:"رقم التليفون"},{key:"child_name",label:"اسم الطفل"},{key:"visit_count",label:"عدد الزيارات"},{key:"last_visit",label:"آخر زيارة"},{key:"group_count",label:"عدد السجلات بالمجموعة"},{key:"group_total",label:"إجمالي المجموعة"},{key:"group_average",label:"متوسط العملية"}]},
  { key: "payments", label: "التحصيلات وطرق الدفع", description: "المدفوعات المسجلة في قاعدة البيانات.", fields: [
    {key:"created_at",label:"التاريخ"},{key:"visit_number",label:"رقم الزيارة"},{key:"sale_number",label:"رقم عملية البيع"},{key:"sale_description",label:"تفاصيل البيع / الباقة"},{key:"guardian_name",label:"اسم ولي الأمر"},{key:"phone",label:"رقم التليفون"},{key:"method",label:"طريقة الدفع"},{key:"amount",label:"المبلغ"},{key:"status",label:"حالة الدفع"},{key:"received_by",label:"المستلم"},{key:"cash_session_id",label:"رقم الوردية"},{key:"external_reference",label:"رقم مرجعي"},{key:"group_count",label:"عدد العمليات بالمجموعة"},{key:"group_total",label:"إجمالي المجموعة"},{key:"group_average",label:"متوسط العملية"}]},
  { key: "expenses", label: "المصروفات اليومية والشهرية", description: "تفاصيل كل مصروف وتاريخه وطريقة دفعه دون تكرار المصروفات الثابتة.", fields: [{key:"created_at",label:"التاريخ"},{key:"expense_name",label:"اسم المصروف"},{key:"expense_type",label:"نوع المصروف"},{key:"amount",label:"المبلغ"},{key:"method",label:"طريقة الدفع"},{key:"reason",label:"السبب / الملاحظات"},{key:"month",label:"الشهر"},{key:"paid_at",label:"تاريخ الدفع"}]},
  { key: "shifts", label: "الورديات والصندوق", description: "جلسات فتح وإغلاق الصندوق والعجز أو الزيادة.", fields: [
    {key:"opened_at",label:"بداية الوردية"},{key:"closed_at",label:"نهاية الوردية"},{key:"opened_by",label:"فتح بواسطة"},{key:"closed_by",label:"إغلاق بواسطة"},{key:"opening_float",label:"رصيد بداية الوردية"},{key:"expected_cash",label:"النقدية المتوقعة"},{key:"counted_cash",label:"النقدية الفعلية"},{key:"variance",label:"العجز / الزيادة"},{key:"variance_reason",label:"سبب الفرق"},{key:"cash_sales",label:"تحصيلات الكاش"},{key:"electronic_sales",label:"التحصيل الإلكتروني"},{key:"expenses",label:"المصروفات"},{key:"refunds",label:"الاستردادات"},{key:"cash_additions",label:"إضافات الدرج"},{key:"cash_removals",label:"مسحوبات الدرج"},{key:"kids_cash",label:"الأطفال - كاش"},{key:"kids_instapay",label:"الأطفال - InstaPay"},{key:"kids_wallet",label:"الأطفال - محفظة"},{key:"cafe_cash",label:"الكافيه - كاش"},{key:"cafe_instapay",label:"الكافيه - InstaPay"},{key:"cafe_wallet",label:"الكافيه - محفظة"},{key:"kids_visa",label:"الأطفال - فيزا"},{key:"kids_other",label:"الأطفال - أخرى"},{key:"cafe_visa",label:"الكافيه - فيزا"},{key:"cafe_other",label:"الكافيه - أخرى"}]},
  { key: "audit", label: "سجل العمليات", description: "تغييرات البيانات والعمليات المسجلة في سجل المراجعة.", fields: [
    {key:"created_at",label:"التاريخ والوقت"},{key:"actor",label:"المستخدم"},{key:"action",label:"العملية"},{key:"entity_type",label:"نوع البيانات"},{key:"entity_id",label:"رقم السجل"},{key:"reason",label:"السبب"},{key:"before_json",label:"قبل التعديل"},{key:"after_json",label:"بعد التعديل"}]},
  { key: "users", label: "المستخدمون والصلاحيات", description: "حسابات المستخدمين والأدوار والحالة.", fields: [
    {key:"display_name",label:"اسم الموظف"},{key:"username",label:"اسم المستخدم"},{key:"role_codes_json",label:"الأدوار"},{key:"permissions_json",label:"الصلاحيات"},{key:"is_active",label:"الحساب نشط"},{key:"last_authenticated_at",label:"آخر تسجيل دخول"}]},
  { key: "financials", label: "الأرباح والخسائر", description: "تجميع الإيرادات والمصروفات والاستردادات وصافي النتيجة يوميًا أو شهريًا.", fields: [
    {key:"period",label:"الفترة"},{key:"normal_entry",label:"دخول عادي"},{key:"overtime",label:"وقت إضافي محصل"},{key:"membership",label:"مبيعات الاشتراكات"},{key:"other_sales",label:"مبيعات أخرى"},{key:"revenue",label:"إجمالي الإيرادات"},{key:"expenses",label:"المصروفات"},{key:"refunds",label:"الاستردادات"},{key:"net",label:"صافي الربح / الخسارة"},{key:"operation_count",label:"عدد العمليات"},{key:"average_transaction",label:"متوسط العملية"}]},
];

const defaultFields: Record<ReportKey, string[]> = {
  visits:["visit_number","child_name","guardian_name","phone","checked_in_at","expected_checkout","checked_out_at","duration_minutes","total_amount","status"],
  customers:["guardian_name","phone","child_name","visit_count","last_visit"],
  payments:["created_at","visit_number","sale_number","sale_description","guardian_name","method","amount","status","received_by","cash_session_id"],
  expenses:["created_at","expense_name","expense_type","amount","method","reason","month","paid_at"],
  shifts:["opened_at","closed_at","opened_by","closed_by","opening_float","cash_sales","electronic_sales","expenses","refunds","cash_additions","cash_removals","kids_cash","kids_instapay","kids_wallet","cafe_cash","cafe_instapay","cafe_wallet","kids_visa","kids_other","cafe_visa","cafe_other","expected_cash","counted_cash","variance","variance_reason"],
  audit:["created_at","actor","action","entity_type","entity_id"],
  users:["display_name","username","role_codes_json","is_active","last_authenticated_at"],
  financials:["period","normal_entry","overtime","membership","other_sales","revenue","expenses","refunds","net","operation_count","average_transaction"],
};


function xmlEscape(value: unknown) {
  return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}
function excelColumn(n: number) {
  let out = "";
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}
function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let k=0;k<8;k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function createStoredZip(files: {name:string; data:Uint8Array}[]) {
  const enc = new TextEncoder(); const locals:Uint8Array[]=[]; const centrals:Uint8Array[]=[]; let offset=0;
  const u16=(v:number)=>{const a=new Uint8Array(2);new DataView(a.buffer).setUint16(0,v,true);return a};
  const u32=(v:number)=>{const a=new Uint8Array(4);new DataView(a.buffer).setUint32(0,v>>>0,true);return a};
  const join=(parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out};
  for(const file of files){const name=enc.encode(file.name),data=file.data,crc=crc32(data);
    const local=join([u32(0x04034b50),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name,data]);locals.push(local);
    centrals.push(join([u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name]));offset+=local.length;
  }
  const central=join(centrals),end=join([u32(0x06054b50),u16(0),u16(0),u16(files.length),u16(files.length),u32(central.length),u32(offset),u16(0)]);
  const packed=join([...locals,central,end]); const exact=new ArrayBuffer(packed.length); new Uint8Array(exact).set(packed); return new Blob([exact],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}
function makeXlsx(headers:string[], rows:unknown[][]) {
  const enc=new TextEncoder();
  const sheetRows=[headers,...rows].map((row,ri)=>'<row r="'+(ri+1)+'">'+row.map((value,ci)=>{
    const ref=excelColumn(ci+1)+(ri+1);
    if(typeof value==="number"&&Number.isFinite(value))return '<c r="'+ref+'" t="n"><v>'+value+'</v></c>';
    return '<c r="'+ref+'" t="inlineStr"><is><t xml:space="preserve">'+xmlEscape(value)+'</t></is></c>';
  }).join("")+'</row>').join("");
  const sheet='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+sheetRows+'</sheetData></worksheet>';
  const workbook='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const files=[
    {name:"[Content_Types].xml",data:enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')},
    {name:"_rels/.rels",data:enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')},
    {name:"xl/workbook.xml",data:enc.encode(workbook)},
    {name:"xl/_rels/workbook.xml.rels",data:enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')},
    {name:"xl/worksheets/sheet1.xml",data:enc.encode(sheet)}
  ];
  return createStoredZip(files);
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return '"' + text.replace(/"/g, '""') + '"';
}
function dateValue(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ar-EG");
}

export default function ReportsCenter({ db, language, isAdmin = false, canManage = false }: { db: Database | null; language: "ar" | "en"; isAdmin?: boolean; canManage?: boolean }) {
  const [reportKey, setReportKey] = useState<ReportKey>("visits");
  const [selectedFields, setSelectedFields] = useState<string[]>(defaultFields.visits);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [search, setSearch] = useState("");
  const [groupBy, setGroupBy] = useState("none");
  const [sortBy, setSortBy] = useState("date_desc");
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [savedTemplates, setSavedTemplates] = useState<{name:string; key:ReportKey; fields:string[]}[]>(() => {
    try { return JSON.parse(localStorage.getItem("skc.reportTemplates") || "[]"); } catch { return []; }
  });
  const availableReports = reports.filter(r => (r.key !== "users" || isAdmin) && (!["shifts","audit","financials"].includes(r.key) || canManage));
  const current = reports.find(r => r.key === reportKey)!;

  useEffect(() => {
    setSelectedFields(defaultFields[reportKey]);
    setGroupBy("none");
    setRows([]);
    setLoaded(false);
    setError("");
  }, [reportKey]);

  async function runReport() {
    if (!availableReports.some(r => r.key === reportKey)) { setError("ليس لديك صلاحية لعرض هذا التقرير."); return; }
    if (!db) { setError("قاعدة البيانات غير متصلة."); return; }
    setLoading(true); setError("");
    try {
      let result: ReportRow[] = [];
      if (reportKey === "visits") {
        result = await db.select<ReportRow[]>(`SELECT v.visit_number_local AS visit_number, vc.child_name_snapshot AS child_name,
          v.guardian_name_snapshot AS guardian_name, v.guardian_phone_snapshot AS phone, v.checked_in_at, json_extract(p.calculation_json, '$.paymentMethod') AS payment_method,
          CASE WHEN p.duration_minutes > 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', v.checked_in_at, '+' || p.duration_minutes || ' minutes') ELSE NULL END AS expected_checkout,
          vc.checked_out_at, p.duration_minutes, vc.actual_duration_minutes,
          p.base_amount_minor / 100.0 AS base_amount, p.discount_amount_minor / 100.0 AS discount_amount,
          p.overtime_amount_minor / 100.0 AS overtime_amount, p.overtime_collected, p.overtime_collection_note, p.overtime_waived, p.overtime_waiver_reason, v.cancellation_reason, COALESCE(cancel_user.display_name,v.cancelled_by) AS cancelled_by, v.cancelled_at, p.final_amount_minor / 100.0 AS total_amount, v.status
          FROM local_visits v JOIN local_visit_children vc ON vc.visit_id=v.id
          JOIN local_visit_child_pricing p ON p.visit_child_id=vc.id
          LEFT JOIN local_users cancel_user ON cancel_user.id=v.cancelled_by
          WHERE (?='' OR date(v.checked_in_at)>=date(?)) AND (?='' OR date(v.checked_in_at)<=date(?))
          ORDER BY v.checked_in_at DESC`, [startDate,startDate,endDate,endDate]);
      } else if (reportKey === "customers") {
        result = await db.select<ReportRow[]>(`SELECT g.full_name AS guardian_name, g.phone, c.child_name_snapshot AS child_name,
          COUNT(DISTINCT v.id) AS visit_count, MAX(v.checked_in_at) AS last_visit
          FROM local_guardians g LEFT JOIN local_visits v ON v.guardian_id=g.id
          LEFT JOIN local_visit_children c ON c.visit_id=v.id
          WHERE (?='' OR date(v.checked_in_at)>=date(?)) AND (?='' OR date(v.checked_in_at)<=date(?))
          GROUP BY g.id, g.full_name, g.phone, c.child_name_snapshot ORDER BY last_visit DESC`,
          [startDate,startDate,endDate,endDate]);
      } else if (reportKey === "payments") {
        result = await db.select<ReportRow[]>(`SELECT p.created_at, v.visit_number_local AS visit_number,
          v.guardian_name_snapshot AS guardian_name, v.guardian_phone_snapshot AS phone, s.sale_number_local AS sale_number, (SELECT group_concat(description_snapshot, ', ') FROM local_sale_items si WHERE si.sale_id=s.id) AS sale_description, COALESCE(p.method_label,p.method) AS method, p.cash_session_id,
          p.amount_minor/100.0 AS amount, p.status, COALESCE(pay_user.display_name,p.received_by) AS received_by, p.external_reference
          FROM local_payments p LEFT JOIN local_visits v ON v.id=p.visit_id LEFT JOIN local_sales s ON s.id=p.sale_id
          LEFT JOIN local_users pay_user ON pay_user.id=p.received_by
          WHERE (?='' OR date(p.created_at)>=date(?)) AND (?='' OR date(p.created_at)<=date(?))
          ORDER BY p.created_at DESC`, [startDate,startDate,endDate,endDate]);
      } else if (reportKey === "expenses") {
        result = await db.select<ReportRow[]>(`SELECT * FROM (
          SELECT e.created_at AS created_at,e.category AS expense_name,'daily' AS expense_type,e.amount_minor/100.0 AS amount,COALESCE(e.method_label,e.method) AS method,e.reason AS reason,date(e.created_at) AS month,NULL AS paid_at
          FROM local_expenses e WHERE (?='' OR date(e.created_at)>=date(?)) AND (?='' OR date(e.created_at)<=date(?))
          UNION ALL
          SELECT COALESCE(m.paid_at,m.expense_month || '-01') AS created_at,m.expense_name AS expense_name,'monthly' AS expense_type,m.amount_minor/100.0 AS amount,m.payment_method AS method,m.notes AS reason,m.expense_month AS month,m.paid_at AS paid_at
          FROM local_monthly_expenses m WHERE (?='' OR m.expense_month>=strftime('%Y-%m',?)) AND (?='' OR m.expense_month<=strftime('%Y-%m',?))
        ) ORDER BY created_at DESC`,[startDate,startDate,endDate,endDate,startDate,startDate,endDate,endDate]);
      } else if (reportKey === "shifts") {
        result = await db.select<ReportRow[]>(`SELECT opened_at, closed_at, opened_by, closed_by,
          opening_float_minor/100.0 AS opening_float, expected_cash_minor/100.0 AS expected_cash,
          counted_cash_minor/100.0 AS counted_cash, variance_minor/100.0 AS variance, variance_reason,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_payments p WHERE p.cash_session_id=local_cash_sessions.id AND COALESCE(p.method_label,p.method)='cash' AND p.status='confirmed') AS cash_sales,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_payments p WHERE p.cash_session_id=local_cash_sessions.id AND COALESCE(p.method_label,p.method)<>'cash' AND p.status='confirmed') AS electronic_sales,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_expenses e WHERE e.cash_session_id=local_cash_sessions.id) AS expenses,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_refunds r WHERE r.cash_session_id=local_cash_sessions.id) AS refunds,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_cash_movements m WHERE m.cash_session_id=local_cash_sessions.id AND m.movement_type='cash_added') AS cash_additions,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_cash_movements m WHERE m.cash_session_id=local_cash_sessions.id AND m.movement_type='cash_removed') AS cash_removals,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_payments p WHERE p.cash_session_id=local_cash_sessions.id AND p.visit_id IS NOT NULL AND p.method='cash' AND p.status='confirmed') AS kids_cash,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_payments p WHERE p.cash_session_id=local_cash_sessions.id AND p.visit_id IS NOT NULL AND COALESCE(p.method_label,p.method)='instapay' AND p.status='confirmed') AS kids_instapay,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_payments p WHERE p.cash_session_id=local_cash_sessions.id AND p.visit_id IS NOT NULL AND COALESCE(p.method_label,p.method)='wallet' AND p.status='confirmed') AS kids_wallet,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_payments p WHERE p.cash_session_id=local_cash_sessions.id AND p.sale_id IS NOT NULL AND p.method='cash' AND p.status='confirmed') AS cafe_cash,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_payments p WHERE p.cash_session_id=local_cash_sessions.id AND p.sale_id IS NOT NULL AND p.method='instapay' AND p.status='confirmed') AS cafe_instapay,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_payments p WHERE p.cash_session_id=local_cash_sessions.id AND p.sale_id IS NOT NULL AND COALESCE(p.method_label,p.method)='wallet' AND p.status='confirmed') AS cafe_wallet,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_payments p WHERE p.cash_session_id=local_cash_sessions.id AND p.visit_id IS NOT NULL AND COALESCE(p.method_label,p.method)='visa' AND p.status='confirmed') AS kids_visa,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_payments p WHERE p.cash_session_id=local_cash_sessions.id AND p.visit_id IS NOT NULL AND COALESCE(p.method_label,p.method)='other' AND p.status='confirmed') AS kids_other,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_payments p WHERE p.cash_session_id=local_cash_sessions.id AND p.sale_id IS NOT NULL AND COALESCE(p.method_label,p.method)='visa' AND p.status='confirmed') AS cafe_visa,
          (SELECT COALESCE(SUM(amount_minor),0)/100.0 FROM local_payments p WHERE p.cash_session_id=local_cash_sessions.id AND p.sale_id IS NOT NULL AND COALESCE(p.method_label,p.method)='other' AND p.status='confirmed') AS cafe_other
          FROM local_cash_sessions WHERE (?='' OR date(opened_at)>=date(?)) AND (?='' OR date(opened_at)<=date(?))
          ORDER BY opened_at DESC`, [startDate,startDate,endDate,endDate]);
      } else if (reportKey === "financials") {
        const periodExpr = groupBy === "month" ? "strftime('%Y-%m',period)" : "period";
        result = await db.select<ReportRow[]>(`WITH payment_rows AS (
          SELECT date(p.created_at) AS period,
            CASE WHEN v.id IS NOT NULL THEN MAX(0,p.amount_minor-COALESCE((SELECT SUM(CASE WHEN cp.overtime_collected=1 AND cp.overtime_waived=0 THEN cp.overtime_amount_minor ELSE 0 END) FROM local_visit_child_pricing cp JOIN local_visit_children vc ON vc.id=cp.visit_child_id WHERE vc.visit_id=v.id),0)) ELSE 0 END AS normal_entry,
            CASE WHEN v.id IS NOT NULL THEN COALESCE((SELECT SUM(CASE WHEN cp.overtime_collected=1 AND cp.overtime_waived=0 THEN cp.overtime_amount_minor ELSE 0 END) FROM local_visit_child_pricing cp JOIN local_visit_children vc ON vc.id=cp.visit_child_id WHERE vc.visit_id=v.id),0) ELSE 0 END AS overtime,
            CASE WHEN s.id IS NOT NULL AND EXISTS(SELECT 1 FROM local_sale_items si WHERE si.sale_id=s.id AND si.description_snapshot LIKE 'Membership package:%') THEN p.amount_minor ELSE 0 END AS membership,
            CASE WHEN s.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM local_sale_items si WHERE si.sale_id=s.id AND si.description_snapshot LIKE 'Membership package:%') THEN p.amount_minor ELSE 0 END AS other_sales,
            0 AS expenses,0 AS refunds,p.amount_minor AS transaction_amount,1 AS payment_count
          FROM local_payments p LEFT JOIN local_visits v ON v.id=p.visit_id LEFT JOIN local_sales s ON s.id=p.sale_id
          WHERE p.status='confirmed' AND (?='' OR date(p.created_at)>=date(?)) AND (?='' OR date(p.created_at)<=date(?))
        ), expense_rows AS (
          SELECT date(e.created_at) AS period,0 AS normal_entry,0 AS overtime,0 AS membership,0 AS other_sales,e.amount_minor AS expenses,0 AS refunds,0 AS transaction_amount,0 AS payment_count
          FROM local_expenses e WHERE (?='' OR date(e.created_at)>=date(?)) AND (?='' OR date(e.created_at)<=date(?))
        ), refund_rows AS (
          SELECT date(r.created_at) AS period,0 AS normal_entry,0 AS overtime,0 AS membership,0 AS other_sales,0 AS expenses,r.amount_minor AS refunds,0 AS transaction_amount,0 AS payment_count
          FROM local_refunds r WHERE (?='' OR date(r.created_at)>=date(?)) AND (?='' OR date(r.created_at)<=date(?))
        ), monthly_expense_rows AS (
          SELECT date(expense_month || '-01') AS period,0 AS normal_entry,0 AS overtime,0 AS membership,0 AS other_sales,amount_minor AS expenses,0 AS refunds,0 AS transaction_amount,0 AS payment_count
          FROM local_monthly_expenses WHERE (?='' OR expense_month>=strftime('%Y-%m',?)) AND (?='' OR expense_month<=strftime('%Y-%m',?))
        ), all_rows AS (SELECT * FROM payment_rows UNION ALL SELECT * FROM expense_rows UNION ALL SELECT * FROM refund_rows UNION ALL SELECT * FROM monthly_expense_rows)
        SELECT ${periodExpr} AS period,SUM(normal_entry)/100.0 AS normal_entry,SUM(overtime)/100.0 AS overtime,
          SUM(membership)/100.0 AS membership,SUM(other_sales)/100.0 AS other_sales,(SUM(normal_entry)+SUM(overtime)+SUM(membership)+SUM(other_sales))/100.0 AS revenue,
          SUM(expenses)/100.0 AS expenses,SUM(refunds)/100.0 AS refunds,
          (SUM(normal_entry)+SUM(overtime)+SUM(membership)+SUM(other_sales)-SUM(expenses)-SUM(refunds))/100.0 AS net,
          COUNT(*) AS operation_count,
          CASE WHEN SUM(payment_count)>0 THEN SUM(transaction_amount)/SUM(payment_count)/100.0 ELSE 0 END AS average_transaction
        FROM all_rows GROUP BY ${periodExpr} ORDER BY period DESC`,
        [startDate,startDate,endDate,endDate,startDate,startDate,endDate,endDate,startDate,startDate,endDate,endDate,startDate,startDate,endDate,endDate]);
      } else if (reportKey === "audit") {
        result = await db.select<ReportRow[]>(`SELECT a.created_at, COALESCE(u.display_name,a.actor_user_id) AS actor,
          a.action, a.entity_type, a.entity_id, a.reason, a.before_json, a.after_json
          FROM local_audit_log a LEFT JOIN local_users u ON u.id=a.actor_user_id
          WHERE (?='' OR date(a.created_at)>=date(?)) AND (?='' OR date(a.created_at)<=date(?))
          ORDER BY a.created_at DESC`, [startDate,startDate,endDate,endDate]);
      } else {
        result = await db.select<ReportRow[]>(`SELECT display_name, role_codes_json, permissions_json, is_active, last_authenticated_at
          FROM local_users ORDER BY display_name`);
      }
      const query = search.trim().toLocaleLowerCase();
      if (query) result = result.filter(row => Object.values(row).some(value => String(value ?? "").toLocaleLowerCase().includes(query)));
      if (sortBy === "name_asc") result.sort((a,b) => String(a.guardian_name ?? a.display_name ?? a.child_name ?? "").localeCompare(String(b.guardian_name ?? b.display_name ?? b.child_name ?? ""), "ar"));
      if (sortBy === "amount_desc") result.sort((a,b) => Number(b.group_total ?? b.total_amount ?? b.amount ?? 0)-Number(a.group_total ?? a.total_amount ?? a.amount ?? 0));
      if (sortBy === "amount_asc") result.sort((a,b) => Number(a.group_total ?? a.total_amount ?? a.amount ?? 0)-Number(b.group_total ?? b.total_amount ?? b.amount ?? 0));
      if (groupBy !== "none" && reportKey !== "financials") {
        const grouped = new Map<string, ReportRow>();
        for (const row of result) {
          const raw = groupBy === "method" ? (row.method ?? row.payment_method) : groupBy === "actor" ? (row.actor ?? row.received_by) : row[groupBy];
          const key = String(raw ?? "—");
          const current = grouped.get(key) ?? {...row, group_count:0, group_total:0};
          current.group_count = Number(current.group_count ?? 0) + 1;
          current.group_total = Number(current.group_total ?? 0) + Number(row.total_amount ?? row.amount ?? row.visit_count ?? 0);
          current.group_average = Number(current.group_total) / Number(current.group_count);
          grouped.set(key,current);
        }
        result = Array.from(grouped.values()).sort((a,b)=>String(a[groupBy]??"").localeCompare(String(b[groupBy]??""),"ar"));
      }
      setRows(result); setLoaded(true);
    } catch (e) {
      setError("تعذر إنشاء التقرير. قد تكون بعض البيانات أو الجداول غير متاحة بعد. التفاصيل: " + (e instanceof Error ? e.message : String(e)));
      setRows([]); setLoaded(false);
    } finally { setLoading(false); }
  }

  function saveTemplate() {
    const name = window.prompt("اسم قالب التقرير");
    if (!name?.trim()) return;
    const next = [...savedTemplates, {name:name.trim(),key:reportKey,fields:selectedFields}];
    setSavedTemplates(next);
    try { localStorage.setItem("skc.reportTemplates", JSON.stringify(next)); } catch {}
  }
  function useTemplate(index: number) {
    const template = savedTemplates[index];
    if (!template) return;
    setReportKey(template.key); setSelectedFields(template.fields);
  }
  function exportCsv() {
    if (!loaded) { setError("اعرض التقرير أولًا قبل التصدير."); return; }
    const columns = current.fields.filter(f => selectedFields.includes(f.key));
    if (!columns.length) { setError("اختار عمودًا واحدًا على الأقل قبل التصدير."); return; }
    const data = [columns.map(f => csvCell(f.label)).join(","), ...rows.map(row => columns.map(f => csvCell(row[f.key])).join(","))].join("\r\n");
    const blob = new Blob(["\uFEFF", data], {type:"text/csv;charset=utf-8;"});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href=url; anchor.download=`secret-kids-club-${reportKey}-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  function exportXlsx() {
    if (!loaded) { setError("اعرض التقرير أولًا قبل التصدير."); return; }
    const columns = current.fields.filter(f => selectedFields.includes(f.key));
    if (!columns.length) { setError("اختار عمودًا واحدًا على الأقل قبل التصدير."); return; }
    const values = rows.map(row => columns.map(field => row[field.key] ?? ""));
    const blob = makeXlsx(columns.map(field=>field.label), values);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href=url; anchor.download=`secret-kids-club-${reportKey}-${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  function exportPdf() {
    if (!loaded) { setError("اعرض التقرير أولًا قبل التصدير."); return; }
    window.print();
  }

  const display = (key: string, value: unknown) => {
    if (key.endsWith("_at") || key === "last_visit" || key === "expected_checkout") return dateValue(value == null ? "" : String(value));
    if (key === "is_active") return Number(value) === 1 ? "نشط" : "متوقف";
    if (key === "overtime_collected") return Number(value) === 1 ? "تم التحصيل" : "لم يتم التحصيل";
    if (key === "overtime_waived") return Number(value) === 1 ? "تم الإعفاء" : "لا";
    if (["base_amount","discount_amount","overtime_amount","total_amount","amount","opening_float","expected_cash","counted_cash","variance","cash_sales","electronic_sales","expenses","refunds","cash_additions","cash_removals","kids_cash","kids_instapay","kids_wallet","cafe_cash","cafe_instapay","cafe_wallet","kids_visa","kids_other","cafe_visa","cafe_other","normal_entry","overtime","membership","other_sales","revenue","net","average_transaction","group_total","group_average"].includes(key) && value !== null && value !== undefined) return Number(value).toLocaleString("ar-EG",{style:"currency",currency:"EGP"});
    if (key === "method" || key === "payment_method") return ({cash:"كاش",instapay:"إنستاباي",wallet:"محفظة إلكترونية",visa:"فيزا",other:"أخرى"} as Record<string,string>)[String(value)] ?? String(value ?? "");
    if (key === "status") return ({active:"نشطة",completed:"مكتملة",cancelled:"ملغاة",confirmed:"تم التحصيل",pending:"معلقة",failed:"فشلت",refunded:"مستردة"} as Record<string,string>)[String(value)] ?? String(value ?? "");
    return String(value ?? "—");
  };

  return <section className="panel report-center" dir={language==="ar"?"rtl":"ltr"}>
    <div className="panel-title"><div><span className="step">05</span><h3>مركز التقارير والتصدير</h3></div><span className="muted">تقارير قابلة للتخصيص</span></div>
    <p className="muted intro">طريقة الاستخدام: ١) اختار نوع التقرير. ٢) حدد الفترة والأعمدة المطلوبة. ٣) اضغط «عرض التقرير» وانتظر ظهور الجدول. ٤) بعد ظهور النتائج اضغط «تصدير Excel (.xlsx)» لحفظ ملف Excel، أو CSV. لو لم تظهر النتائج ستجد رسالة الخطأ هنا. التقارير تعرض البيانات المحفوظة فعليًا فقط.</p>
    <div className="report-controls">
      <label>نوع التقرير<select value={reportKey} onChange={e=>setReportKey(e.target.value as ReportKey)}>{availableReports.map(r=><option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
      <label>من تاريخ<input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)}/></label>
      <label>إلى تاريخ<input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)}/></label>
      <label>بحث داخل النتائج<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="اسم، تليفون، أو كلمة..."/></label>
      <label>تجميع حسب<select value={groupBy} onChange={e=>setGroupBy(e.target.value)}><option value="none">بدون تجميع</option><option value="guardian_name">ولي الأمر</option><option value="child_name">الطفل</option><option value="method">طريقة الدفع</option><option value="status">الحالة</option><option value="actor">المستخدم</option><option value="received_by">الموظف المستلم</option>{reportKey==="financials"&&<option value="month">شهري</option>}</select></label>
      <label>ترتيب النتائج<select value={sortBy} onChange={e=>setSortBy(e.target.value)}><option value="date_desc">الأحدث أولًا</option><option value="name_asc">الاسم أبجديًا</option><option value="amount_desc">المبلغ الأكبر أولًا</option><option value="amount_asc">المبلغ الأصغر أولًا</option></select></label>
    </div>
    <div className="report-field-panel"><div className="report-field-title"><strong>الأعمدة المطلوبة</strong><div><button type="button" className="secondary-button" onClick={()=>setSelectedFields(current.fields.map(f=>f.key))}>تحديد الكل</button><button type="button" className="secondary-button" onClick={()=>setSelectedFields([])}>مسح الاختيار</button></div></div>
      <div className="report-field-list">{current.fields.map(field=><label key={field.key} className="report-check"><input type="checkbox" checked={selectedFields.includes(field.key)} onChange={e=>setSelectedFields(old=>e.target.checked?[...old,field.key]:old.filter(key=>key!==field.key))}/><span>{field.label}</span></label>)}</div>
    </div>
    <div className="report-actions"><button className="primary-button" type="button" onClick={()=>void runReport()} disabled={loading||!db}>{loading?"جارٍ إعداد التقرير...":"عرض التقرير"}</button><button className="secondary-button" type="button" onClick={saveTemplate}>حفظ كقالب</button><button className="secondary-button" type="button" onClick={exportXlsx} disabled={!loaded}>تصدير Excel (.xlsx)</button><button className="secondary-button" type="button" onClick={exportCsv} disabled={!loaded}>تصدير CSV</button><button className="secondary-button" type="button" onClick={exportPdf} disabled={!loaded}>طباعة / حفظ PDF</button></div>
    {savedTemplates.length>0&&<div className="report-templates"><strong>قوالبي المحفوظة</strong>{savedTemplates.map((template,index)=><button key={template.name+index} className="secondary-button" type="button" onClick={()=>useTemplate(index)}>{template.name}</button>)}</div>}
    {error&&<div className="notice error" role="alert">{error}</div>}
    {loaded&&<div className="report-preview" id="report-print-area"><div className="report-preview-head"><div><h3>{current.label}</h3><p>{startDate||"بداية الفترة"} — {endDate||"حتى الآن"}</p></div><strong>{rows.length} سجل</strong></div>
      {selectedFields.length===0?<p>اختار عمودًا واحدًا على الأقل.</p>:<div className="report-table-wrap"><table className="report-table"><thead><tr>{current.fields.filter(f=>selectedFields.includes(f.key)).map(f=><th key={f.key}>{f.label}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index}>{current.fields.filter(f=>selectedFields.includes(f.key)).map(f=><td key={f.key}>{display(f.key,row[f.key])}</td>)}</tr>)}</tbody></table>{rows.length===0&&<p className="muted">لا توجد بيانات مطابقة للفلاتر المختارة.</p>}</div>}
    </div>}
  </section>;
}
