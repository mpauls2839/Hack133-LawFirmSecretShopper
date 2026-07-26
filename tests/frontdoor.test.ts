import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimAwaitInbound,
  enqueueAwaitInbound,
  cancelAwaitInbound,
  isOurInboundNumber,
  listAwaitInbound,
  normalizePhone,
} from '../src/frontdoor/await-inbound.ts';
import { parseContactPlan } from '../src/frontdoor/tools.ts';

describe('frontdoor await-inbound', () => {
  it('normalizes US phones to E.164', () => {
    assert.equal(normalizePhone('(305) 371-8000'), '+13053718000');
    assert.equal(normalizePhone('7407614801'), '+17407614801');
    assert.equal(normalizePhone('+1 740-761-4801'), '+17407614801');
  });

  it('FIFO claims the oldest awaiting run for our inbound number', () => {
    // Drain anything left from other tests in this process.
    for (const e of listAwaitInbound()) cancelAwaitInbound(e.run_id);

    enqueueAwaitInbound({
      run_id: 'run_a',
      target_id: 'tgt_a',
      inbound_number: '+17407614801',
    });
    enqueueAwaitInbound({
      run_id: 'run_b',
      target_id: 'tgt_b',
      inbound_number: '+17407614801',
    });

    const first = claimAwaitInbound('+17407614801');
    assert.equal(first?.run_id, 'run_a');
    const second = claimAwaitInbound('7407614801');
    assert.equal(second?.run_id, 'run_b');
    assert.equal(claimAwaitInbound('+17407614801'), null);
  });

  it('recognizes our inbound number', () => {
    assert.equal(isOurInboundNumber('+17407614801'), true);
    assert.equal(isOurInboundNumber('17407614801'), true);
    assert.equal(isOurInboundNumber('+13053718000'), false);
  });
});

describe('frontdoor parseContactPlan', () => {
  it('parses form_submitted with inbound default', () => {
    const plan = parseContactPlan(
      {
        mode: 'form_submitted',
        form_url: 'https://example.com/contact',
        submitted: true,
        fields_filled: { phone: '+17407614801', name: 'Dana' },
        evidence: 'thank you page',
        notes: ['submitted'],
      },
      '+17407614801',
    );
    assert.equal(plan.mode, 'form_submitted');
    if (plan.mode === 'form_submitted') {
      assert.equal(plan.expected_inbound_number, '+17407614801');
      assert.equal(plan.submitted, true);
      assert.equal(plan.fields_filled.phone, '+17407614801');
    }
  });

  it('parses sms mode', () => {
    const plan = parseContactPlan(
      { mode: 'sms', phone: '+13053718000', evidence: 'header tel', notes: [] },
      '+17407614801',
    );
    assert.equal(plan.mode, 'sms');
    if (plan.mode === 'sms') assert.equal(plan.phone, '+13053718000');
  });

  it('rejects unknown mode', () => {
    assert.throws(() => parseContactPlan({ mode: 'email', notes: [] }, '+17407614801'));
  });
});
