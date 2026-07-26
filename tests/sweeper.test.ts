/**
 * Sweeper, promise timer, and scorecard (spec steps 6 and 7).
 *
 * The clock is manipulated by backdating stored timestamps rather than by waiting, so a
 * 24-hour promise window is testable in milliseconds. Every assertion here is about
 * behaviour the inbound path cannot produce: silence, timeouts, and broken promises.
 */
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.JUDGE_DRIVER = 'stub';
process.env.DB_PATH = ':memory:';
process.env.ALLOW_LIVE_SENDS = 'false';
process.env.FAST_CLOCK = 'true';
process.env.NUDGE_AFTER_BIZ_MINUTES = '240';
process.env.NO_RESPONSE_CUTOFF_BIZ_MINUTES = '1440';
process.env.MAX_NUDGES = '2';

const { useMemoryDb, db } = await import('../src/db/index.ts');
const { targets, personas, runs, messages, sendQueue } = await import('../src/db/repo.ts');
const { seedPersona } = await import('../src/db/seed.ts');
const { mockAdapter, setMockProfile, clearAllMockRuns } = await import('../src/channels/mock.ts');
const { useAdapter, openRun, handleInbound, sweep, gradeRun, closeRun, cleanupRun } = await import(
  '../src/pipeline/loop.ts'
);

const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

let personaId: string;
let counter = 0;

/** 24/7 targets are graded on raw elapsed, which keeps these tests clock-simple. */
function makeTarget(opts: { claims247?: boolean; services?: string[] } = {}) {
  counter += 1;
  return targets.upsert({
    url: `https://fixture-${counter}.test/`,
    domain: `fixture-${counter}.test`,
    name: `Fixture Firm ${counter}`,
    category: 'law_firm',
    city: 'Cleveland, OH',
    timezone: 'America/New_York',
    services: opts.services ?? ['car_accident', 'personal_injury'],
    stated_hours_text: opts.claims247 ? 'Open 24 hours' : 'Hours: Mon-Fri 9:00am - 5:00pm',
    hours: opts.claims247
      ? [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: 0, close: 1440 }))
      : [1, 2, 3, 4, 5].map((day) => ({ day, open: 540, close: 1020 })),
    hours_confidence: 'high',
    claims_247: opts.claims247 ?? true,
    form: null,
    reachable: true,
    ingest_notes: [],
    phones: [{ number: `+1216555${String(1000 + counter)}`, line_type: 'mobile', sms_capable: true }],
    emails: [],
  });
}

async function startedRun(opts: { claims247?: boolean; services?: string[] } = {}) {
  const target = makeTarget(opts);
  const opened = await openRun(target.id, { cycle: `c${counter}` });
  assert.ok(opened.ok, `run should open: ${opened.ok ? '' : opened.reason}`);
  await sweep(); // drains first_contact so t0 is stamped
  return { run: runs.get(opened.run.id)!, target };
}

before(() => {
  useMemoryDb();
  personaId = seedPersona().id;
  useAdapter(mockAdapter);
  // The mock schedules its replies on a timer and needs somewhere to deliver them.
  // Without this the scripted business "speaks" into the void and every run stalls.
  mockAdapter.start!(async (event) => {
    await handleInbound(event);
  });
});

beforeEach(() => {
  clearAllMockRuns();
});

describe('sweeper: silence handling', () => {
  test('nudges after the threshold, at most twice, then closes NO_RESPONSE', async () => {
    const { run } = await startedRun();
    assert.ok(run.t0, 't0 must be stamped when first contact goes out');
    setMockProfile(run.id, 'promise_breaker');
    // Suppress the mock's scripted reply so this run is genuinely silent.
    sendQueue.cancelPending(run.id, 'test');

    // Silent past the nudge threshold but not the cutoff.
    db().prepare('UPDATE runs SET t0 = ?, last_outbound_at = ? WHERE id = ?').run(minutesAgo(300), minutesAgo(300), run.id);
    let report = await sweep();
    assert.equal(report.nudged, 1, 'first nudge');
    assert.equal(runs.get(run.id)!.nudges_sent, 0, 'nudge is queued, not yet counted as sent');
    await sweep(); // drain the nudge
    assert.equal(runs.get(run.id)!.nudges_sent, 1);

    db().prepare('UPDATE runs SET last_outbound_at = ? WHERE id = ?').run(minutesAgo(300), run.id);
    await sweep();
    await sweep();
    assert.equal(runs.get(run.id)!.nudges_sent, 2, 'second nudge');

    // Third time: cap reached, no further nudges.
    db().prepare('UPDATE runs SET last_outbound_at = ? WHERE id = ?').run(minutesAgo(300), run.id);
    report = await sweep();
    assert.equal(report.nudged, 0, 'MAX_NUDGES is respected');
    // Nothing inbound has arrived, so the run is still waiting rather than conversing.
    assert.equal(runs.get(run.id)!.state, 'AWAITING_REPLY', 'not yet past the cutoff');

    // Past the cutoff with nothing ever received.
    db().prepare('UPDATE runs SET last_outbound_at = ? WHERE id = ?').run(minutesAgo(2000), run.id);
    await sweep();
    const closed = runs.get(run.id)!;
    assert.equal(closed.terminal_state, 'NO_RESPONSE');
    assert.match(closed.terminal_reason ?? '', /no reply of any kind/);
  });

  test('the wall clock closes a run regardless of business hours', async () => {
    const { run } = await startedRun();
    sendQueue.cancelPending(run.id, 'test');
    db().prepare('UPDATE runs SET t0 = ?, last_outbound_at = ? WHERE id = ?')
      .run(minutesAgo(73 * 60), minutesAgo(73 * 60), run.id);
    await sweep();
    const closed = runs.get(run.id)!;
    assert.equal(closed.terminal_state, 'NO_RESPONSE');
    assert.match(closed.terminal_reason ?? '', /wall clock/);
  });
});

