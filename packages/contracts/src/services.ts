import { object, nullable, enumeration, text, id, date } from "./schema.js";
import { Type, type Static } from "@sinclair/typebox";

export const serviceSnapshotSchema = object({
  observedAt: date,
  processState: enumeration(["running", "stopped", "unknown"] as const),
  activityState: enumeration(["working", "waiting", "degraded", "unknown"] as const),
  lastSuccessAt: nullable(date),
  nextExpectedAt: nullable(date),
  errorCount: Type.Integer({ minimum: 0, maximum: 2147483647 }),
  summary: Type.String({ maxLength: 500 }),
});
export type ServiceSnapshot = Static<typeof serviceSnapshotSchema>;
export const serviceObservationSchema = object({
  id,
  receivedAt: date,
  success: Type.Boolean(),
  errorCode: nullable(text),
  snapshot: nullable(serviceSnapshotSchema),
});
export type ServiceObservation = Static<typeof serviceObservationSchema>;
export const serviceStates = [
  "healthy",
  "waiting",
  "degraded",
  "stopped",
  "stale",
  "unavailable",
  "unknown",
] as const;
export type ServiceState = (typeof serviceStates)[number];
export const planningServiceSchema = object({
  key: text,
  name: text,
  enabled: Type.Boolean(),
  state: enumeration(serviceStates),
  reason: text,
  latest: nullable(serviceObservationSchema),
  lastSuccessful: nullable(serviceObservationSchema),
});
export type PlanningService = Static<typeof planningServiceSchema>;
export const serviceSchema = object({
  key: text,
  name: text,
  projectId: id,
  enabled: Type.Boolean(),
  intervalMs: Type.Integer(),
  staleAfterMs: Type.Integer(),
  allowWaiting: Type.Boolean(),
  activityTimeoutMs: nullable(Type.Integer()),
  state: enumeration(serviceStates),
  reason: text,
  nextCheckAt: nullable(date),
  latest: nullable(serviceObservationSchema),
  lastSuccessful: nullable(serviceObservationSchema),
});
export type Service = Static<typeof serviceSchema>;
export const servicesSchema = object({
  services: Type.Array(serviceSchema),
  checkedAt: date,
});
