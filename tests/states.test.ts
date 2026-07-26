import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.JUDGE_DRIVER = 'stub';
process.env.DB_PATH = ':memory:';

const { useMemoryDb, events } = await import('../src/db/index.ts');
const { targets, personas, runs, messages, sendQueue, RunBusy } = await import('../src/db/repo.ts');
const { canTransition, IllegalTransition, OUTCOMES, outcomeRank, isBetterOutcome, screeningVerdict } =
  await import('../src/domain/states.ts');
const { seedPersona } = await import('../src/db/seed.ts');

const CYCLE = '2026-07-26';

function makeTarget(domain: string) {
  return targets.upsert({
    url: `https://${domain}/`,
    domain,
    name: domain,
    category: 'law_firm',
    city: 'Cleveland, OH',
    timezone: 'America/New_York',
    services: ['car_accident'],
    hours: [{ day: 1, open: 540, close: 1020 }],
    hours_confidence: 'high',
    claims_247: false,
    form: null,
    reachable: true,
    ingest_notes: [],
    phones: [{ number: '+12165550184', line_type: 'unknown', sms_capable: null }],
    emails: ['intake@' + domain],
  });
}

let personaId: string;

before(() => {
  useMemoryDb();
  personaId = seedPersona().id;
});

describe('state machine', () => {
  test('the outcome ladder is ordered and complete', () => {
    const ranks = Object.values(OUTCOMES).map((o) => o.rank);
    assert.equal(new Set(ranks).size, ranks.length, 'no two outcomes may share a rank');
    assert.equal(outcomeRank('BOOKED_WITH_SPECIALIST'), 1);
    assert.ok(outcomeRank('BOOKED_GENERIC') < outcomeRank('HUMAN_GENERIC'));
    assert.ok(isBetterOutcome('HUMAN_SPECIALIST', 'BOT_LOOP'));
    assert.ok(!isBetterOutcome('NO_RESPONSE', 'DEFLECTED'));
    assert.equal(outcomeRank('NOT_A_STATE'), 99);
  });

  test('PROMISE_BROKEN and NO_RESPONSE are distinct outcomes', () => {
    assert.notEqual(OUTCOMES.PROMISE_BROKEN.rank, OUTCOMES.NO_RESPONSE.rank);
    assert.ok(
      outcomeRank('PROMISE_BROKEN') < outcomeRank('NO_RESPONSE'),
      'a business that answered then vanished is a different finding from silence',
    );
  });

  test('OPTED_OUT is excluded from business grading', () => {
    assert.equal(OUTCOMES.OPTED_OUT.gradable, false);
    assert.equal(OUTCOMES.UNREACHABLE.gradable, true, 'unreachable is a real finding, not an excuse');
  });

  test('legal edges only', () => {
    assert.ok(canTransition('CREATED', 'CONTACTED'));
    assert.ok(canTransition('CREATED', 'TERMINAL'), 'UNREACHABLE closes before any send');
    assert.ok(canTransition('IN_CONVERSATION', 'TERMINAL'));
    assert.ok(canTransition('TERMINAL', 'GRADED'));
    assert.ok(canTransition('GRADED', 'CLEANED_UP'));
    assert.ok(!canTransition('CREATED', 'GRADED'));
    assert.ok(!canTransition('CLEANED_UP', 'IN_CONVERSATION'));
    assert.ok(!canTransition('TERMINAL', 'IN_CONVERSATION'), 'terminal is terminal');
  });

  test('the confusion matrix keeps harness and business judgements apart', () => {
    assert.equal(screeningVerdict(true, 'handled').verdict, 'correct');
    assert.equal(screeningVerdict(true, 'not_handled').verdict, 'miss_expensive');
    assert.equal(screeningVerdict(false, 'handled').verdict, 'wasted_time');
    assert.equal(screeningVerdict(false, 'not_handled').verdict, 'correct_decline');
  });
});

