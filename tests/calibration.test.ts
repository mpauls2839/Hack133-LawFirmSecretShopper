/**
 * Calibration gate (spec section 6): the tier 1 judge must agree with the hand-labeled
 * set at least 80% of the time. Without this the scorecard is a random number generator.
 *
 * Runs against whichever driver is configured. With JUDGE_DRIVER=stub (the default in
 * tests) it measures the deterministic + heuristic path, which is the floor. Point it at
 * a real model and the same assertions apply — that is the whole value of a fixture.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

process.env.JUDGE_DRIVER = process.env.JUDGE_DRIVER ?? 'stub';
process.env.DB_PATH = ':memory:';

const { useMemoryDb } = await import('../src/db/index.ts');
const { classifyInbound } = await import('../src/judge/classify.ts');
const { readInbound } = await import('../src/judge/deterministic.ts');

type Case = {
  id: string;
  source: string;
  body: string;
  seconds_since_outbound: number | null;
  expect: 'autoresponder' | 'ai_agent' | 'human';
  note?: string;
  flags: Record<string, boolean>;
};

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/calibration.json'), 'utf8'),
) as { cases: Case[] };

const CASES = fixture.cases;
const THRESHOLD = 0.8;

before(() => {
  useMemoryDb();
});

describe('tier 1 calibration', () => {
  test(`the fixture is large enough to mean anything`, () => {
    assert.ok(CASES.length >= 20, `spec requires 20 labeled messages, found ${CASES.length}`);
    const kinds = new Set(CASES.map((c) => c.expect));
    assert.equal(kinds.size, 3, 'all three sender types must be represented');
    assert.ok(
      CASES.filter((c) => c.source.startsWith('live')).length >= 5,
      'at least a handful must be real messages, not imagined ones',
    );
  });

  test(`sender_type agrees with the labels at least ${THRESHOLD * 100}%`, async () => {
    const wrong: string[] = [];
    let correct = 0;

    for (const c of CASES) {
      const cls = await classifyInbound({
        body: c.body,
        priorInbound: [],
        secondsSinceOutbound: c.seconds_since_outbound,
        lastOutbound: 'Is this something you handle, and what would it cost to talk to someone?',
      });
      if (cls.sender_type === c.expect) correct += 1;
      else wrong.push(`${c.id}: expected ${c.expect}, got ${cls.sender_type} — ${JSON.stringify(c.body.slice(0, 60))}`);
    }

    const rate = correct / CASES.length;
    console.log(`\n  calibration: ${correct}/${CASES.length} = ${(rate * 100).toFixed(0)}%`);
    for (const w of wrong) console.log(`    MISS ${w}`);

    assert.ok(
      rate >= THRESHOLD,
      `agreement ${(rate * 100).toFixed(0)}% is below the ${THRESHOLD * 100}% gate:\n  ${wrong.join('\n  ')}`,
    );
  });

  test('every flag the fixture insists on is set', () => {
    const failures: string[] = [];
    for (const c of CASES) {
      const required = Object.entries(c.flags).filter(([, v]) => v === true);
      if (required.length === 0) continue;
      const { flags } = readInbound(c.body, []);
      for (const [name] of required) {
        if (!(flags as Record<string, unknown>)[name]) {
          failures.push(`${c.id}: ${name} should be true — ${JSON.stringify(c.body.slice(0, 60))}`);
        }
      }
    }
    assert.deepEqual(failures, [], `deterministic flags missed:\n  ${failures.join('\n  ')}`);
  });

  test('deterministic backstops override the model, not the reverse', () => {
    // A calendar link means booking regardless of anything a model says.
    const withLink = readInbound('You can book here: https://calendly.com/firm/consult', []);
    assert.equal(withLink.flags.booking_link, true);
    assert.equal(withLink.flags.meeting_offered, true);

    // A near-identical repeat is an autoresponder whatever its wording.
    const canned = 'Thank you for contacting us! Our hours are Mon-Fri 9am-5pm.';
    const repeat = readInbound(canned, [canned]);
    assert.equal(repeat.forcedSenderType, 'autoresponder');

    // Slight rewording still counts as a repeat.
    const reworded = readInbound('Thank you for contacting us!! Our hours are Mon-Fri 9am-5pm.', [canned]);
    assert.equal(reworded.forcedSenderType, 'autoresponder');

    // A genuinely different message does not.
    const different = readInbound('Ruth can see you at 4:30pm today.', [canned]);
    assert.equal(different.forcedSenderType, null);
  });

  test('opt-out is detected on its own, in any casing', () => {
    for (const body of ['STOP', 'stop', 'Please remove me from your list', 'unsubscribe', 'do not text me again']) {
      assert.equal(readInbound(body, []).flags.opt_out_requested, true, `missed opt-out in ${JSON.stringify(body)}`);
    }
    // And is not triggered by ordinary words containing them.
    assert.equal(readInbound('I had to stop at the hospital on the way home', []).flags.opt_out_requested, false);
  });
});
