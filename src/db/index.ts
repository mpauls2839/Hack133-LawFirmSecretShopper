import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, ROOT } from '../config.ts';

export type DB = Database.Database;

let handle: DB | null = null;

export function db(): DB {
  if (handle) return handle;
  const path = config.dbPath;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  handle = new Database(path);
  handle.pragma('foreign_keys = ON');
  handle.exec(readFileSync(resolve(ROOT, 'src/db/schema.sql'), 'utf8'));
  return handle;
}

/** Test helper: fresh in-memory database per test file. */
export function useMemoryDb(): DB {
  handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  handle.exec(readFileSync(resolve(ROOT, 'src/db/schema.sql'), 'utf8'));
  return handle;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

export const nowIso = (): string => new Date().toISOString();
export const id = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

// ---- settings (kill switch lives here) ------------------------------------

export function getSetting(key: string): string | null {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}

export function sendsHalted(): boolean {
  return getSetting('sends_halted') === '1';
}

export function haltSends(reason: string): void {
  setSetting('sends_halted', '1');
  setSetting('sends_halted_reason', reason);
  logEvent(null, 'sends_halted', { reason });
}

export function resumeSends(): void {
  setSetting('sends_halted', '0');
  logEvent(null, 'sends_resumed', {});
}

// ---- append-only event log -----------------------------------------------

export function logEvent(runId: string | null, type: string, data: unknown = {}): void {
  db()
    .prepare('INSERT INTO event_log (ts, run_id, type, data_json) VALUES (?, ?, ?, ?)')
    .run(nowIso(), runId, type, JSON.stringify(data ?? {}));
}

export function events(runId?: string, limit = 200): Array<{
  id: number;
  ts: string;
  run_id: string | null;
  type: string;
  data: unknown;
}> {
  const rows = runId
    ? (db()
        .prepare('SELECT * FROM event_log WHERE run_id = ? ORDER BY id DESC LIMIT ?')
        .all(runId, limit) as any[])
    : (db().prepare('SELECT * FROM event_log ORDER BY id DESC LIMIT ?').all(limit) as any[]);
  return rows.map((r) => ({ ...r, data: JSON.parse(r.data_json) }));
}
