/**
 * GoHighLevel probe. Answers the section 2 questions that the missing openclaw_identity
 * template pushed onto GHL:
 *
 *   1. What number does the mock sub-account actually own?
 *   2. Can we send one SMS from it?
 *   3. Does the inbound reply show up in polling, with a stable id to dedupe on?
 *   4. Which `Version` header each endpoint group wants (they differ, per spec 12).
 *
 * Read-only by default. Nothing is sent unless --send is passed explicitly.
 *
 *   node --env-file=.env scripts/probe-ghl.ts
 *   node --env-file=.env scripts/probe-ghl.ts --ensure-contact +15551234567
 *   node --env-file=.env scripts/probe-ghl.ts --send --to +15551234567 --body "hi"
 *   node --env-file=.env scripts/probe-ghl.ts --watch 120
 */

// Trailing whitespace in a .env value silently corrupts an Authorization header. Trim.
const env = (key: string, dflt = ''): string => (process.env[key] ?? dflt).trim();

const PIT = env('GHL_PIT');
const BASE = env('GHL_API_BASE', 'https://services.leadconnectorhq.com').replace(/\/$/, '');
const LOCATION = env('GHL_LOCATION_ID');
const CONTACT_ID = env('GHL_TEST_CONTACT_ID');

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

// Contacts and Conversations sit on different API versions. Probe, do not assume.
const VERSIONS = ['2021-07-28', '2021-04-15'];

