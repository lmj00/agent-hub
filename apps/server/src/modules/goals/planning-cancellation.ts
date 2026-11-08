import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { goalRevisions, goals, tasks } from "../../db/schema.js";

type Db = Pick<ReturnType<typeof openDatabase>["db"], "select" | "insert" | "update">;

// The user's plan cancellation and Goal pause are one durable decision.
export function pauseCancelledPlan(
  db: Db,
  task: typeof tasks.$inferSelect,
  requestKey: string,
  now: Date,
) {
  if (task.kind !== "planning" || !task.goalId) return;
  const goal = db.select().from(goals).where(eq(goals.id, task.goalId)).get();
  if (!goal || goal.status !== "active") return;
  const version = goal.version + 1;
  db.update(goals)
    .set({ version, status: "paused", nextCheckAt: null, updatedAt: now })
    .where(eq(goals.id, goal.id))
    .run();
  db.insert(goalRevisions)
    .values({
      goalId: goal.id,
      version,
      requestKey: `cancel-plan:${task.id}:${requestKey}`,
      commandHash: createHash("sha256")
        .update(JSON.stringify(["cancel-plan", task.id, requestKey]))
        .digest("hex"),
      snapshot: {
        id: goal.id,
        projectId: goal.projectId,
        definition: goal.definition,
        status: "paused",
        version,
        nextCheckAt: null,
        createdAt: goal.createdAt.toISOString(),
        updatedAt: now.toISOString(),
      },
    })
    .run();
}
