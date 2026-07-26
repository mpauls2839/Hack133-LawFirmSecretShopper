/**
 * Qualification is derived, never hand-tagged (spec 4.3): persona need tags against the
 * services the target's own copy advertises. One pasted URL therefore yields both the
 * target and its correct label, and the same persona flips label for free on a different
 * business.
 */
import type { Persona, Target } from './types.ts';

export type Qualification = {
  qualified: boolean;
  reason: string;
  confidence: 'high' | 'low';
  matched: string[];
};

/** Categories where a legal need is at least plausibly in scope. */
const LEGAL_CATEGORIES = new Set(['law_firm', 'legal_services']);
const LEGAL_TAG = /_(?:injury|accident|liability|death|malpractice|law|comp|defense|planning)$|^(immigration|bankruptcy|probate|civil_rights|social_security|tax_law|nursing_home)$/;

export function qualify(persona: Persona, target: Target): Qualification {
  const need = new Set(persona.need_tags);
  const matched = target.services.filter((s) => need.has(s));

  if (matched.length > 0) {
    return {
      qualified: true,
      reason: `target advertises ${matched.join(', ')}, which matches persona need tags`,
      confidence: 'high',
      matched,
    };
  }

  if (target.services.length === 0) {
    // Nothing extracted. Fall back to category so a thin site is not mislabelled as a
    // clean decline, and mark it low confidence so the scorecard can discount it.
    const personaIsLegal = [...need].some((tag) => LEGAL_TAG.test(tag));
    const plausible = personaIsLegal && LEGAL_CATEGORIES.has(target.category ?? '');
    return {
      qualified: plausible,
      reason: plausible
        ? `no service list extracted; category ${target.category} plausibly covers the persona need`
        : 'no service list extracted and category does not cover the persona need',
      confidence: 'low',
      matched: [],
    };
  }

  return {
    qualified: false,
    reason: `target advertises ${target.services.slice(0, 6).join(', ')}, none matching persona need tags (${[...need].join(', ')})`,
    confidence: 'high',
    matched: [],
  };
}
