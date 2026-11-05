/**
 * All amounts entered by staff are Egyptian pounds (EGP), never piastres.
 * Examples: 1 => 100 minor units, 105 => 10500, 65.5 => 6550.
 * Database and Rust command payloads continue to use integer piastres.
 */
export function egpToMinor(value: string | number): number {
  const raw = String(value).trim();
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(raw);
  if (!match) throw new Error("أدخل المبلغ بالجنيه، مع منزلتين عشريتين كحد أقصى (مثال: 65.5).");
  const whole = Number(match[1]);
  const fraction = Number((match[2] || "").padEnd(2, "0"));
  const result = whole * 100 + fraction;
  if (!Number.isSafeInteger(result)) throw new Error("المبلغ أكبر من الحد المسموح.");
  return result;
}

export function tryEgpToMinor(value: string): number | null {
  if (value.trim() === "") return null;
  try { return egpToMinor(value); } catch { return null; }
}

export function minorToEgp(value: number): string {
  return (value / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}
