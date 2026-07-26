import { z } from "zod";

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
});

export type PersonaConfig = z.infer<typeof personaConfigSchema>;
