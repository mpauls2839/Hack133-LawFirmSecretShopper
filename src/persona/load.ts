/**
 * The fixed persona lives in config/persona.md so it can be edited without touching code.
 * Frontmatter carries the structured fields; `## Need`, `## Backstory` and the
 * `### Answer when` style subsections under `## Behavior rules` carry the prose.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config.ts';
import type { ChannelName, Persona } from '../domain/types.ts';

const DEFAULT_PATH = resolve(ROOT, 'config/persona.md');

function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return { meta, body: match[2] };
}

/** Strips HTML comments so the guidance block in persona.md never reaches a prompt. */
function stripComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, '');
}

function section(body: string, heading: string, level = 2): string {
  const hashes = '#'.repeat(level);
  // `$(?![\s\S])` is end-of-input; JS has no \Z, and using one silently truncates the
  // final section of the file.
  const re = new RegExp(
    `^${hashes}\\s+${heading}\\s*$([\\s\\S]*?)(?=^#{1,${level}}\\s|$(?![\\s\\S]))`,
    'im',
  );
  return (body.match(re)?.[1] ?? '').trim();
}

function bullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-') || l.startsWith('*'))
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadPersona(path = DEFAULT_PATH): Persona {
  if (!existsSync(path)) throw new Error(`persona file not found: ${path}`);
  const { meta, body: rawBody } = parseFrontmatter(readFileSync(path, 'utf8'));
  const body = stripComments(rawBody);
  const rules = section(body, 'Behavior rules');

  const persona: Persona = {
    id: meta.id || 'persona-fixed',
    name: meta.name || 'Unnamed Persona',
    contact: {
      email: meta.email || '',
      phone: meta.phone || '',
      preferred_channel: (meta.preferred_channel || 'sms') as ChannelName,
    },
    backstory: section(body, 'Backstory'),
    need: section(body, 'Need'),
    need_tags: list(meta.need_tags),
    urgency: meta.urgency || 'normal',
    budget: meta.budget || 'unspecified',
    behavior_rules: {
      answer_when: bullets(section(rules, 'Answer when', 3)),
      push_when: bullets(section(rules, 'Push when', 3)),
      go_quiet_when: bullets(section(rules, 'Go quiet when', 3)),
      never: bullets(section(rules, 'Never', 3)),
    },
  };

  if (!persona.need) throw new Error('persona.md is missing a "## Need" section');
  if (persona.need_tags.length === 0) throw new Error('persona.md frontmatter needs need_tags');
  return persona;
}