type Attempt = { status: number; version: string; body: any };

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; versions?: string[] } = {},
): Promise<Attempt> {
  let last: Attempt = { status: 0, version: '', body: null };
  for (const version of opts.versions ?? VERSIONS) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${PIT}`,
        Version: version,
        accept: 'application/json',
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* leave as text */
    }
    last = { status: res.status, version, body: parsed };
    if (res.ok) return last;
    // A version mismatch is a 4xx worth retrying; a 401 never is.
    if (res.status === 401 || res.status === 403) return last;
  }
  return last;
}

const show = (label: string, a: Attempt): void => {
  const body = typeof a.body === 'string' ? a.body.slice(0, 300) : JSON.stringify(a.body).slice(0, 700);
  console.log(`\n[${a.status}] ${label}  (Version: ${a.version})\n  ${body}`);
};

function requireEnv(): void {
  const missing: string[] = [];
  if (!PIT) missing.push('GHL_PIT');
  if (!LOCATION) missing.push('GHL_LOCATION_ID');
  if (missing.length) {
    console.error(`missing env: ${missing.join(', ')} — fill them in .env and re-run`);
    process.exit(4);
  }
}

async function probeLocation(): Promise<any> {
  const res = await call('GET', `/locations/${LOCATION}`);
  show(`GET /locations/${LOCATION}`, res);
  const loc = res.body?.location ?? res.body;
  if (res.status === 200) {
    console.log('\n  name:     ', loc?.name);
    console.log('  phone:    ', loc?.phone ?? '(none on the location record)');
    console.log('  timezone: ', loc?.timezone);
    console.log('  country:  ', loc?.country);
  }
  return loc;
}

/** Which numbers this sub-account can actually send from. */
async function probeNumbers(): Promise<void> {
  for (const path of [
    `/phone-system/number-pools/?locationId=${LOCATION}`,
    `/locations/${LOCATION}/numbers`,
    `/phone-system/numbers/?locationId=${LOCATION}`,
  ]) {
    const res = await call('GET', path);
    show(`GET ${path}`, res);
    if (res.status === 200) return;
  }
  console.log('\n  No numbers endpoint answered. The sending number is whatever Twilio number');
  console.log('  the sub-account has attached; check Settings > Phone Numbers in the UI.');
}

async function probeContact(): Promise<any> {
  if (!CONTACT_ID) {
    console.log('\n  GHL_TEST_CONTACT_ID not set, skipping contact read.');
    return null;
  }
  const res = await call('GET', `/contacts/${CONTACT_ID}`);
  show(`GET /contacts/${CONTACT_ID}`, res);
  const contact = res.body?.contact ?? res.body;
  if (res.status === 200) {
    console.log('\n  contact:  ', contact?.firstName, contact?.lastName);
    console.log('  phone:    ', contact?.phone ?? '(no phone on contact — SMS will fail)');
    console.log('  email:    ', contact?.email ?? '(none)');
  }
  return contact;
}

/**
 * Point a contact at a phone you own. Creates a new contact by default rather than
 * rewriting an existing CRM record; --overwrite-contact opts into mutating GHL_TEST_CONTACT_ID.
 */
async function ensureContact(phone: string): Promise<string | null> {
  if (CONTACT_ID && flag('overwrite-contact')) {
    const res = await call('PUT', `/contacts/${CONTACT_ID}`, { body: { phone } });
    show(`PUT /contacts/${CONTACT_ID} (set phone ${phone})`, res);
    if (res.status === 200) return CONTACT_ID;
  }
  const res = await call('POST', '/contacts/', {
    body: {
      locationId: LOCATION,
      firstName: 'Intake',
      lastName: 'Grader Probe',
      phone,
      source: 'intake-grader probe',
    },
  });
  show(`POST /contacts/ (create with ${phone})`, res);
  return res.body?.contact?.id ?? res.body?.id ?? null;
}

async function sendSms(contactId: string, body: string): Promise<void> {
  console.log(`\n>>> SENDING SMS to contact ${contactId}: ${JSON.stringify(body)}`);
  const res = await call('POST', '/conversations/messages', {
    body: { type: 'SMS', contactId, message: body },
    versions: ['2021-04-15', '2021-07-28'],
  });
  show('POST /conversations/messages', res);
  if (res.status >= 200 && res.status < 300) {
    console.log('\n  messageId:      ', res.body?.messageId ?? res.body?.msg ?? '(none returned)');
    console.log('  conversationId: ', res.body?.conversationId ?? '(none returned)');
  }
}

async function pollInbound(seconds: number): Promise<void> {
  console.log(`\n=== polling /conversations for ${seconds}s (dedupe key = message id) ===`);
  const seen = new Set<string>();
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const search = await call(
      'GET',
      `/conversations/search?locationId=${LOCATION}&limit=5&sortBy=last_message_date&sort=desc`,
      { versions: ['2021-04-15', '2021-07-28'] },
    );
    if (search.status !== 200) {
      show('GET /conversations/search', search);
      return;
    }
    for (const convo of search.body?.conversations ?? []) {
      const msgs = await call('GET', `/conversations/${convo.id}/messages?limit=10`, {
        versions: ['2021-04-15', '2021-07-28'],
      });
      if (msgs.status !== 200) {
        show(`GET /conversations/${convo.id}/messages`, msgs);
        continue;
      }
      const list = msgs.body?.messages?.messages ?? msgs.body?.messages ?? [];
      for (const m of list) {
        const key = m.id ?? m.messageId;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const dir = m.direction ?? (m.type === 1 ? 'inbound' : '?');
        console.log(
          `  ${dir.padEnd(8)} id=${key} at=${m.dateAdded ?? '?'} body=${JSON.stringify(String(m.body ?? '').slice(0, 90))}`,
        );
      }
    }
    await new Promise((r) => setTimeout(r, Number(process.env.GHL_POLL_MS ?? 30_000)));
  }
  console.log(`\n  distinct message ids seen: ${seen.size}`);
}

async function main(): Promise<void> {
  requireEnv();
  console.log(`base=${BASE}\nlocation=${LOCATION}\npit=${PIT.slice(0, 6)}…(${PIT.length} chars)`);

  await probeLocation();
  await probeNumbers();
  let contactId: string | null = CONTACT_ID || null;
  const contact = await probeContact();

  const to = opt('to') ?? opt('ensure-contact');
  if (to) contactId = await ensureContact(to);

  if (flag('send')) {
    if (!contactId) {
      console.error('\nno contact id to send to; pass --ensure-contact <phone> or set GHL_TEST_CONTACT_ID');
      process.exit(1);
    }
    if (!to && !contact?.phone) {
      console.error('\ncontact has no phone; pass --ensure-contact <phone>');
      process.exit(1);
    }
    await sendSms(contactId, opt('body') ?? 'hi — intake grader connectivity test, no action needed');
  } else {
    console.log('\n(read-only. pass --send to actually send one SMS)');
  }

  const watch = Number(opt('watch') ?? (flag('send') ? 90 : 0));
  if (watch > 0) await pollInbound(watch);
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
