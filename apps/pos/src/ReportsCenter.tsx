import { useEffect, useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import "./ReportsCenter.css";

type ReportKey = "visits" | "customers" | "payments" | "shifts" | "audit" | "users";
type ReportRow = Record<string, string | number | null>;
type Field = { key: string; label: string };

const reports: { key: ReportKey; label: string; description: string; fields: Field[] }[] = [
  { key: "visits", label: "الزيارات والحجوزات", description: "بيانات الدخول والخروج والمدة والأسعار.", fields: [
    {key:"visit_number",label:"رقم الزيارة"},{key:"payment_method",label:"طريقة الدفع"},{key:"child_name",label:"اسم الطفل"},{key:"guardian_name",label:"اسم ولي الأمر"},{key:"phone",label:"رقم التليفون"},{key:"checked_in_at",label:"وقت الدخول"},{key:"expected_checkout",label:"وقت الخروج المتوقع"},{key:"checked_out_at",label:"وقت الخروج الفعلي"},{key:"duration_minutes",label:"المدة المحجوزة بالدقائق"},{key:"actual_duration_minutes",label:"المدة الفعلية بالدقائق"},{key:"base_amount",label:"السعر الأساسي"},{key:"discount_amount",label:"الخصم"},{key:"overtime_amount",label:"الإضافي"},{key:"total_amount",label:"الإجمالي"},{key:"status",label:"الحالة"}]},
  { key: "customers", label: "العملاء والأطفال", description: "بيانات العملاء وعدد الزيارات وآخر زيارة.", fields: [
    {key:"guardian_name",label:"اسم ولي الأمر"},{key:"phone",label:"رقم التليفون"},{key:"child_name",label:"اسم الطفل"},{key:"visit_count",label:"عدد الزيارات"},{key:"last_visit",label:"آخر زيارة"}]},
  { key: "payments", label: "التحصيلات وطرق الدفع", description: "المدفوعات المسجلة في قاعدة البيانات.", fields: [
    {key:"created_at",label:"التاريخ"},{key:"visit_number",label:"رقم الزيارة"},{key:"guardian_name",label:"اسم ولي الأمر"},{key:"phone",label:"رقم التليفون"},{key:"method",label:"طريقة الدفع"},{key:"amount",label:"المبلغ"},{key:"status",label:"حالة الدفع"},{key:"received_by",label:"المستلم"},{key:"external_reference",label:"رقم مرجعي"}]},
  { key: "shifts", label: "الورديات والصندوق", description: "جلسات فتح وإغلاق الصندوق والعجز أو الزيادة.", fields: [
    {key:"opened_at",label:"بداية الوردية"},{key:"closed_at",label:"نهاية الوردية"},{key:"opened_by",label:"فتح بواسطة"},{key:"closed_by",label:"إغلاق بواسطة"},{key:"opening_float",label:"رصيد بداية الوردية"},{key:"expected_cash",label:"النقدية المتوقعة"},{key:"counted_cash",label:"النقدية الفعلية"},{key:"variance",label:"العجز / الزيادة"}]},
  { key: "audit", label: "سجل العمليات", description: "تغييرات البيانات والعمليات المسجلة في سجل المراجعة.", fields: [
    {key:"created_at",label:"التاريخ والوقت"},{key:"actor",label:"المستخدم"},{key:"action",label:"العملية"},{key:"entity_type",label:"نوع البيانات"},{key:"entity_id",label:"رقم السجل"},{key:"reason",label:"السبب"},{key:"before_json",label:"قبل التعديل"},{key:"after_json",label:"بعد التعديل"}]},
  { key: "users", label: "المستخدمون والصلاحيات", description: "حسابات المستخدمين والأدوار والحالة.", fields: [
    {key:"display_name",label:"اسم الموظف"},{key:"role_codes_json",label:"الأدوار"},{key:"permissions_json",label:"الصلاحيات"},{key:"is_active",label:"الحساب نشط"},{key:"last_authenticated_at",label:"آخر تسجيل دخول"}]},
];

const defaultFields: Record<ReportKey, string[]> = {
  visits:["visit_number","child_name","guardian_name","phone","checked_in_at","expected_checkout","checked_out_at","duration_minutes","total_amount","status"],
  customers:["guardian_name","phone","child_name","visit_count","last_visit"],
  payments:["created_at","visit_number","guardian_name","method","amount","status","received_by"],
  shifts:["opened_at","closed_at","opened_by","closed_by","expected_cash","counted_cash","variance"],
  audit:["created_at","actor","action","entity_type","entity_id"],
  users:["display_name","role_codes_json","is_active","last_authenticated_at"],
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
  return new Blob([...locals,central,end],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
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

export default function ReportsCenter({ db, language }: { db: Database | null; language: "ar" | "en" }) {
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
  const current = reports.find(r => r.key === reportKey)!;

  useEffect(() => {
    setSelectedFields(defaultFields[reportKey]);
    setRows([]);
    setLoaded(false);
    setError("");
  }, [reportKey]);

  async function runReport() {
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
          p.overtime_amount_minor / 100.0 AS overtime_amount, p.final_amount_minor / 100.0 AS total_amount, v.status
          FROM local_visits v JOIN local_visit_children vc ON vc.visit_id=v.id
          JOIN local_visit_child_pricing p ON p.visit_child_id=vc.id
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
          v.guardian_name_snapshot AS guardian_name, v.guardian_phone_snapshot AS phone, p.method,
          p.amount_minor/100.0 AS amount, p.status, p.received_by, p.external_reference
          FROM local_payments p LEFT JOIN local_visits v ON v.id=p.visit_id
          WHERE (?='' OR date(p.created_at)>=date(?)) AND (?='' OR date(p.created_at)<=date(?))
          ORDER BY p.created_at DESC`, [startDate,startDate,endDate,endDate]);
      } else if (reportKey === "shifts") {
        result = await db.select<ReportRow[]>(`SELECT opened_at, closed_at, opened_by, closed_by,
          opening_float_minor/100.0 AS opening_float, expected_cash_minor/100.0 AS expected_cash,
          counted_cash_minor/100.0 AS counted_cash, variance_minor/100.0 AS variance
          FROM local_cash_sessions WHERE (?='' OR date(opened_at)>=date(?)) AND (?='' OR date(opened_at)<=date(?))
          ORDER BY opened_at DESC`, [startDate,startDate,endDate,endDate]);
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
      if (sortBy === "amount_desc") result.sort((a,b) => Number(b.total_amount ?? b.amount ?? 0)-Number(a.total_amount ?? a.amount ?? 0));
      if (sortBy === "amount_asc") result.sort((a,b) => Number(a.total_amount ?? a.amount ?? 0)-Number(b.total_amount ?? b.amount ?? 0));
      if (groupBy !== "none") result.sort((a,b) => String(a[groupBy] ?? "").localeCompare(String(b[groupBy] ?? ""), "ar"));
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
    const data = [columns.map(f => csvCell(f.label)).join(","), ...rows.map(row => columns.map(f => csvCell(row[f.key])).join(","))].join("\r\n");
    const blob = new Blob(["\uFEFF", data], {type:"text/csv;charset=utf-8;"});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href=url; anchor.download=`secret-kids-club-${reportKey}-${new Date().toISOString().slice(0,10)}.csv`;
    anchor.click(); URL.revokeObjectURL(url);
  }
  function exportXlsx() {
    if (!loaded) { setError("اعرض التقرير أولًا قبل التصدير."); return; }
    const columns = current.fields.filter(f => selectedFields.includes(f.key));
    const values = rows.map(row => columns.map(field => row[field.key] ?? ""));
    const blob = makeXlsx(columns.map(field=>field.label), values);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href=url; anchor.download=`secret-kids-club-${reportKey}-${new Date().toISOString().slice(0,10)}.xlsx`;
    anchor.click(); window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function exportPdf() {
    if (!loaded) { setError("اعرض التقرير أولًا قبل التصدير."); return; }
    window.print();
  }

  const display = (key: string, value: unknown) => {
    if (key.endsWith("_at") || key === "last_visit" || key === "expected_checkout") return dateValue(value == null ? "" : String(value));
    if (key === "is_active") return Number(value) === 1 ? "نشط" : "متوقف";
    if (["base_amount","discount_amount","overtime_amount","total_amount","amount","opening_float","expected_cash","counted_cash","variance"].includes(key) && value !== null && value !== undefined) return Number(value).toLocaleString("ar-EG",{style:"currency",currency:"EGP"});
    if (key === "method" || key === "payment_method") return ({cash:"كاش",instapay:"إنستاباي",wallet:"محفظة إلكترونية"} as Record<string,string>)[String(value)] ?? String(value ?? "");
    if (key === "status") return ({active:"نشطة",completed:"مكتملة",cancelled:"ملغاة",confirmed:"تم التحصيل",pending:"معلقة",failed:"فشلت",refunded:"مستردة"} as Record<string,string>)[String(value)] ?? String(value ?? "");
    return String(value ?? "—");
  };

  return <section className="panel report-center" dir={language==="ar"?"rtl":"ltr"}>
    <div className="panel-title"><div><span className="step">05</span><h3>مركز التقارير والتصدير</h3></div><span className="muted">تقارير قابلة للتخصيص</span></div>
    <p className="muted intro">اختار نوع التقرير والفترة والأعمدة والفلاتر، واعرض معاينة قبل التصدير. التقارير تعرض البيانات المحفوظة فعليًا فقط.</p>
    <div className="report-controls">
      <label>نوع التقرير<select value={reportKey} onChange={e=>setReportKey(e.target.value as ReportKey)}>{reports.map(r=><option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
      <label>من تاريخ<input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)}/></label>
      <label>إلى تاريخ<input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)}/></label>
      <label>بحث داخل النتائج<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="اسم، تليفون، أو كلمة..."/></label>
      <label>تجميع حسب<select value={groupBy} onChange={e=>setGroupBy(e.target.value)}><option value="none">بدون تجميع</option><option value="guardian_name">ولي الأمر</option><option value="child_name">الطفل</option><option value="method">طريقة الدفع</option><option value="status">الحالة</option><option value="actor">المستخدم</option></select></label>
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
