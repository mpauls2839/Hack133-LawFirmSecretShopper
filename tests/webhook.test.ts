/**
 * Inbound webhook path. The dangerous failure here is not a dropped event — the poller is
 * the backstop for that — it is an event attributed to the wrong run, or our own outbound
 * echoed back and answered as if the business had said it.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.JUDGE_DRIVER = 'stub';
process.env.DB_PATH = ':memory:';
process.env.ALLOW_LIVE_SENDS = 'false';
process.env.FAST_CLOCK = 'true';

const { useMemoryDb } = await import('../src/db/index.ts');
const { targets, runs, messages } = await import('../src/db/repo.ts');
const { seedPersona } = await import('../src/db/seed.ts');
const { mockAdapter } = await import('../src/channels/mock.ts');
const { useAdapter, openRun, handleInbound } = await import('../src/pipeline/loop.ts');
const { parseGhlWebhook, bindRun, bindingFor, runForProviderIds } = await import('../src/channels/ghl.ts');

let counter = 0;

function makeTarget() {
  counter += 1;
  return targets.upsert({
    url: `https://hook-${counter}.test/`,
    domain: `hook-${counter}.test`,
    name: `Hook Firm ${counter}`,
    category: 'law_firm',
    city: 'Cleveland, OH',
    timezone: 'America/New_York',
    services: ['car_accident'],
    hours: [1, 2, 3, 4, 5].map((day) => ({ day, open: 540, close: 1020 })),
    hours_confidence: 'high',
    claims_247: true,
    form: null,
    reachable: true,
    ingest_notes: [],
    phones: [{ number: `+1216777${1000 + counter}`, line_type: 'mobile', sms_capable: true }],
    emails: [],
  });
}

async function boundRun(contactId: string, conversationId: string | null) {
  const target = makeTarget();
  const opened = await openRun(target.id, { cycle: `hook-${counter}` });
  assert.ok(opened.ok);
  bindRun(opened.run.id, { contact_id: contactId, conversation_id: conversationId });
  return runs.get(opened.run.id)!;
}

before(() => {
  useMemoryDb();
  seedPersona();
  useAdapter(mockAdapter);
});

describe('GHL webhook payload parsing', () => {
  test('reads a flat workflow payload', () => {
    const { event, skip } = parseGhlWebhook({
      messageId: 'aGvueLidSxFhfB83h7KM',
      contactId: 'c1z473MAAQ00ccBF5SIL',
      conversationId: '4nCM09MIcdBYbB5mQaKo',
      body: 'HI i am sending a reply for my claude test',
      direction: 'inbound',
      dateAdded: '2026-07-26T19:26:50.623Z',
    });
    assert.equal(skip, undefined);
    assert.equal(event!.provider, 'ghl');
    assert.equal(event!.provider_id, 'aGvueLidSxFhfB83h7KM');
    assert.equal(event!.contact_id, 'c1z473MAAQ00ccBF5SIL');
    assert.equal(event!.conversation_id, '4nCM09MIcdBYbB5mQaKo');
    assert.equal(event!.body, 'HI i am sending a reply for my claude test');
    assert.equal(event!.ts, '2026-07-26T19:26:50.623Z');
  });

  test('reads a nested message payload', () => {
    const { event } = parseGhlWebhook({
      contact_id: 'contact-9',
      message: { messageId: 'm-9', body: 'Ruth can see you at 4pm', direction: 'inbound', type: 'SMS' },
    });
    assert.equal(event!.provider_id, 'm-9');
    assert.equal(event!.body, 'Ruth can see you at 4pm');
    assert.equal(event!.contact_id, 'contact-9');
  });

  test('reads a customData payload', () => {
    const { event } = parseGhlWebhook({
      customData: { message_id: 'cd-1', message_body: 'we do handle that', contact_id: 'contact-3' },
    });
    assert.equal(event!.provider_id, 'cd-1');
    assert.equal(event!.body, 'we do handle that');
  });

  test('refuses our own outbound echoed back', () => {
    // The same workflow fires on outbound too. Ingesting it makes the persona answer itself.
    const outbound = parseGhlWebhook({
      messageId: 'out-1',
      contactId: 'contact-1',
      body: 'Hi — my name is Dana Whitfield.',
      direction: 'outbound',
    });
    assert.equal(outbound.event, undefined);
    assert.match(outbound.skip!, /direction is outbound/);

    const byType = parseGhlWebhook({
      messageId: 'out-2',
      contactId: 'contact-1',
      body: 'Hi again',
      messageType: 'OUTBOUND_SMS',
    });
    assert.equal(byType.event, undefined);
  });

  test('refuses payloads it cannot dedupe or route', () => {
    assert.match(parseGhlWebhook({ contactId: 'c', body: 'hi' }).skip!, /no message id/);
    assert.match(parseGhlWebhook({ messageId: 'm', body: 'hi' }).skip!, /no contact or conversation id/);
    assert.match(parseGhlWebhook({ messageId: 'm', contactId: 'c' }).skip!, /no message body/);
    assert.match(parseGhlWebhook({}).skip!, /no message body/);
  });
});

describe('webhook routing', () => {
  test('bindings survive being read back from the database, not memory', async () => {
    const run = await boundRun('contact-persist', 'convo-persist');
    const reloaded = runs.get(run.id)!;
    assert.equal(reloaded.provider, 'ghl');
    assert.equal(reloaded.provider_contact_id, 'contact-persist');
    assert.equal(reloaded.provider_conversation_id, 'convo-persist');
    // Read through the adapter's accessor, which must not depend on process state.
    assert.deepEqual(bindingFor(run.id), { contact_id: 'contact-persist', conversation_id: 'convo-persist' });
  });

  test('resolves a run by conversation id, and by contact id when that is all there is', async () => {
    const run = await boundRun('contact-A', 'convo-A');
    assert.equal(runForProviderIds({ conversationId: 'convo-A' }), run.id);
    assert.equal(runForProviderIds({ contactId: 'contact-A' }), run.id);
    assert.equal(runForProviderIds({ conversationId: 'nope', contactId: 'contact-A' }), run.id);
    assert.equal(runForProviderIds({ conversationId: 'nope', contactId: 'nope' }), null);
  });

  test('a message id is never a valid routing key', async () => {
    const run = await boundRun('contact-B', 'convo-B');
    // Routing by message id was the original bug: it identifies the message, not the run.
    assert.equal(runForProviderIds({ conversationId: 'some-message-id' }), null);
    assert.notEqual(run.id, null);
  });

  test('an open run wins over a finished one for the same contact', async () => {
    const target = makeTarget();
    const first = await openRun(target.id, { cycle: 'week-1' });
    assert.ok(first.ok);
    bindRun(first.run.id, { contact_id: 'shared-contact', conversation_id: null });
    runs.transition(first.run.id, 'TERMINAL', { terminal_state: 'NO_RESPONSE', terminal_reason: 'test' });

    const second = await openRun(target.id, { cycle: 'week-2' });
    assert.ok(second.ok);
    bindRun(second.run.id, { contact_id: 'shared-contact', conversation_id: null });

    assert.equal(
      runForProviderIds({ contactId: 'shared-contact' }),
      second.run.id,
      'a reply should join the live run, not last cycle’s closed one',
    );
  });
});

describe('webhook and poller together', () => {
  test('the same message delivered by both paths is stored once', async () => {
    const run = await boundRun('contact-dupe', 'convo-dupe');
    const event = {
      provider: 'ghl',
      provider_id: 'W56Lvo4gHBc5leWdig9H',
      from: 'contact-dupe',
      to: '+17407614801',
      body: 'Yes we handle that. What day works for you?',
      ts: new Date().toISOString(),
      run_id: run.id,
    };

    const viaWebhook = await handleInbound(event);
    const viaPoller = await handleInbound(event);

    assert.equal(viaWebhook.handled, true);
    assert.equal(viaPoller.handled, false, 'the second delivery must be recognised as a duplicate');
    assert.match(viaPoller.reason, /duplicate/);
    assert.equal(messages.forRun(run.id).filter((m) => m.direction === 'in').length, 1);
    assert.equal(runs.get(run.id)!.turns, 1, 'a duplicate must not advance the turn counter');
  });

  test('two different messages from the same contact both land', async () => {
    const run = await boundRun('contact-two', 'convo-two');
    for (const [id, body] of [
      ['msg-1', 'Hi Dana, this is Marcy at the front desk.'],
      ['msg-2', 'Was a police report filed?'],
    ]) {
      const res = await handleInbound({
        provider: 'ghl',
        provider_id: id,
        from: 'contact-two',
        to: '+17407614801',
        body,
        ts: new Date().toISOString(),
        run_id: run.id,
      });
      assert.equal(res.handled, true, `${id} should be handled`);
    }
    assert.equal(messages.forRun(run.id).filter((m) => m.direction === 'in').length, 2);
  });
});

describe('history must never enter a run', () => {
  test('a message older than the run is refused, whichever path delivered it', async () => {
    const run = await boundRun('contact-history', 'convo-history');
    // Give the run a definite opening time so "before" is unambiguous.
    const t0 = new Date().toISOString();
    runs.patch(run.id, { t0 });

    const stale = await handleInbound({
      provider: 'ghl',
      provider_id: 'aGvueLidSxFhfB83h7KM',
      from: 'contact-history',
      to: '+17407614801',
      body: 'HI i am sending a reply for my claude test',
      ts: new Date(new Date(t0).getTime() - 2 * 60 * 60_000).toISOString(),
      run_id: run.id,
    });

    assert.equal(stale.handled, false, 'a two-hour-old message is history, not a reply');
    assert.match(stale.reason, /predates/);
    assert.equal(messages.forRun(run.id).filter((m) => m.direction === 'in').length, 0);
    assert.equal(runs.get(run.id)!.turns, 0, 'history must not advance the conversation');
    assert.ok(
      !['TERMINAL', 'GRADED', 'CLEANED_UP'].includes(runs.get(run.id)!.state),
      'and must not close the run — replayed history closed a real run in twelve seconds',
    );
  });

  test('a message sent after the run opens is accepted normally', async () => {
    const run = await boundRun('contact-fresh', 'convo-fresh');
    runs.patch(run.id, { t0: new Date(Date.now() - 60_000).toISOString() });

    const fresh = await handleInbound({
      provider: 'ghl',
      provider_id: 'fresh-1',
      from: 'contact-fresh',
      to: '+17407614801',
      body: 'Hi Dana, this is Marcy at the front desk. Was a police report filed?',
      ts: new Date().toISOString(),
      run_id: run.id,
    });

    assert.equal(fresh.handled, true);
    assert.equal(runs.get(run.id)!.turns, 1);
  });
});