describe('sweeper: the promise timer', () => {
  test('PROMISE_BROKEN is distinguishable from NO_RESPONSE', async () => {
    const { run } = await startedRun();
    sendQueue.cancelPending(run.id, 'test');

    // The business promises a callback within 24 hours, then vanishes.
    const res = await handleInbound({
      provider: 'mock',
      provider_id: `promise-${run.id}`,
      from: 'firm',
      to: 'persona',
      body: 'Thanks for reaching out. We have received your inquiry and someone will get back to you within 24 hours.',
      ts: new Date().toISOString(),
      run_id: run.id,
    });
    assert.ok(res.handled);

    let updated = runs.get(run.id)!;
    assert.ok(updated.promise_made_at, 'the promise must be recorded');
    assert.equal(updated.promise_window_text, 'within 24 hours');
    assert.ok(updated.promise_deadline, 'a hard deadline must be computed from the stated window');
    assert.equal(updated.promise_kept, null, 'unresolved, not false');

    // Nothing arrives and the window expires.
    sendQueue.cancelPending(run.id, 'test');
    db().prepare('UPDATE runs SET promise_deadline = ? WHERE id = ?').run(minutesAgo(10), run.id);
    const report = await sweep();

    assert.equal(report.promises_broken, 1);
    updated = runs.get(run.id)!;
    assert.equal(updated.terminal_state, 'PROMISE_BROKEN');
    assert.equal(updated.promise_kept, false);
    assert.notEqual(updated.terminal_state, 'NO_RESPONSE', 'promised-and-vanished is its own finding');
    assert.match(updated.terminal_reason ?? '', /window expired in silence/);
  });

  test('a promise answered by a human resolves as kept', async () => {
    const { run } = await startedRun();
    sendQueue.cancelPending(run.id, 'test');

    await handleInbound({
      provider: 'mock',
      provider_id: `p2-${run.id}`,
      from: 'firm',
      to: 'persona',
      body: 'Someone will call you back within 2 hours.',
      ts: new Date().toISOString(),
      run_id: run.id,
    });
    assert.ok(runs.get(run.id)!.promise_made_at);

    await handleInbound({
      provider: 'mock',
      provider_id: `p3-${run.id}`,
      from: 'firm',
      to: 'persona',
      body: "Hi Dana, this is Marcy, sorry for the delay. Let me check with Ruth about your case.",
      ts: new Date().toISOString(),
      run_id: run.id,
    });

    const updated = runs.get(run.id)!;
    assert.equal(updated.first_reply_sender, 'autoresponder', 'the promise itself came from automation');
    assert.equal(updated.promise_kept, true, 'a human arriving inside the window keeps the promise');
  });

  test('a stated window is converted to a real deadline, not guessed', async () => {
    const { run } = await startedRun({ claims247: false });
    sendQueue.cancelPending(run.id, 'test');
    await handleInbound({
      provider: 'mock',
      provider_id: `p4-${run.id}`,
      from: 'firm',
      to: 'persona',
      body: 'Thank you for contacting us. An attorney will review this and be in touch within 2 business days.',
      ts: '2026-07-27T14:00:00.000Z',
      run_id: run.id,
    });
    const updated = runs.get(run.id)!;
    assert.equal(updated.promise_window_text, 'within 2 business days');
    // 2 business days from a Monday afternoon lands later than 48 raw hours would.
    assert.ok(
      new Date(updated.promise_deadline!) > new Date('2026-07-28T14:00:00.000Z'),
      `business-day windows must respect opening hours, got ${updated.promise_deadline}`,
    );
  });
});

