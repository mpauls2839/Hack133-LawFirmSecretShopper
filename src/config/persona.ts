import { z } from "zod";

export const intakeAnalystSchema = z.object({
  role: z.string().min(1),
  instructions: z.string().min(1),
  output_schema: z.record(z.unknown()),
  error_shape: z.record(z.unknown()).optional(),
  rules: z.array(z.string()).default([]),
  channel_preference_order: z.array(z.string()).default([]),
  channel_types: z.array(z.string()).default([]),
});

/** Structured case details the SMS agent can reveal progressively when asked. */
export const caseFactsSchema = z.object({
  incidentDate: z.string().optional(),
  location: z.string().optional(),
  howItHappened: z.string().optional(),
  otherDriver: z.string().optional(),
  injuries: z.array(z.string()).optional(),
  medicalTreatment: z.string().optional(),
  vehicleDamage: z.string().optional(),
  policeReport: z.string().optional(),
  insuranceStatus: z.string().optional(),
  currentConcerns: z.string().optional(),
  availability: z.string().optional(),
});

export const personaBackgroundSchema = z.object({
  occupation: z.string().optional(),
  situation: z.string().optional(),
});

export const personaConfigSchema = z.object({
  campaignId: z.string().min(1),
  firmName: z.string().min(1),
  firmPhone: z.string().min(5),
  fromPhone: z.string().min(5).optional(),
  initialMessage: z.string().min(1),
  persona: z.object({
    name: z.string().min(1),
    summary: z.string().min(1),
    problem: z.string().min(1),
    goals: z.array(z.string()).default([]),
    tone: z.string().default("polite and concise"),
    /** Concrete case facts for grounded, consistent answers. */
    caseFacts: caseFactsSchema.optional(),
    /** Optional persona background (occupation, life situation). */
    background: personaBackgroundSchema.optional(),
    /** How to reveal details, e.g. "reveal one or two specifics per message when asked". */
    disclosureStyle: z.string().optional(),
  }),
  replyDelaySeconds: z.number().int().nonnegative().optional(),
  /** Optional website-intake prompt used upstream of the SMS secret shopper. */
  intakeAnalyst: intakeAnalystSchema.optional(),
});

export type PersonaConfig = z.infer<typeof personaConfigSchema>;
export type IntakeAnalystConfig = z.infer<typeof intakeAnalystSchema>;
export type CaseFacts = z.infer<typeof caseFactsSchema>;
export type PersonaBackground = z.infer<typeof personaBackgroundSchema>;
