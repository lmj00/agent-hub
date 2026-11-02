import { and, eq, gt, lte } from "drizzle-orm";
import type { Session } from "fastify";
import type { SessionStore } from "@fastify/session";
import type { openDatabase } from "../../db/connection.js";
import { authSessions } from "../../db/schema.js";

function missing() { return Object.assign(new Error("Session no longer exists"), { code: "ENOENT" }); }
function unavailable() { return new Error("Session storage unavailable"); }
function values(id: string, session: Session) {
  const metadata = session as Session & { __fastifySessionMetadata?: { generation: string } };
  const expiry = session.expiresAt ?? new Date(session.cookie.expires ?? 0).getTime();
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw missing();
  return { id, generation: metadata.__fastifySessionMetadata?.generation ?? id, data: JSON.stringify(session), expiresAt: new Date(expiry) };
}

export function createDrizzleSessionStore(db: ReturnType<typeof openDatabase>["db"]): SessionStore {
  return {
    set(id, session, callback) {
      try {
        db.transaction(tx => {
          tx.delete(authSessions).where(lte(authSessions.expiresAt, new Date())).run();
          tx.insert(authSessions).values(values(id, session)).run();
        });
      } catch { callback(unavailable()); return; }
      callback();
    },
    get(id, callback) {
      let result: Session | null = null;
      try {
        const row = db.select().from(authSessions).where(eq(authSessions.id, id)).get();
        if (row && row.expiresAt.getTime() <= Date.now()) {
          db.delete(authSessions).where(and(eq(authSessions.id, id), lte(authSessions.expiresAt, new Date()))).run();
        } else if (row) result = JSON.parse(row.data) as Session;
      } catch { callback(unavailable()); return; }
      callback(null, result);
    },
    compareAndSet(id, generation, session, callback) {
      let changed: boolean;
      try {
        const result = db.update(authSessions).set(values(id, session))
          .where(and(eq(authSessions.id, id), eq(authSessions.generation, generation), gt(authSessions.expiresAt, new Date()))).run();
        changed = result.changes === 1;
      } catch { callback(unavailable()); return; }
      callback(changed ? undefined : missing());
    },
    destroy(id, callback) {
      try { db.delete(authSessions).where(eq(authSessions.id, id)).run(); }
      catch { callback(unavailable()); return; }
      callback();
    },
  };
}
