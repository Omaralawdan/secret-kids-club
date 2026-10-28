import { useEffect, useState } from "react";

export type Language = "en" | "ar";

const translations: Record<Language, Record<string, string>> = {
  en: {},
  ar: {
    "Point of Sale · Local System": "نقطة البيع · نظام محلي",
    "Connecting": "جارٍ الاتصال",
    "Connected": "متصل",
    "Unavailable": "غير متاح",
    "Reception": "الاستقبال",
    "Pricing setup": "إعداد الأسعار",
    "Settings": "الإعدادات",
    "CASHIER WORKSPACE": "واجهة الكاشير",
    "New visit": "زيارة جديدة",
    "Pricing rules": "قواعد التسعير",
    "Register a guardian and each child, then review their individual pricing.": "سجّل بيانات ولي الأمر وكل طفل، ثم راجع سعر كل طفل.",
    "Configure the prices available to cashiers. No prices are preloaded.": "أضف الأسعار الفعلية التي سيستخدمها الكاشير. لا توجد أسعار مضافة مسبقًا.",
    "Choose the language used throughout the application.": "اختر اللغة المستخدمة في جميع أجزاء البرنامج.",
    "Language": "اللغة",
    "English": "الإنجليزية",
    "Arabic": "العربية",
    "Local database": "قاعدة البيانات المحلية",
    "The screens are available, but saving requires the app database connection.": "الشاشات متاحة، لكن حفظ البيانات يتطلب الاتصال بقاعدة بيانات التطبيق.",
    "Connecting to SQLite…": "جارٍ الاتصال بقاعدة بيانات SQLite…",
    "The database is unavailable.": "قاعدة البيانات غير متاحة.",
    "Guardian information": "بيانات ولي الأمر",
    "Required": "مطلوب",
    "Guardian full name": "اسم ولي الأمر بالكامل",
    "Full name": "الاسم بالكامل",
    "Relationship": "صلة القرابة",
    "Mother": "الأم",
    "Father": "الأب",
    "Guardian": "ولي أمر",
    "Relative": "أحد الأقارب",
    "Other": "أخرى",
    "Phone number": "رقم الهاتف",
    "Guardian phone": "رقم هاتف ولي الأمر",
    "Children and pricing": "الأطفال والأسعار",
    "child": "طفل",
    "children": "أطفال",
    "No pricing rules configured yet.": "لم يتم إعداد أي أسعار حتى الآن.",
    "Open Pricing setup and add your actual prices before registering a visit.": "افتح إعداد الأسعار وأضف الأسعار الفعلية قبل تسجيل الزيارة.",
    "Set up pricing": "إعداد الأسعار",
    "Child name": "اسم الطفل",
    "Child's name": "اسم الطفل",
    "Pricing rule": "قاعدة التسعير",
    "Select price": "اختر السعر",
    "Price estimate": "السعر التقديري",
    "Remove child": "حذف الطفل",
    "Add another child": "إضافة طفل آخر",
    "Initial visit total": "إجمالي الزيارة المبدئي",
    "Before discounts · Hourly prices start with a one-hour estimate": "قبل الخصومات · يُحسب السعر بالساعة مبدئيًا على أساس ساعة واحدة",
    "Saving visit…": "جارٍ حفظ الزيارة…",
    "Confirm check-in": "تأكيد تسجيل الدخول",
    "Add a pricing rule": "إضافة قاعدة تسعير",
    "Enter the real price used by your club. Prices are stored in EGP.": "أدخل السعر الفعلي المستخدم في النادي. تُحفظ الأسعار بالجنيه المصري.",
    "Rule name": "اسم قاعدة التسعير",
    "e.g. Standard entry": "مثال: دخول عادي",
    "Pricing type": "نوع التسعير",
    "Fixed price": "سعر ثابت",
    "Hourly (first-hour estimate)": "بالساعة (تقدير الساعة الأولى)",
    "Offer (fixed price)": "عرض (سعر ثابت)",
    "Price in EGP": "السعر بالجنيه المصري",
    "Enter actual price": "أدخل السعر الفعلي",
    "Save pricing rule": "حفظ قاعدة التسعير",
    "Active pricing rules": "قواعد التسعير المفعّلة",
    "No rules configured.": "لا توجد قواعد تسعير.",
    "fixed": "سعر ثابت",
    "hourly": "بالساعة",
    "offer": "عرض",
    "Pricing rule saved.": "تم حفظ قاعدة التسعير.",
    "Enter a rule name and a valid non-negative price.": "أدخل اسم قاعدة التسعير وسعرًا صحيحًا لا يقل عن صفر.",
    "Enter the guardian's name and phone number.": "أدخل اسم ولي الأمر ورقم هاتفه.",
    "Enter each child's name and select a pricing rule for every child.": "أدخل اسم كل طفل واختر قاعدة تسعير لكل طفل.",
    "A selected pricing rule is no longer available. Refresh and try again.": "قاعدة التسعير المختارة لم تعد متاحة. حدّث البيانات وحاول مرة أخرى.",
    "Pricing rule not found.": "لم يتم العثور على قاعدة التسعير.",
    "Visit": "الزيارة",
    "Visit saved": "تم حفظ الزيارة",
    "Initial total": "الإجمالي المبدئي",
    "Could not save the visit:": "تعذّر حفظ الزيارة:",
    "saved visit": "زيارة محفوظة",
    "saved visits": "زيارات محفوظة",
    "Local SQLite": "قاعدة بيانات SQLite محلية",
    "Remove child number": "حذف الطفل رقم",
    "Database operation failed": "تعذّرت عملية قاعدة البيانات",
    "Standard entry": "دخول عادي",
    "Saving visit": "جارٍ حفظ الزيارة",
  },
};

export function t(language: Language, key: string): string {
  return translations[language][key] ?? key;
}

export function useLanguage() {
  const [language, setLanguage] = useState<Language>(() => {
    try {
      return localStorage.getItem("skc-language") === "ar" ? "ar" : "en";
    } catch {
      return "en";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("skc-language", language);
    } catch {
      // Language selection still works for the current session.
    }

    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  }, [language]);

  return { language, setLanguage };
}
