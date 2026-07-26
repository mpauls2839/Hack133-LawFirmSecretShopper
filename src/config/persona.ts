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
  }),
  replyDelaySeconds: z.number().int().nonnegative().optional(),
  /** Optional website-intake prompt used upstream of the SMS secret shopper. */
  intakeAnalyst: intakeAnalystSchema.optional(),
});

export type PersonaConfig = z.infer<typeof personaConfigSchema>;
export type IntakeAnalystConfig = z.infer<typeof intakeAnalystSchema>;
