/**
 * Channel capability + reachability verdict (spec 4.2).
 *
 * No lookup provider is wired in the prototype, so an unknown line type means
 * "attempt once and let the carrier error be the verdict", and that verdict is cached on
 * the phone row. Landlines that silently eat texts are the failure mode this exists for.
 */
import type { Target } from '../domain/types.ts';
import { targets } from '../db/repo.ts';
import { guessLineType } from './extract.ts';
import { logEvent } from '../db/index.ts';

export type ChannelChoice = {
  channel: 'sms' | 'email' | 'form';
  address: string;
  why: string;
};

export type Reachability = {
  reachable: boolean;
  unreachable_reason: string | null;
  choice: ChannelChoice | null;
  notes: string[];
};

/** A phone worth trying: known SMS-capable, or never checked. */
function attemptable(phone: Target['phones'][number]): boolean {
  return phone.sms_capable === true || phone.sms_capable === null;
}

export function annotateLineTypes(target: Target): Target {
  for (const phone of target.phones) {
    if (phone.line_type !== 'unknown' || phone.sms_capable !== null) continue;
    const guess = guessLineType(phone.number);
    if (guess.line_type !== 'unknown') {
      targets.setPhoneCapability(phone.id, guess.line_type, guess.sms_capable === true);
      phone.line_type = guess.line_type;
      phone.sms_capable = guess.sms_capable;
    }
  }
  return target;
}

/** Records the carrier's answer so the same dead number is not retried next cycle. */
export function recordSendFailure(target: Target, number: string, error: string): void {
  const phone = target.phones.find((f) => f.number === number);
  if (!phone) return;
  const looksLikeLandline = /landline|not.*sms|unsupported|cannot receive|21614|21408|30006/i.test(error);
  targets.setPhoneCapability(phone.id, looksLikeLandline ? 'landline' : phone.line_type, false);
  logEvent(null, 'phone_capability_learned', {
    target_id: target.id,
    number,
    line_type: looksLikeLandline ? 'landline' : phone.line_type,
    sms_capable: false,
    error: error.slice(0, 200),
  });
}

/**
 * Best usable text channel: SMS, then email, then an ungated form.
 * A live chat widget is not an asynchronous channel and does not rescue reachability —
 * a business advertising 24/7 with chat-only contact is exactly the finding worth keeping.
 */
export function assessReachability(target: Target): Reachability {
  const notes: string[] = [];
  const smsPhone = target.phones.find(attemptable);
  if (smsPhone) {
    return {
      reachable: true,
      unreachable_reason: null,
      choice: {
        channel: 'sms',
        address: smsPhone.number,
        why:
          smsPhone.sms_capable === true
            ? 'known SMS-capable number'
            : 'line type unknown, attempting once and caching the carrier verdict',
      },
      notes,
    };
  }
  if (target.phones.length > 0) notes.push('all listed numbers are known not to accept SMS');

  if (target.emails.length > 0) {
    return {
      reachable: true,
      unreachable_reason: null,
      choice: { channel: 'email', address: target.emails[0], why: 'published email address' },
      notes,
    };
  }

  if (target.form && !target.form.captcha) {
    return {
      reachable: true,
      unreachable_reason: null,
      choice: { channel: 'form', address: target.form.url, why: 'ungated intake form' },
      notes,
    };
  }
  if (target.form?.captcha) {
    notes.push(`intake form is ${target.form.captcha_vendor ?? 'captcha'} gated; never solved by policy`);
  }
  if (target.chat_widget) {
    notes.push(`only synchronous channel is a ${target.chat_widget} chat widget`);
  }

  const reasons: string[] = [];
  if (target.phones.length === 0) reasons.push('no phone number published');
  else reasons.push('no SMS-capable number');
  if (target.emails.length === 0) reasons.push('no email published');
  if (!target.form) reasons.push('no intake form found');
  else if (target.form.captcha) reasons.push(`intake form gated by ${target.form.captcha_vendor ?? 'captcha'}`);

  return {
    reachable: false,
    unreachable_reason: reasons.join('; '),
    choice: null,
    notes,
  };
}