describe('run lifecycle, driven without any messaging', () => {
  let runId: string;

  beforeEach(() => {
    const target = makeTarget(`fixture-${Math.random().toString(36).slice(2, 8)}.test`);
    runId = runs.create({
      target_id: target.id,
      persona_id: personaId,
      cycle: CYCLE,
      qualified: true,
      qualification_reason: 'car_accident matches',
    }).id;
  });

  test('walks CREATED to CLEANED_UP and keeps the outcome', () => {
    runs.transition(runId, 'CONTACTED', { t0: new Date().toISOString() });
    runs.transition(runId, 'AWAITING_REPLY');
    runs.transition(runId, 'IN_CONVERSATION', { turns: 1 });
    runs.transition(runId, 'TERMINAL', {
      terminal_state: 'HUMAN_SPECIALIST',
      terminal_reason: 'reached the attorney',
    });

    let run = runs.get(runId)!;
    assert.equal(run.state, 'TERMINAL');
    assert.equal(run.terminal_state, 'HUMAN_SPECIALIST');
    assert.ok(run.closed_at, 'closed_at is stamped on the terminal transition');

    runs.transition(runId, 'GRADED');
    runs.transition(runId, 'CLEANED_UP');
    run = runs.get(runId)!;
    assert.equal(run.state, 'CLEANED_UP');
    assert.equal(
      run.terminal_state,
      'HUMAN_SPECIALIST',
      'grading must not overwrite the outcome — this is why they are separate columns',
    );
  });

  test('illegal transitions throw instead of corrupting the run', () => {
    assert.throws(() => runs.transition(runId, 'GRADED'), IllegalTransition);
    assert.equal(runs.get(runId)!.state, 'CREATED', 'a rejected transition changes nothing');
  });

  test('TERMINAL without a valid outcome is refused', () => {
    runs.transition(runId, 'CONTACTED');
    assert.throws(() => runs.transition(runId, 'TERMINAL', { terminal_state: 'VIBES' }), /valid terminal_state/);
    assert.throws(() => runs.transition(runId, 'TERMINAL'), /valid terminal_state/);
  });

  test('every state change lands in the append-only event log', () => {
    runs.transition(runId, 'CONTACTED');
    runs.transition(runId, 'AWAITING_REPLY');
    const changes = events(runId).filter((e) => e.type === 'state_change');
    assert.equal(changes.length, 2);
    assert.deepEqual(
      changes.map((c) => (c.data as any).to).sort(),
      ['AWAITING_REPLY', 'CONTACTED'],
    );
  });

  test('one open inquiry per business per cycle is enforced by the database', () => {
    const run = runs.get(runId)!;
    assert.throws(
      () =>
        runs.create({
          target_id: run.target_id,
          persona_id: personaId,
          cycle: CYCLE,
          qualified: true,
          qualification_reason: 'duplicate attempt',
        }),
      /UNIQUE constraint failed/,
      'guardrail is a constraint, not a convention',
    );
    // A later cycle is allowed.
    const next = runs.create({
      target_id: run.target_id,
      persona_id: personaId,
      cycle: '2026-08-01',
      qualified: true,
      qualification_reason: 'next cycle',
    });
    assert.ok(next.id);
  });

  test('promise timers are stored so PROMISE_BROKEN is provable, not inferred', () => {
    runs.transition(runId, 'CONTACTED');
    runs.transition(runId, 'AWAITING_REPLY', {
      promise_made_at: '2026-07-26T14:00:00.000Z',
      promise_window_text: 'within 24 hours',
      promise_deadline: '2026-07-27T14:00:00.000Z',
    });
    const run = runs.get(runId)!;
    assert.equal(run.promise_kept, null, 'unresolved is null, not false');
    runs.patch(runId, { promise_kept: false });
    assert.equal(runs.get(runId)!.promise_kept, false);
  });
});

describe('inbound dedupe', () => {
  test('the same provider message id can arrive twice and is stored once', () => {
    const target = makeTarget('dedupe.test');
    const run = runs.create({
      target_id: target.id,
      persona_id: personaId,
      cycle: CYCLE,
      qualified: true,
      qualification_reason: 'x',
    });

    const first = messages.add({
      run_id: run.id,
      direction: 'in',
      body: 'Thanks for reaching out!',
      provider: 'ghl',
      provider_id: 'W56Lvo4gHBc5leWdig9H',
    });
    const replay = messages.add({
      run_id: run.id,
      direction: 'in',
      body: 'Thanks for reaching out!',
      provider: 'ghl',
      provider_id: 'W56Lvo4gHBc5leWdig9H',
    });

    assert.equal(first.inserted, true);
    assert.equal(replay.inserted, false, 'a replayed webhook must not create a second turn');
    assert.equal(replay.message.id, first.message.id);
    assert.equal(messages.forRun(run.id).length, 1);
  });

  test('messages without a provider id are never deduped away', () => {
    const target = makeTarget('nodedupe.test');
    const run = runs.create({
      target_id: target.id,
      persona_id: personaId,
      cycle: CYCLE,
      qualified: true,
      qualification_reason: 'x',
    });
    messages.add({ run_id: run.id, direction: 'out', body: 'hello' });
    messages.add({ run_id: run.id, direction: 'out', body: 'hello' });
    assert.equal(messages.forRun(run.id).length, 2);
  });
});

