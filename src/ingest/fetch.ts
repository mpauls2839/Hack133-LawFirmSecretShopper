/** Two pages only, no crawler (spec 4.1). Supports file:// so fixtures run offline. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

export type FetchedPage = { url: string; html: string; ok: boolean; error?: string };

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) intake-grader/0.1';

export async function fetchPage(url: string, timeoutMs = 15_000): Promise<FetchedPage> {
  if (url.startsWith('file://')) {
    try {
      return { url, html: await readFile(fileURLToPath(url), 'utf8'), ok: true };
    } catch (err) {
      return { url, html: '', ok: false, error: (err as Error).message };
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const html = await res.text();
    return { url: res.url || url, html, ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { url, html: '', ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

const CONTACT_HINT = /contact|get.?in.?touch|reach.?us|free.?consult|case.?evaluation|talk.?to|schedule/i;

/** Nav link most likely to be the contact page. Absolute URL, same host only. */
export function findContactUrl(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  const candidates: Array<{ href: string; score: number }> = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    const text = ($(el).text() ?? '').trim();
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      return;
    }
    if (abs.hostname !== base.hostname && base.protocol !== 'file:') return;
    if (abs.href.replace(/\/$/, '') === base.href.replace(/\/$/, '')) return;
    let score = 0;
    if (CONTACT_HINT.test(abs.pathname)) score += 3;
    if (CONTACT_HINT.test(text)) score += 2;
    if (/^\/?contact(-us)?\/?$/i.test(abs.pathname)) score += 3;
    if (score > 0) candidates.push({ href: abs.href, score });
  });
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.href ?? null;
}

/** Homepage + the one page its nav calls contact. Nothing deeper. */
export async function fetchTargetPages(url: string): Promise<{ home: FetchedPage; contact: FetchedPage | null }> {
  const home = await fetchPage(url);
  if (!home.ok || !home.html) return { home, contact: null };
  const contactUrl = findContactUrl(home.html, home.url);
  if (!contactUrl) return { home, contact: null };
  const contact = await fetchPage(contactUrl);
  return { home, contact: contact.ok ? contact : null };
}
