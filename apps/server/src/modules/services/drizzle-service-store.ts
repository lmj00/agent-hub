import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Service, ServiceObservation } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { projects, serviceObservations, serviceTargets } from "../../db/schema.js";
import { assertExecutionOwner } from "../execution/execution-owner.js";
import { interpretObservation, type ObservationResult } from "./observe-service.js";
import type { ServiceTargetConfig } from "./service-config.js";

function observation(
  row: typeof serviceObservations.$inferSelect | undefined,
): ServiceObservation | null {
  return row
    ? {
        id: row.id,
        receivedAt: row.receivedAt.toISOString(),
        success: row.success,
        errorCode: row.errorCode,
        snapshot: row.snapshot,
      }
    : null;
}
export type ObserverStatus = {
  enabledKeys: ReadonlySet<string>;
  errors: ReadonlySet<string>;
  nextChecks: ReadonlyMap<string, Date>;
};

export function readServiceViews(
  db: Pick<ReturnType<typeof openDatabase>["db"], "select">,
  projectId: string,
  observer: ObserverStatus,
  now = new Date(),
  configuredOnly = false,
): Service[] {
  return db
    .select()
    .from(serviceTargets)
    .where(
      and(
        eq(serviceTargets.projectId, projectId),
        configuredOnly ? eq(serviceTargets.configured, true) : undefined,
      ),
    )
    .orderBy(serviceTargets.name, serviceTargets.key)
    .all()
    .map((target) => {
      const filter = and(
        eq(serviceObservations.targetKey, target.key),
        eq(serviceObservations.fingerprint, target.fingerprint),
      );
      const latest = observation(
        db
          .select()
          .from(serviceObservations)
          .where(filter)
          .orderBy(desc(serviceObservations.sequence))
          .get(),
      );
      const lastSuccessful = observation(
        db
          .select()
          .from(serviceObservations)
          .where(and(filter, eq(serviceObservations.success, true)))
          .orderBy(desc(serviceObservations.sequence))
          .get(),
      );
      const enabled = target.configured && observer.enabledKeys.has(target.key);
      const verdict = !enabled
        ? { state: "unknown" as const, reason: "observer_disabled" }
        : observer.errors.has(target.key)
          ? { state: "unknown" as const, reason: "observer_error" }
          : interpretObservation(target, latest, now);
      return {
        key: target.key,
        name: target.name,
        projectId: target.projectId,
        enabled,
        intervalMs: target.intervalMs,
        staleAfterMs: target.staleAfterMs,
        allowWaiting: target.allowWaiting,
        activityTimeoutMs: target.activityTimeoutMs,
        ...verdict,
        nextCheckAt: enabled ? (observer.nextChecks.get(target.key)?.toISOString() ?? null) : null,
        latest,
        lastSuccessful,
      };
    });
}

export function createDrizzleServiceStore(
  db: ReturnType<typeof openDatabase>["db"],
  ownerToken?: string,
) {
  return {
    assertOwner() {
      assertExecutionOwner(db, ownerToken);
    },
    configure(targets: ServiceTargetConfig[]) {
      db.transaction(
        (tx) => {
          assertExecutionOwner(tx, ownerToken);
          for (const target of targets) {
            if (
              !tx
                .select({ id: projects.id })
                .from(projects)
                .where(eq(projects.id, target.projectId))
                .get()
            )
              throw new Error("Service target references an unknown project");
          }
          tx.update(serviceTargets).set({ configured: false }).run();
          for (const target of targets) {
            const row = {
              key: target.key,
              projectId: target.projectId,
              name: target.name,
              fingerprint: target.fingerprint,
              configured: true,
              intervalMs: target.intervalMs,
              staleAfterMs: target.staleAfterMs,
              allowWaiting: target.allowWaiting,
              activityTimeoutMs: target.activityTimeoutMs,
            };
            tx.insert(serviceTargets)
              .values(row)
              .onConflictDoUpdate({ target: serviceTargets.key, set: row })
              .run();
          }
        },
        { behavior: "immediate" },
      );
    },
    save(target: ServiceTargetConfig, result: ObservationResult) {
      db.transaction(
        (tx) => {
          assertExecutionOwner(tx, ownerToken);
          const configured = tx
            .select()
            .from(serviceTargets)
            .where(eq(serviceTargets.key, target.key))
            .get();
          if (!configured?.configured || configured.fingerprint !== target.fingerprint)
            throw new Error("Service observation target configuration changed");
          tx.insert(serviceObservations)
            .values({
              id: randomUUID(),
              targetKey: target.key,
              fingerprint: target.fingerprint,
              ...result,
            })
            .run();
          // 최근 1000건과 마지막 성공 기록을 남겨 장기 운영 시에도 보관량을 제한합니다.
          tx.run(sql`DELETE FROM service_observations WHERE sequence IN (
          SELECT sequence FROM service_observations WHERE target_key = ${target.key} ORDER BY sequence DESC LIMIT -1 OFFSET 1000
        ) AND sequence <> COALESCE((SELECT sequence FROM service_observations WHERE target_key = ${target.key} AND success = 1 ORDER BY sequence DESC LIMIT 1), -1)`);
        },
        { behavior: "immediate" },
      );
    },
    list(projectId: string, observer: ObserverStatus, now = new Date()): Service[] {
      return readServiceViews(db, projectId, observer, now);
    },
  };
}
export type ServiceStore = ReturnType<typeof createDrizzleServiceStore>;
