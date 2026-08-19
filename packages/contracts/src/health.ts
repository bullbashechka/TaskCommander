import { z } from 'zod';

export const runtimeSubsystems = ['runtime', 'queue', 'r2', 'cron', 'supabase', 'bitrix'] as const;

export const runtimeReadinessStates = ['ready', 'degraded'] as const;

export const runtimeSubsystemStatuses = [
  'ready',
  'not_configured',
  'invalid_configuration',
] as const;

export const livenessResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .strict();

export const healthResponseSchema = z
  .object({
    status: z.literal('ok'),
    service: z.literal('task-commander-api'),
    readiness: z.enum(runtimeReadinessStates),
    subsystems: z
      .object({
        runtime: z.enum(runtimeSubsystemStatuses),
        queue: z.enum(runtimeSubsystemStatuses),
        r2: z.enum(runtimeSubsystemStatuses),
        cron: z.enum(runtimeSubsystemStatuses),
        supabase: z.enum(runtimeSubsystemStatuses),
        bitrix: z.enum(runtimeSubsystemStatuses),
      })
      .strict(),
  })
  .strict();

export type RuntimeSubsystem = (typeof runtimeSubsystems)[number];
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;
export type RuntimeReadinessState = (typeof runtimeReadinessStates)[number];
export type RuntimeSubsystemStatus = (typeof runtimeSubsystemStatuses)[number];
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const healthResponse: HealthResponse = {
  status: 'ok',
  service: 'task-commander-api',
  readiness: 'degraded',
  subsystems: {
    runtime: 'ready',
    queue: 'ready',
    r2: 'ready',
    cron: 'ready',
    supabase: 'not_configured',
    bitrix: 'ready',
  },
};

export const livenessResponse: LivenessResponse = {
  status: 'ok',
};

export function isLivenessResponse(value: unknown): value is LivenessResponse {
  return livenessResponseSchema.safeParse(value).success;
}

export function isHealthResponse(value: unknown): value is HealthResponse {
  return healthResponseSchema.safeParse(value).success;
}
