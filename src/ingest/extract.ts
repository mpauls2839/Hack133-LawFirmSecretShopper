/**
 * Deterministic extraction. Everything here comes from the markup, never from a model:
 * tel:/mailto: hrefs, form action + inputs, captcha scripts, chat widget vendor, hours text.
 * The model is only asked for the fuzzy part (services + category) in ingest/services.ts.
 */
import * as cheerio from 'cheerio';
import type { FormProfile, LineType } from '../domain/types.ts';

export type ExtractedContact = {
  name: string | null;
  phones: string[];
  emails: string[];
  form: FormProfile | null;
  chat_widget: string | null;
  stated_hours_text: string | null;
  /**
   * The 24/7 marketing claim, tracked separately from published hours. A firm that
   * advertises "available 24/7" and also lists 9-5 is graded against the claim, and the
   * contradiction is itself worth reporting.
   */
  claims_247_text: string | null;
  city: string | null;
  text: string;
};

const ALWAYS_OPEN_CLAIM =
  /(?:open|available|answering|answered|here for you|reach us)?\s*(?:24\s*\/\s*7(?:\s*\/\s*365)?|24\s*hours\s*a\s*day(?:,?\s*7\s*days\s*a\s*week)?|24\s*hours,?\s*7\s*days|open\s*24\s*hours|around the clock|day or night)/i;

const CAPTCHA_VENDORS: Array<[RegExp, string]> = [
  [/recaptcha/i, 'recaptcha'],
  [/hcaptcha/i, 'hcaptcha'],
  [/challenges\.cloudflare\.com|cf-turnstile|turnstile/i, 'turnstile'],
  [/funcaptcha|arkoselabs/i, 'arkose'],
];

const CHAT_VENDORS: Array<[RegExp, string]> = [
  [/intercom/i, 'intercom'],
  [/drift\.com|driftt/i, 'drift'],
  [/tawk\.to/i, 'tawk'],
  [/livechatinc|livechat\.com/i, 'livechat'],
  [/zdassets|zopim|zendesk/i, 'zendesk'],
  [/hs-scripts|hubspot/i, 'hubspot'],
  [/tidio/i, 'tidio'],
  [/olark/i, 'olark'],
  [/podium\.com/i, 'podium'],
  [/birdeye/i, 'birdeye'],
  [/apexchat|ngagelive|ngage/i, 'apexchat'],
  [/smith\.ai/i, 'smith.ai'],
  [/gohighlevel|leadconnector|msgsndr/i, 'gohighlevel'],
];

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  const only = digits.replace(/\D/g, '');
  if (only.length === 11 && only.startsWith('1')) return `+${only}`;
  if (only.length === 10) return `+1${only}`;
  if (digits.startsWith('+') && only.length >= 8) return `+${only}`;
  return null;
}

const BAD_EMAIL = /(example|sentry|wixpress|\.png$|\.jpg$|@sentry|noreply@w3)/i;

