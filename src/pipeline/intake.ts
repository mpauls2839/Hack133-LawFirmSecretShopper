/**
 * Pasted URL -> contact profile with a reachability verdict (spec 4.1 + 4.2).
 * Two pages, deterministic extraction, one model call for services only.
 */
import { fetchPage, fetchTargetPages, type FetchedPage } from '../ingest/fetch.ts';
import { extractContact, mergeContacts, guessLineType, type ExtractedContact } from '../ingest/extract.ts';
import { extractServices } from '../ingest/services.ts';
import { assessReachability, annotateLineTypes, type Reachability } from '../ingest/capability.ts';
import { parseHours, guessTimezone, alwaysOpenWindows } from '../domain/hours.ts';
import { targets } from '../db/repo.ts';
import { logEvent } from '../db/index.ts';
import type { Target } from '../domain/types.ts';

export type IngestOptions = {
  /** Skip contact-page discovery (fixtures, or when the nav is unhelpful). */
  contactUrl?: string | null;
  /** Fixtures have no hostname; give them a stable synthetic domain. */
  domain?: string | null;
  timezone?: string | null;
};

export type IngestResult = {
  target: Target;
  reachability: Reachability;
  pages: { home: string; contact: string | null; fetched: number };
  services_source: string;
};

function domainFor(url: string, override?: string | null): string {
  if (override) return override.toLowerCase();
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') {
      const base = parsed.pathname.split('/').pop() ?? 'fixture';
      return `${base.replace(/\.html?$/i, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase()}.fixture`;
    }
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return url.replace(/[^a-z0-9.-]/gi, '-').toLowerCase();
  }
}

export async function ingestTarget(url: string, opts: IngestOptions = {}): Promise<IngestResult> {
  let home: FetchedPage;
  let contact: FetchedPage | null;

  if (opts.contactUrl) {
    home = await fetchPage(url);
    const fetched = await fetchPage(opts.contactUrl);
    contact = fetched.ok ? fetched : null;
  } else {
    const pages = await fetchTargetPages(url);
    home = pages.home;
    contact = pages.contact;
  }

  if (!home.ok || !home.html) {
    throw new Error(`could not fetch ${url}: ${home.error ?? 'empty response'}`);
  }

  const extracted: ExtractedContact[] = [extractContact(home.html, home.url)];
  if (contact) extracted.push(extractContact(contact.html, contact.url));
  const merged = mergeContacts(extracted);

  const { category, services, source } = await extractServices(merged.text, merged.name);
  const parsed = parseHours(merged.stated_hours_text);
  const claims247 = parsed.claims_247 || !!merged.claims_247_text;
  // A 24/7 claim with no published ranges IS the schedule, so it counts as known hours.
  const hours =
    claims247 && parsed.confidence === 'none'
      ? { windows: alwaysOpenWindows(), confidence: 'high' as const, claims_247: true }
      : parsed;
  const timezone = opts.timezone ?? guessTimezone(merged.city, merged.text);

  const notes: string[] = [];
  if (claims247 && merged.stated_hours_text && !parsed.claims_247) {
    notes.push(
      `advertises ${JSON.stringify(merged.claims_247_text)} but also publishes ${JSON.stringify(merged.stated_hours_text)}; graded against the 24/7 claim`,
    );
  }
  if (hours.confidence === 'none' && merged.stated_hours_text) {
    notes.push(`could not parse stated hours: ${JSON.stringify(merged.stated_hours_text)}`);
  }
  if (hours.confidence === 'none' && !merged.stated_hours_text) {
    notes.push('no hours published; business-hours grading falls back to raw elapsed');
  }
  if (!contact) notes.push('no contact page found in nav; homepage only');
  if (merged.chat_widget) notes.push(`chat widget vendor: ${merged.chat_widget}`);

  const domain = domainFor(url, opts.domain);

  let target = targets.upsert({
    url: home.url,
    domain,
    name: merged.name,
    category,
    city: merged.city,
    timezone,
    services,
    stated_hours_text: merged.stated_hours_text,
    hours: hours.windows,
    hours_confidence: hours.confidence,
    claims_247: claims247,
    chat_widget: merged.chat_widget,
    form: merged.form,
    reachable: false, // provisional; set below once capability is assessed
    unreachable_reason: null,
    ingest_notes: notes,
    phones: merged.phones.map((number) => ({ number, ...guessLineType(number) })),
    emails: merged.emails,
  });

  target = annotateLineTypes(target);
  const reachability = assessReachability(target);
  targets.setReachability(target.id, reachability.reachable, reachability.unreachable_reason, [
    ...notes,
    ...reachability.notes,
  ]);
  target = targets.get(target.id)!;

  logEvent(null, 'target_ingested', {
    target_id: target.id,
    domain,
    reachable: reachability.reachable,
    channel: reachability.choice?.channel ?? null,
    unreachable_reason: reachability.unreachable_reason,
    services,
    claims_247: target.claims_247,
  });

  return {
    target,
    reachability,
    pages: { home: home.url, contact: contact?.url ?? null, fetched: contact ? 2 : 1 },
    services_source: source,
  };
}

/** Re-run the verdict after a carrier tells us a number cannot take SMS. */
export function reassessReachability(targetId: string): Reachability {
  const target = targets.get(targetId);
  if (!target) throw new Error(`target ${targetId} not found`);
  const reachability = assessReachability(target);
  targets.setReachability(target.id, reachability.reachable, reachability.unreachable_reason, [
    ...target.ingest_notes,
    ...reachability.notes,
  ]);
  return reachability;
}