describe('outbound queue', () => {
  test('a delayed reply is a row, not a timer in memory', () => {
    const target = makeTarget('queue.test');
    const run = runs.create({
      target_id: target.id,
      persona_id: personaId,
      cycle: CYCLE,
      qualified: true,
      qualification_reason: 'x',
    });

    sendQueue.enqueue({ run_id: run.id, kind: 'reply', body: 'later', delayMs: 60_000 });
    const readyNow = sendQueue.enqueue({ run_id: run.id, kind: 'reply', body: 'now', delayMs: 0 });

    const due = sendQueue.due();
    assert.equal(due.length, 1, 'only the message whose send_after has passed is due');
    assert.equal(due[0].id, readyNow.id);

    sendQueue.markSent(readyNow.id, 'bMrdQjSsflmzqKcB99M6');
    assert.equal(sendQueue.get(readyNow.id)!.state, 'sent');
    assert.equal(sendQueue.due().length, 0);

    // Cleanup cancels anything still pending.
    assert.equal(sendQueue.cancelPending(run.id, 'run closed'), 1);
    assert.equal(sendQueue.pendingForRun(run.id).length, 0);
  });

  test('a failed send retries before it is abandoned', () => {
    const target = makeTarget('retry.test');
    const run = runs.create({
      target_id: target.id,
      persona_id: personaId,
      cycle: CYCLE,
      qualified: true,
      qualification_reason: 'x',
    });
    const queued = sendQueue.enqueue({ run_id: run.id, kind: 'first_contact', body: 'hi', delayMs: 0 });

    sendQueue.markFailed(queued.id, 'HTTP 502', true);
    let row = sendQueue.get(queued.id)!;
    assert.equal(row.state, 'pending', 'retryable failures stay pending');
    assert.equal(row.attempts, 1);
    assert.equal(sendQueue.due().length, 0, 'and are backed off, not hammered');

    sendQueue.markFailed(queued.id, 'Error 21614: not a valid mobile number', false);
    row = sendQueue.get(queued.id)!;
    assert.equal(row.state, 'failed');
    assert.match(row.last_error ?? '', /21614/);
  });
});

describe('single-writer lock', () => {
  test('a second writer is refused while the first holds the run', async () => {
    const target = makeTarget('lock.test');
    const run = runs.create({
      target_id: target.id,
      persona_id: personaId,
      cycle: CYCLE,
      qualified: true,
      qualification_reason: 'x',
    });

    let inner: unknown = null;
    await runs.withLock(run.id, async () => {
      // The webhook path and the sweeper both want this run. Only one gets it.
      inner = await runs.withLock(run.id, () => 'should not happen').catch((err) => err);
    });
    assert.ok(inner instanceof RunBusy, `expected RunBusy, got ${String(inner)}`);

    // Lock is released afterwards.
    const after = await runs.withLock(run.id, () => 'ok');
    assert.equal(after, 'ok');
  });

  test('the lock is released even when the body throws', async () => {
    const target = makeTarget('lock2.test');
    const run = runs.create({
      target_id: target.id,
      persona_id: personaId,
      cycle: CYCLE,
      qualified: true,
      qualification_reason: 'x',
    });
    await assert.rejects(
      runs.withLock(run.id, () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(await runs.withLock(run.id, () => 'ok'), 'ok');
  });
});

describe('persona seeding', () => {
  test('the fixed persona loads from markdown with its rules intact', () => {
    const persona = personas.fixed()!;
    assert.equal(persona.id, 'persona-fixed');
    assert.ok(persona.need.length > 20, 'need prose must survive the markdown parse');
    assert.ok(persona.need_tags.includes('car_accident'));
    assert.ok(persona.behavior_rules.never.some((r) => /sign/i.test(r)), 'never-sign rule must load');
    assert.ok(persona.behavior_rules.push_when.length > 0);
    assert.match(persona.contact.email, /\.test$/, 'persona email must be unroutable');
    assert.ok(
      !/<!--/.test(persona.backstory + persona.need),
      'the guidance comment block must be stripped before prompts see it',
    );
  });
});
