/**
 * Small, explicit Urdu / Roman-Urdu vocabulary for the CRM assistant.
 *
 * Ported in behaviour from the reference assistant (crm_assistant_language.py):
 * no model is involved, a fixed list of words maps onto the English intents the
 * query engine understands, so "aaj ki wasooli kitni hui" asks the same thing
 * as "collections today". Bounded on purpose: what it cannot map it leaves for
 * the help search rather than guessing.
 */
export type Lang = 'en' | 'ur' | 'roman';

const ROMAN_HINTS =
  /\b(kitni|kitna|kitne|aaj|aj|ajj|kal|hoi|hui|hua|ha|hai|hain|batao|dikhao|baki|baqi|mahine|mahinay|pichlay|pichle)\b/;

export function detectLanguage(text: string): Lang {
  if (/[؀-ۿ]/.test(text)) return 'ur';
  if (ROMAN_HINTS.test(text.toLowerCase())) return 'roman';
  return 'en';
}

const MAPPINGS: Array<[RegExp, string]> = [
  [/\b(aaj|aj|ajj)\b|آج/, 'today'],
  [/\bkal\b|گزشتہ روز|(?<![\p{L}\p{N}])کل(?![\p{L}\p{N}])/u, 'yesterday'],
  [/\b(is|iss) (mahine|mahinay|maheene)\b|اس ماہ|اس مہینے/, 'this month'],
  [/\b(pichle|pichlay) (mahine|mahinay)\b|پچھلے ماہ|پچھلے مہینے/, 'last month'],
  [/\b(sali|sale|sales|sail|farokht)\b|فروخت|سیل/, 'sales'],
  [/\b(wasooli|wasuli|wusooli|collection|jama)\b|وصولی|وصولیاں|کلیکشن/, 'collections'],
  [/\b(adaigi|paisa|paise)\b|ادائیگی|پیسے/, 'payments'],
  [/\b(baki|baqi|baqaya|bakaya|udhar)\b|بقایا|باقی/, 'customer balance'],
  [/\b(sarif|gahak)\b|صارف|گاہک/, 'customers'],
  [/انوائس|ماہانہ بل/, 'invoices'],
  [/\b(shikayat|shikayaat)\b|شکایت|ٹکٹ/, 'tickets'],
  [/\b(kam stock)\b|کم اسٹاک|کم سٹاک/, 'low stock'],
  [/اسٹاک|سٹاک|سامان/, 'inventory'],
  [/\b(band account)\b|میعاد ختم|ایکسپائر/, 'expired customers'],
  [/\b(mulazim|mulaazim|amla)\b|ملازم|عملہ/, 'staff'],
  [/\b(kharcha|kharche|akhrajat)\b|اخراجات|خرچہ/, 'expenses'],
  [/\b(tankhwa|tankhwah)\b|تنخواہ/, 'salary'],
  [/پاس ورڈ|خفیہ/, 'password'],
];

/** Lower-case the question and append the English intents it contains. */
export function normalize(text: string): string {
  const q = String(text || '').toLowerCase();
  const terms: string[] = [];
  for (const [pattern, intent] of MAPPINGS) if (pattern.test(q)) terms.push(intent);
  return terms.length ? `${q} ${terms.join(' ')}` : q;
}

const SECTION_NAMES: Record<string, [string, string]> = {
  Sales: ['فروخت', 'Sale'],
  Collections: ['وصولیاں', 'Wasooliyan'],
  Customers: ['صارفین', 'Customers'],
  Invoices: ['انوائس', 'Invoices'],
  Tickets: ['ٹکٹ', 'Tickets'],
  Inventory: ['اسٹاک', 'Stock'],
  Expenses: ['اخراجات', 'Akhrajat'],
};

/** Section title in the asker's language. */
export function sectionTitle(section: string, lang: Lang): string {
  if (lang === 'en') return section;
  const pair = SECTION_NAMES[section];
  return pair ? pair[lang === 'ur' ? 0 : 1] : section;
}

export const PHRASES: Record<string, Record<Lang, string>> = {
  period: { en: 'Period', ur: 'تاریخ', roman: 'Tareekh' },
  records: { en: 'records', ur: 'ریکارڈ', roman: 'records' },
  none: { en: 'No matching records.', ur: 'کوئی متعلقہ ریکارڈ نہیں ملا۔', roman: 'Koi mutaliqa record nahi mila.' },
  scoped: {
    en: 'Only records your account may see are included.',
    ur: 'صرف آپ کی اجازت والے ریکارڈ دکھائے گئے ہیں۔',
    roman: 'Sirf aap ki ijazat walay records dikhaye gaye hain.',
  },
  refused: {
    en: 'Your role does not have access to this information.',
    ur: 'یہ معلومات آپ کی اجازت کے مطابق فراہم نہیں کی جا سکتیں۔',
    roman: 'Yeh maloomat aap ki ijazat ke mutabiq nahi mil sakti.',
  },
  protected: {
    en: 'The assistant does not retrieve passwords, API secrets, identity documents, bank details or salaries. Use the authorised screen for those.',
    ur: 'اسسٹنٹ پاس ورڈ، خفیہ کلید، شناختی دستاویزات، بینک تفصیلات یا تنخواہیں فراہم نہیں کرتا۔',
    roman: 'Assistant password, secret keys, shanakhti documents, bank details ya tankhwah nahi dikhata.',
  },
};