describe('sweeper: bot loop', () => {
  test('only-automation-then-silence closes BOT_LOOP, not NO_RESPONSE', async () => {
    const { run } = await startedRun();
    sendQueue.cancelPending(run.id, 'test');
    for (const i of [1, 2]) {
      await handleInbound({
        provider: 'mock',
        provider_id: `bot-${run.id}-${i}`,
        from: 'firm',
        to: 'persona',
        body: `I'm the virtual assistant. Question ${i}: please reply with a number: 1) Auto 2) Other`,
        ts: new Date().toISOString(),
        run_id: run.id,
      });
    }
    assert.equal(runs.get(run.id)!.first_reply_sender, 'ai_agent');

    sendQueue.cancelPending(run.id, 'test');
    db().prepare('UPDATE runs SET last_inbound_at = ?, promise_deadline = NULL WHERE id = ?')
      .run(minutesAgo(2000), run.id);
    await sweep();

    const closed = runs.get(run.id)!;
    assert.equal(closed.terminal_state, 'BOT_LOOP');
    assert.match(closed.terminal_reason ?? '', /only automation ever replied/);
  });
});

describe('scorecard', () => {
  test('a booked run grades well and keeps the two scores apart', async () => {
    const { run } = await startedRun();
    setMockProfile(run.id, 'well_run');
    // Let the scripted well-run business play the whole conversation out. The mock delivers
    // on a timer even under FAST_CLOCK, so give each turn room to land.
    for (let i = 0; i < 40; i++) {
      await sweep();
      await new Promise((r) => setTimeout(r, 25));
      if (runs.get(run.id)!.state === 'GRADED' || runs.get(run.id)!.state === 'CLEANED_UP') break;
    }

    const graded = runs.get(run.id)!;
    assert.equal(graded.state, 'GRADED', 'reaching TERMINAL must produce a grade on the next sweep');
    const card = graded.scorecard!;
    assert.ok(card, 'scorecard must exist');

    assert.equal(card.terminal_state, 'BOOKED_WITH_SPECIALIST');
    assert.equal(card.terminal_rank, 1);
    assert.equal(card.qualified, true);
    assert.equal(card.screening.verdict, 'correct');
    assert.equal(card.harness_score.completed_mission, true);
    assert.ok(['A', 'B'].includes(card.business_score.grade), `expected a good grade, got ${card.business_score.grade}`);
    assert.equal(card.latency.graded_on, 'raw', '24/7 businesses are held to the wall clock');
    assert.ok(card.narrative && card.narrative.length > 20, 'a narrative must exist even with no model');
    assert.equal(typeof card.latency.first_reply_raw_minutes, 'number');
    assert.ok(card.conversation.inbound_count > 0);
  });

  test('grading is idempotent and never overwrites the outcome', async () => {
    const { run } = await startedRun();
    closeRun(runs.get(run.id)!, 'HUMAN_SPECIALIST', 'test close');
    const first = await gradeRun(run.id);
    assert.ok(first);
    const second = await gradeRun(run.id);
    assert.equal(second!.generated_at, first!.generated_at, 're-grading must not regenerate');
    assert.equal(runs.get(run.id)!.terminal_state, 'HUMAN_SPECIALIST', 'grading preserves the outcome');
    assert.equal(runs.get(run.id)!.state, 'GRADED');
  });

  test('an unqualified persona that gets booked is a harness pass and a business failure', async () => {
    const { run } = await startedRun({ services: ['estate_planning', 'probate'] });
    assert.equal(runs.get(run.id)!.qualified, false, 'an injury persona is not qualified here');

    closeRun(runs.get(run.id)!, 'BOOKED_GENERIC', 'the firm booked a matter it does not handle');
    const card = (await gradeRun(run.id))!;

    assert.equal(card.harness_score.completed_mission, true, 'the harness did its job');
    assert.equal(card.screening.verdict, 'wasted_time');
    assert.ok(
      card.business_score.points < 55,
      `booking an unqualified matter must score poorly, got ${card.business_score.points}`,
    );
    assert.ok(card.business_score.reasons.some((r) => /does not handle/.test(r)));
  });

  test('a correct decline of an unqualified persona grades well', async () => {
    const { run } = await startedRun({ services: ['estate_planning'] });
    // A business that declines has by definition replied, so the latency exists.
    runs.patch(run.id, {
      first_reply_at: new Date(new Date(runs.get(run.id)!.t0!).getTime() + 8 * 60_000).toISOString(),
      first_reply_sender: 'human',
      first_human_at: new Date(new Date(runs.get(run.id)!.t0!).getTime() + 8 * 60_000).toISOString(),
    });
    closeRun(runs.get(run.id)!, 'DEFLECTED', 'correctly referred out');
    const card = (await gradeRun(run.id))!;

    assert.equal(card.screening.verdict, 'correct_decline');
    assert.ok(
      ['A', 'B', 'C'].includes(card.business_score.grade),
      `a clean decline is correct behaviour, got ${card.business_score.grade}`,
    );
  });

  test('UNREACHABLE is a harness success and a business finding', async () => {
    const target = targets.upsert({
      url: 'https://gated.test/',
      domain: 'gated.test',
      name: 'Gated Firm',
      category: 'law_firm',
      city: 'Houston, TX',
      timezone: 'America/Chicago',
      services: ['car_accident'],
      stated_hours_text: 'Available 24/7',
      hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: 0, close: 1440 })),
      hours_confidence: 'high',
      claims_247: true,
      form: { url: 'https://gated.test/leads', fields: ['name', 'phone'], captcha: true, captcha_vendor: 'recaptcha' },
      reachable: false,
      unreachable_reason: 'no SMS-capable number; no email published; form gated by recaptcha',
      ingest_notes: [],
      phones: [],
      emails: [],
    });

    const opened = await openRun(target.id, { cycle: 'unreach' });
    assert.equal(opened.ok, false);
    assert.equal(opened.run.terminal_state, 'UNREACHABLE');

    const card = (await gradeRun(opened.run.id))!;
    assert.equal(card.harness_score.completed_mission, true, 'establishing there is no channel is a result');
    assert.match(card.harness_score.reason, /no usable channel/);
    assert.equal(card.business_score.grade, 'F');
    assert.ok(
      card.business_score.reasons.some((r) => /24\/7/.test(r)),
      'a 24/7 claim with no async channel must be called out',
    );
    assert.equal(card.latency.first_reply_raw_minutes, null);
  });

  test('a broken promise is visible in the grade, not just the outcome', async () => {
    const { run } = await startedRun();
    runs.patch(run.id, {
      promise_made_at: minutesAgo(200),
      promise_window_text: 'within 24 hours',
      promise_deadline: minutesAgo(10),
      promise_kept: false,
      first_reply_at: minutesAgo(220),
      first_reply_sender: 'autoresponder',
    });
    closeRun(runs.get(run.id)!, 'PROMISE_BROKEN', 'window expired in silence');
    const card = (await gradeRun(run.id))!;

    assert.equal(card.promise.made, true);
    assert.equal(card.promise.kept, false);
    assert.equal(card.business_score.grade, 'F');
    assert.ok(card.business_score.reasons.some((r) => /broke a promised callback/.test(r)));
    assert.equal(card.screening.verdict, 'miss_expensive');
  });

  test('OPTED_OUT is excluded from business grading and cleanup stays silent', async () => {
    const { run } = await startedRun();
    closeRun(runs.get(run.id)!, 'OPTED_OUT', 'recipient asked to stop');
    const card = (await gradeRun(run.id))!;
    assert.ok(card.business_score.reasons.some((r) => /excluded from business grading/.test(r)));
    assert.equal(card.harness_score.completed_mission, true);

    const res = await cleanupRun(run.id);
    assert.equal(res.sent, false, 'the correct way to honour an opt-out is silence');
    assert.match(res.reason, /silence/);
  });
});

describe('guardrails under sweep', () => {
  test('closing a run cancels anything still queued', async () => {
    const { run } = await startedRun();
    sendQueue.enqueue({ run_id: run.id, kind: 'reply', body: 'never sent', delayMs: 600_000 });
    assert.equal(sendQueue.pendingForRun(run.id).length > 0, true);
    closeRun(runs.get(run.id)!, 'STALLED', 'test');
    assert.equal(sendQueue.pendingForRun(run.id).length, 0, 'a closed run must not keep sending');
  });

  test('inbound arriving after close is recorded but never acted on', async () => {
    const { run } = await startedRun();
    closeRun(runs.get(run.id)!, 'NO_RESPONSE', 'test');
    const res = await handleInbound({
      provider: 'mock',
      provider_id: `late-${run.id}`,
      from: 'firm',
      to: 'persona',
      body: 'Sorry for the delay, are you still looking for help?',
      ts: new Date().toISOString(),
      run_id: run.id,
    });
    assert.equal(res.handled, false);
    assert.match(res.reason, /TERMINAL|GRADED/);
  });
});