export function extractContact(html: string, pageUrl: string): ExtractedContact {
  const $ = cheerio.load(html);
  $('script,style,noscript').each((_, el) => {
    // keep src attributes for vendor detection but drop inline bodies from the text pass
    if (!$(el).attr('src')) $(el).text('');
  });

  const text = $('body').text().replace(/\s+/g, ' ').trim();

  const phones = new Set<string>();
  $('a[href^="tel:"]').each((_, el) => {
    const normalized = normalizePhone(($(el).attr('href') ?? '').replace(/^tel:/i, ''));
    if (normalized) phones.add(normalized);
  });
  // Visible numbers as a fallback when tel: hrefs are absent.
  if (phones.size === 0) {
    for (const m of text.matchAll(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g)) {
      const normalized = normalizePhone(m[0]);
      if (normalized) phones.add(normalized);
    }
  }

  const emails = new Set<string>();
  $('a[href^="mailto:"]').each((_, el) => {
    const addr = ($(el).attr('href') ?? '').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (addr.includes('@') && !BAD_EMAIL.test(addr)) emails.add(addr);
  });
  if (emails.size === 0) {
    for (const m of html.matchAll(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g)) {
      const addr = m[0].toLowerCase();
      if (!BAD_EMAIL.test(addr)) emails.add(addr);
    }
  }

  const rawHtml = html;
  const captchaVendor = CAPTCHA_VENDORS.find(([re]) => re.test(rawHtml))?.[1] ?? null;
  const chatWidget = CHAT_VENDORS.find(([re]) => re.test(rawHtml))?.[1] ?? null;

  let form: FormProfile | null = null;
  $('form').each((_, el) => {
    if (form) return;
    const $form = $(el);
    const fields = new Set<string>();
    $form.find('input,textarea,select').each((__, input) => {
      const name = $(input).attr('name') ?? $(input).attr('id');
      const type = ($(input).attr('type') ?? '').toLowerCase();
      if (name && !['hidden', 'submit', 'button'].includes(type)) fields.add(name);
    });
    // Search boxes and newsletter signups are not intake forms.
    const joined = [...fields].join(' ').toLowerCase();
    const looksIntake =
      fields.size >= 2 && /(name|email|phone|message|comment|describe|matter|case)/.test(joined);
    if (!looksIntake) return;
    let action = $form.attr('action') ?? pageUrl;
    try {
      action = new URL(action, pageUrl).href;
    } catch {
      action = pageUrl;
    }
    form = {
      url: action,
      fields: [...fields],
      captcha: !!captchaVendor,
      captcha_vendor: captchaVendor,
    };
  });

  const name =
    $('meta[property="og:site_name"]').attr('content')?.trim() ||
    $('title').first().text().split(/[|–—-]/)[0].trim() ||
    null;

  // Published hours: a day/time range, not a "24 hours a day" slogan.
  const hoursMatch =
    text.match(
      /(?:hours?|open)\b[^.]{0,120}?\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|—|to|until|till)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?/i,
    )?.[0] ?? null;

  const cityMatch = text.match(/([A-Z][A-Za-z.'-]+(?:\s[A-Z][A-Za-z.'-]+)?),\s*([A-Z]{2})\s+\d{5}/);

  return {
    name,
    phones: [...phones],
    emails: [...emails],
    form,
    chat_widget: chatWidget,
    stated_hours_text: hoursMatch?.trim() ?? null,
    claims_247_text: text.match(ALWAYS_OPEN_CLAIM)?.[0]?.trim() ?? null,
    city: cityMatch ? `${cityMatch[1]}, ${cityMatch[2]}` : null,
    text,
  };
}

export function mergeContacts(pages: ExtractedContact[]): ExtractedContact {
  const merged: ExtractedContact = {
    name: null,
    phones: [],
    emails: [],
    form: null,
    chat_widget: null,
    stated_hours_text: null,
    claims_247_text: null,
    city: null,
    text: '',
  };
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const page of pages) {
    merged.name ??= page.name;
    merged.form ??= page.form;
    merged.chat_widget ??= page.chat_widget;
    merged.stated_hours_text ??= page.stated_hours_text;
    merged.claims_247_text ??= page.claims_247_text;
    merged.city ??= page.city;
    for (const phone of page.phones) phones.add(phone);
    for (const email of page.emails) emails.add(email);
    merged.text += (merged.text ? '\n' : '') + page.text;
  }
  merged.phones = [...phones];
  merged.emails = [...emails];
  return merged;
}

/**
 * Line-type guess used only when no lookup provider is wired. Toll-free numbers eat SMS
 * far more often than they accept it, so they are the one prefix worth pessimism about.
 */
export function guessLineType(number: string): { line_type: LineType; sms_capable: boolean | null } {
  const digits = number.replace(/\D/g, '');
  const areaCode = digits.length === 11 ? digits.slice(1, 4) : digits.slice(0, 3);
  const tollFree = ['800', '833', '844', '855', '866', '877', '888'];
  if (tollFree.includes(areaCode)) return { line_type: 'voip', sms_capable: null };
  return { line_type: 'unknown', sms_capable: null };
}
