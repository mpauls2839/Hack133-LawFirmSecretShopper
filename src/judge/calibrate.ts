/**
 * Runs the hand-labeled set against whichever judge is currently configured.
 *
 * This lives in src rather than tests because the number that matters is the one the
 * DEPLOYED judge scores — tests run against the offline stub, and a model swap in env can
 * move accuracy without a single line of code changing. The test suite asserts the gate;
 * this makes it observable in production.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyInbound } from './classify.ts';
import { readInbound } from './deterministic.ts';
import { judgeStatus } from './llm.ts';

export type CalibrationCase = {
  id: string;
  source: string;
  body: string;
  seconds_since_outbound: number | null;
  expect: 'autoresponder' | 'ai_agent' | 'human';
  note?: string;
  flags: Record<string, boolean>;
};

export const CALIBRATION_THRESHOLD = 0.8;

export function loadCalibration(): CalibrationCase[] {
  const path = resolve(import.meta.dirname, 'calibration.json');
  return (JSON.parse(readFileSync(path, 'utf8')) as { cases: CalibrationCase[] }).cases;
}

export type CalibrationResult = {
  passed: boolean;
  agreement: number;
  correct: number;
  total: number;
  threshold: number;
  judge: ReturnType<typeof judgeStatus>;
  misses: Array<{ id: string; expected: string; got: string; body: string; note?: string }>;
  flag_misses: string[];
};

const LAST_ASK = 'Is this something you handle, and what would it cost to talk to someone?';

export async function runCalibration(): Promise<CalibrationResult> {
  const cases = loadCalibration();
  const misses: CalibrationResult['misses'] = [];
  let correct = 0;

  for (const c of cases) {
    const cls = await classifyInbound({
      body: c.body,
      priorInbound: [],
      secondsSinceOutbound: c.seconds_since_outbound,
      lastOutbound: LAST_ASK,
    });
    if (cls.sender_type === c.expect) correct += 1;
    else {
      misses.push({
        id: c.id,
        expected: c.expect,
        got: cls.sender_type,
        body: c.body.slice(0, 90),
        note: c.note,
      });
    }
  }

  // Deterministic flags are checked separately: they must hold regardless of the model.
  const flagMisses: string[] = [];
  for (const c of cases) {
    const required = Object.entries(c.flags).filter(([, v]) => v === true);
    if (required.length === 0) continue;
    const { flags } = readInbound(c.body, []);
    for (const [name] of required) {
      if (!(flags as Record<string, unknown>)[name]) flagMisses.push(`${c.id}: ${name}`);
    }
  }

  const agreement = cases.length === 0 ? 0 : correct / cases.length;
  return {
    passed: agreement >= CALIBRATION_THRESHOLD && flagMisses.length === 0,
    agreement: Number(agreement.toFixed(3)),
    correct,
    total: cases.length,
    threshold: CALIBRATION_THRESHOLD,
    judge: judgeStatus(),
    misses,
    flag_misses: flagMisses,
  };
}
