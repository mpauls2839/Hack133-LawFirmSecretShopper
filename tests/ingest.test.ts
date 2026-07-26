import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

process.env.JUDGE_DRIVER = 'stub'; // no network in tests
process.env.DB_PATH = ':memory:';

const { useMemoryDb } = await import('../src/db/index.ts');
const { ingestTarget, reassessReachability } = await import('../src/pipeline/intake.ts');
const { recordSendFailure } = await import('../src/ingest/capability.ts');
const { qualify } = await import('../src/domain/qualify.ts');
const { loadPersona } = await import('../src/persona/load.ts');
const { targets } = await import('../src/db/repo.ts');

const fixture = (name: string): string =>
  pathToFileURL(resolve(import.meta.dirname, '../src/mock/fixtures', name)).href;

before(() => {
  useMemoryDb();
});

describe('ingest: well-run injury firm', () => {
  test('extracts every channel deterministically and picks SMS', async () => {
    const { target, reachability, pages } = await ingestTarget(fixture('sterling-vance.html'), {
      contactUrl: fixture('sterling-vance-contact.html'),
      domain: 'sterlingvance.test',
    });

    assert.equal(pages.fetched, 2);
    assert.equal(target.name, 'Sterling & Vance Injury Law');
    assert.deepEqual(
      target.phones.map((p) => p.number),
      ['+12165550184'],
      'tel: hrefs in two different formats must normalise to one number',
    );
    assert.deepEqual(target.emails, ['intake@sterlingvance.test']);
    assert.ok(target.form, 'intake form should be found on the contact page');
    assert.equal(target.form?.captcha, false);
    assert.ok(target.form?.fields.includes('message'));
    assert.equal(target.city, 'Cleveland, OH');
    assert.equal(target.timezone, 'America/New_York');
    assert.equal(target.claims_247, true, '"Open 24 hours" must set the 24/7 marketing claim');
    assert.equal(target.hours_confidence, 'high');
    assert.equal(target.hours.length, 7, '24/7 means a window every day');

    assert.equal(reachability.reachable, true);
    assert.equal(reachability.choice?.channel, 'sms');
    assert.equal(reachability.choice?.address, '+12165550184');
  });

  test('services drive qualification for the fixed persona', async () => {
    const { target } = await ingestTarget(fixture('sterling-vance.html'), {
      contactUrl: fixture('sterling-vance-contact.html'),
      domain: 'sterlingvance.test',
    });
    assert.ok(target.services.includes('car_accident'));
    assert.ok(target.services.includes('personal_injury'));

    const q = qualify(loadPersona(), target);
    assert.equal(q.qualified, true);
    assert.equal(q.confidence, 'high');
    assert.ok(q.matched.includes('car_accident'));
  });
});

describe('ingest: 24/7 claim with no asynchronous channel', () => {
  test('captcha form + toll-free number is attempted once, then cached as unreachable', async () => {
    const { target, reachability } = await ingestTarget(fixture('hollis-partners.html'), {
      domain: 'hollispartners.test',
    });

    assert.equal(target.claims_247, true);
    assert.equal(target.chat_widget, 'tawk');
    assert.equal(target.form?.captcha, true);
    assert.equal(target.form?.captcha_vendor, 'recaptcha');
    assert.deepEqual(target.emails, [], 'no published email on this fixture');
    assert.equal(target.phones[0]?.line_type, 'voip', 'toll-free prefix is treated as voip');
    assert.equal(target.timezone, 'America/Chicago');

    // Unknown line type is worth one attempt, per spec 4.2.
    assert.equal(reachability.reachable, true);
    assert.equal(reachability.choice?.channel, 'sms');

    // Carrier rejects it. That verdict is cached and the target becomes UNREACHABLE.
    recordSendFailure(target, target.phones[0].number, 'Error 21614: To number is not a valid mobile number');
    const after = reassessReachability(target.id);

    assert.equal(after.reachable, false);
    assert.match(after.unreachable_reason ?? '', /no SMS-capable number/);
    assert.match(after.unreachable_reason ?? '', /recaptcha/);
    assert.ok(
      after.notes.some((n) => /tawk chat widget/.test(n)),
      'a chat-only firm claiming 24/7 is the finding; keep it in the notes',
    );

    const reloaded = targets.get(target.id)!;
    assert.equal(reloaded.phones[0].sms_capable, false, 'capability verdict must persist');
    assert.equal(reloaded.phones[0].line_type, 'landline');
  });

  test('captcha is never solved, only recorded', async () => {
    const { target } = await ingestTarget(fixture('hollis-partners.html'), {
      domain: 'hollispartners.test',
    });
    assert.equal(target.form?.captcha, true);
    // There is deliberately no captcha-solving code path to assert against.
  });
});

describe('ingest: reachable but out of scope', () => {
  test('parses real weekday hours and reports the persona as unqualified', async () => {
    const { target, reachability } = await ingestTarget(fixture('marrow-estate.html'), {
      domain: 'marrowestate.test',
    });

    assert.equal(target.claims_247, false);
    assert.equal(target.hours_confidence, 'high');
    assert.deepEqual(
      target.hours.map((h) => h.day).sort(),
      [1, 2, 3, 4],
      'Monday-Thursday only; Friday is closed',
    );
    assert.equal(target.hours[0].open, 9 * 60);
    assert.equal(target.hours[0].close, 16 * 60);
    assert.equal(target.timezone, 'America/Chicago');
    assert.equal(reachability.reachable, true);

    assert.ok(target.services.includes('estate_planning'));
    assert.ok(!target.services.includes('car_accident'));

    const q = qualify(loadPersona(), target);
    assert.equal(q.qualified, false, 'an injury persona is not qualified at an estate practice');
    assert.equal(q.confidence, 'high');
    assert.match(q.reason, /none matching persona need tags/);
  });
});

describe('ingest: idempotence', () => {
  test('re-ingesting the same domain updates rather than duplicating', async () => {
    const first = await ingestTarget(fixture('marrow-estate.html'), { domain: 'marrowestate.test' });
    const second = await ingestTarget(fixture('marrow-estate.html'), { domain: 'marrowestate.test' });
    assert.equal(first.target.id, second.target.id);
    assert.equal(targets.list().filter((t) => t.domain === 'marrowestate.test').length, 1);
  });
});
