import { sql } from "drizzle-orm";
import { runs } from "../../db/schema.js";

// A stopped status alone does not prove that the execution released its resources.
export const unresolvedRun = sql`${runs.status} = 'running' OR (${runs.status} IN ('interrupted', 'blocked', 'waiting_capacity') AND ${runs.terminationConfirmedAt} IS NULL)`;
