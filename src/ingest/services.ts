/**
 * The only fuzzy part of ingest: what does this business actually do. Model first,
 * keyword scan as fallback, and the keyword scan always runs so the model result can be
 * unioned with it rather than trusted blindly.
 */
import { config } from '../config.ts';
import { chatJson } from '../judge/llm.ts';

/** tag -> phrases that imply it. Tags are what qualification compares against. */
export const SERVICE_TAXONOMY: Record<string, RegExp> = {
  personal_injury: /personal injury|injury (?:lawyer|attorney)|accident (?:lawyer|attorney)|catastrophic injury/i,
  car_accident: /car accident|auto accident|motor vehicle (?:accident|collision)|rideshare accident/i,
  truck_accident: /truck(?:ing)? accident|18[- ]wheeler|semi[- ]truck|commercial vehicle accident/i,
  motorcycle_accident: /motorcycle (?:accident|crash)/i,
  premises_liability: /slip and fall|trip and fall|premises liability|dog bite/i,
  wrongful_death: /wrongful death/i,
  medical_malpractice: /medical malpractice|birth injury|surgical error|misdiagnos/i,
  nursing_home: /nursing home (?:abuse|neglect)|elder abuse/i,
  product_liability: /product liability|defective product|mass tort/i,
  workers_comp: /workers?[' ]?\s*comp(?:ensation)?|work(?:place)? injury|injured (?:at|on) the job/i,
  family_law: /family law|divorce|child (?:custody|support)|alimony|prenup/i,
  criminal_defense: /criminal defense|dui|dwi|felony|misdemeanor|expungement/i,
  immigration: /immigration|green card|visa|asylum|deportation|naturalization/i,
  estate_planning: /estate planning|wills?(?: and | & )trusts?|probate|power of attorney/i,
  bankruptcy: /bankruptcy|chapter (?:7|11|13)|debt relief/i,
  employment_law: /employment law|wrongful termination|discrimination|harassment claim|wage (?:and|&) hour/i,
  business_law: /business (?:law|litigation)|corporate law|contract (?:dispute|review)|llc formation/i,
  real_estate_law: /real estate (?:law|closing|attorney)|landlord[- ]tenant|eviction|title dispute/i,
  intellectual_property: /trademark|patent|copyright|intellectual property/i,
  social_security: /social security disability|ssdi|ssi (?:claim|benefits)/i,
  tax_law: /tax (?:law|attorney|resolution)|irs (?:dispute|audit)/i,
  civil_rights: /civil rights|police misconduct|section 1983/i,
  // a few non-legal service categories so the tool is not law-firm-only
  plumbing: /plumb(?:er|ing)|drain cleaning|water heater/i,
  hvac: /hvac|air conditioning|furnace|heating (?:and|&) cooling/i,
  roofing: /roof(?:er|ing)|shingle|roof replacement/i,
  dental: /dentist|dental|orthodont|invisalign/i,
  auto_repair: /auto repair|mechanic|collision (?:center|repair)|body shop/i,
};

const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/\b(law (?:firm|office|group)|attorney|lawyer|legal|esq\.?|counsel(?:lors)?)\b/i, 'law_firm'],
  [/\b(dentist|dental|orthodont)\b/i, 'dental_practice'],
  [/\b(plumb|hvac|roofing|electrician|contractor)\b/i, 'home_services'],
  [/\b(clinic|medical center|physician|urgent care)\b/i, 'medical_practice'],
  [/\b(agency|marketing|consult)\b/i, 'professional_services'],
];

export function keywordServices(text: string): string[] {
  const found: string[] = [];
  for (const [tag, re] of Object.entries(SERVICE_TAXONOMY)) if (re.test(text)) found.push(tag);
  return found;
}

export function keywordCategory(text: string): string {
  for (const [re, category] of CATEGORY_RULES) if (re.test(text)) return category;
  return 'unknown';
}

type ModelServices = { category?: string; services?: string[] };

export async function extractServices(
  pageText: string,
  businessName: string | null,
): Promise<{ category: string; services: string[]; source: string }> {
  const deterministic = keywordServices(pageText);
  const category = keywordCategory(pageText);

  const model = await chatJson<ModelServices>({
    model: config.llm.fastModel,
    tag: 'ingest_services',
    maxTokens: 400,
    system:
      'You read website copy for a service business and report what it handles. ' +
      `Choose service tags only from this list: ${Object.keys(SERVICE_TAXONOMY).join(', ')}. ` +
      'Shape: { "category": string, "services": string[] }. Omit anything the copy does not support.',
    user: `Business: ${businessName ?? 'unknown'}\n\nPage copy (truncated):\n${pageText.slice(0, 6000)}`,
  });

  if (!model) return { category, services: deterministic, source: 'keywords' };

  const allowed = new Set(Object.keys(SERVICE_TAXONOMY));
  const modelTags = (model.services ?? []).filter((s) => allowed.has(s));
  const union = [...new Set([...deterministic, ...modelTags])];
  return {
    category: model.category?.trim() || category,
    services: union,
    source: modelTags.length ? 'model+keywords' : 'keywords',
  };
}
