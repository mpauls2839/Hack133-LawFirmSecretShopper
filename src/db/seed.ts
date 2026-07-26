/** Re-seeds the fixed persona from config/persona.md on every boot. */
import { personas } from './repo.ts';
import { logEvent } from './index.ts';
import { loadPersona } from '../persona/load.ts';
import type { Persona } from '../domain/types.ts';

export function seedPersona(path?: string): Persona {
  const persona = loadPersona(path);
  const saved = personas.upsert(persona);
  logEvent(null, 'persona_seeded', {
    id: saved.id,
    name: saved.name,
    need_tags: saved.need_tags,
  });
  return saved;
}
