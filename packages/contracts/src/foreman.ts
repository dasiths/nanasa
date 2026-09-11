import { z } from "zod";
import { ForemanConfigSchema } from "./config.js";
import { ForemanActorSchema, ForemanRunSchema, IdentifierSchema } from "./control.js";

export const ForemanWorkspaceSchema = z
  .object({
    configuration: ForemanConfigSchema.optional(),
    actor: ForemanActorSchema.optional(),
    run: ForemanRunSchema.optional(),
    configRevision: z.string().min(1).optional(),
    problem: z.string().max(1000).optional(),
  })
  .strict();
export type ForemanWorkspace = z.infer<typeof ForemanWorkspaceSchema>;

export const ConfigureForemanCommandSchema = z
  .object({
    configuration: ForemanConfigSchema,
    expectedConfigRevision: z.string().min(1).max(128),
  })
  .strict();
export type ConfigureForemanCommand = z.infer<typeof ConfigureForemanCommandSchema>;

export const StartForemanCommandSchema = z
  .object({
    expectedConfigRevision: z.string().min(1).max(128),
    cols: z.number().int().min(20).max(500).default(120),
    rows: z.number().int().min(5).max(200).default(36),
  })
  .strict();
export type StartForemanCommand = z.infer<typeof StartForemanCommandSchema>;

export const StopForemanCommandSchema = z
  .object({
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
  })
  .strict();
export type StopForemanCommand = z.infer<typeof StopForemanCommandSchema>;
