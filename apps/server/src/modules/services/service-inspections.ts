import { and, eq, isNull } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { goals, runs, tasks, serviceInspections, serviceTargets } from "../../db/schema.js";
import type { ServiceTargetConfig } from "./service-config.js";
import { serviceConfigurationVersion } from "./service-config.js";

type Db = Pick<ReturnType<typeof openDatabase>["db"], "select" | "insert">;

// Called only inside planning completion's transaction, before it is accepted.
export function requestServiceInspections(
  db: Db,
  run: typeof runs.$inferSelect,
  keys: string[],
  now: Date,
): boolean {
  if (!keys.length) return true;
  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
  const approved: (typeof serviceTargets.$inferSelect)[] = [];
  for (const key of keys) {
    const supplied = run.planningInput?.services.find((service) => service.key === key);
    const current = db.select().from(serviceTargets).where(eq(serviceTargets.key, key)).get();
    if (
      !supplied?.enabled ||
      !supplied.onDemand ||
      !current?.configured ||
      !current.onDemand ||
      current.projectId !== task?.projectId ||
      supplied.configurationVersion !== serviceConfigurationVersion(current.fingerprint)
    )
      return false;
    approved.push(current);
  }
  for (const target of approved)
    db.insert(serviceInspections)
      .values({
        runId: run.id,
        targetKey: target.key,
        fingerprint: target.fingerprint,
        requestedAt: now,
      })
      .onConflictDoNothing()
      .run();
  return true;
}

// Paused/cancelled/revised goals and replaced configurations cannot dispatch old requests.
export function pendingServiceInspections(db: Pick<Db, "select">, target: ServiceTargetConfig) {
  return db
    .select({ runId: serviceInspections.runId })
    .from(serviceInspections)
    .innerJoin(runs, eq(runs.id, serviceInspections.runId))
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(goals, eq(goals.id, tasks.goalId))
    .innerJoin(serviceTargets, eq(serviceTargets.key, serviceInspections.targetKey))
    .where(
      and(
        eq(serviceInspections.targetKey, target.key),
        eq(serviceInspections.fingerprint, target.fingerprint),
        isNull(serviceInspections.completedAt),
        eq(tasks.projectId, target.projectId),
        eq(goals.projectId, target.projectId),
        eq(serviceTargets.projectId, target.projectId),
        eq(serviceTargets.fingerprint, target.fingerprint),
        eq(serviceTargets.configured, true),
        eq(serviceTargets.onDemand, true),
        eq(goals.version, runs.goalVersion),
        eq(goals.status, "active"),
        eq(runs.status, "succeeded"),
        eq(tasks.status, "succeeded"),
        isNull(tasks.cancelRequestedAt),
      ),
    )
    .limit(100)
    .all()
    .map((row) => row.runId);
}
