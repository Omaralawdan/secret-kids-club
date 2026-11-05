import { useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
export type Booking={id:string;type:string;guardianName:string;phone:string;scheduledAt:string;durationMinutes:number;childCount:number;guestCount:number;status:string;notes:string|null;createdBy:string;createdAt:string};
const dateTimeLocal=()=>{const d=new Date();d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16)};
export default function BookingsCenter({onUseBooking}:{onUseBooking:(booking:Booking)=>void}){
 const [rows,setRows]=useState<Booking[]>([]),[type,setType]=useState("visit"),[guardian,setGuardian]=useState(""),[phone,setPhone]=useState(""),[scheduled,setScheduled]=useState(dateTimeLocal()),[duration,setDuration]=useState("60"),[children,setChildren]=useState("1"),[guests,setGuests]=useState("0"),[notes,setNotes]=useState(""),[error,setError]=useState(""),[message,setMessage]=useState("");
 async function refresh(){try{setError("");setRows(await invoke<Booking[]>("list_bookings"))}catch(e){setError(String(e))}}
 useEffect(()=>{void refresh()},[]);
 async function save(e:FormEvent){e.preventDefault();setError("");setMessage("");try{await invoke("save_booking",{bookingType:type,guardianName:guardian,guardianPhone:phone,scheduledAt:new Date(scheduled).toISOString(),durationMinutes:Number(duration),childCount:Number(children),guestCount:Number(guests),notes});setGuardian("");setPhone("");setNotes("");setMessage(type==="birthday"?"تم تسجيل حجز حفلة عيد الميلاد.":"تم تسجيل الحجز.");await refresh()}catch(e){setError(String(e))}}
 async function changeStatus(b:Booking,status:string){const reason=status==="cancelled"?(window.prompt("سبب إلغاء الحجز:")||""):"";if(status==="cancelled"&&!reason.trim())return;try{await invoke("update_booking_status",{bookingId:b.id,status,reason});setMessage("تم تحديث حالة الحجز.");await refresh()}catch(e){setError(String(e))}}
 return <section className="panel" dir="rtl">
  <div className="panel-title"><div><span className="step">08</span><h3>الحجوزات وحفلات أعياد الميلاد</h3></div><button type="button" className="secondary-button" onClick={()=>void refresh()}>تحديث</button></div>
  {error&&<div className="notice error">{error}</div>}{message&&<div className="notice success">{message}</div>}
  <section className="report-field-panel"><h3>تسجيل حجز جديد</h3><form className="report-controls" onSubmit={e=>void save(e)}>
   <label>نوع الحجز<select value={type} onChange={e=>{setType(e.target.value);if(e.target.value==="visit")setGuests("0")}}><option value="visit">زيارة عادية</option><option value="birthday">حفلة عيد ميلاد</option></select></label>
   <label>اسم المرافق<input value={guardian} onChange={e=>setGuardian(e.target.value)} required/></label><label>رقم الهاتف<input value={phone} onChange={e=>setPhone(e.target.value)} required/></label>
   <label>موعد الحجز<input type="datetime-local" value={scheduled} onChange={e=>setScheduled(e.target.value)} required/></label><label>المدة بالدقائق<input type="number" min="15" step="15" value={duration} onChange={e=>setDuration(e.target.value)} required/></label>
   <label>عدد الأطفال<input type="number" min="1" step="1" value={children} onChange={e=>setChildren(e.target.value)} required/></label>
   {type==="birthday"&&<label>عدد المدعوين<input type="number" min="1" step="1" value={guests} onChange={e=>setGuests(e.target.value)} required/></label>}
   <label>ملاحظات وتفاصيل الحجز<input value={notes} onChange={e=>setNotes(e.target.value)} placeholder={type==="birthday"?"الثيم، الكيك، التجهيزات المطلوبة":"ملاحظات إضافية"}/></label>
   <button className="primary-button">حفظ الحجز</button>
  </form></section>
  <section className="report-field-panel"><h3>قائمة الحجوزات</h3><div className="report-table-wrap"><table className="report-table"><thead><tr><th>النوع</th><th>المرافق</th><th>الهاتف</th><th>الموعد</th><th>المدة</th><th>الأطفال / المدعوون</th><th>الحالة</th><th>ملاحظات</th><th>إجراءات</th></tr></thead><tbody>{rows.map(b=><tr key={b.id}><td>{b.type==="birthday"?"عيد ميلاد":"زيارة"}</td><td>{b.guardianName}</td><td>{b.phone}</td><td>{new Date(b.scheduledAt).toLocaleString("ar-EG")}</td><td>{b.durationMinutes} دقيقة</td><td>{b.childCount} / {b.guestCount}</td><td>{({booked:"محجوز",confirmed:"مؤكد",completed:"مكتمل",cancelled:"ملغي"} as Record<string,string>)[b.status]||b.status}</td><td>{b.notes||"—"}</td><td>{(b.status==="booked"||b.status==="confirmed")&&<><button className="primary-button" onClick={()=>onUseBooking(b)}>استخدام الحجز للدخول</button><button className="secondary-button" onClick={()=>void changeStatus(b,"confirmed")}>تأكيد</button><button className="remove-button" onClick={()=>void changeStatus(b,"cancelled")}>إلغاء</button></>}</td></tr>)}{rows.length===0&&<tr><td colSpan={9}>لا توجد حجوزات مسجلة.</td></tr>}</tbody></table></div></section>
 </section>;
}
