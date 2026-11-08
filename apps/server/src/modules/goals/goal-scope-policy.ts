import type { GoalDefinition } from "@agent-hub/contracts";

type Scope = Pick<GoalDefinition, "allowedPaths" | "excludedPaths">;
const contains = (parent: string, child: string) =>
  parent === "." || child === parent || child.startsWith(`${parent}/`);

// Definitions already contain normalized relative paths. Compare permissions,
// not just currently existing files: a newly excluded directory also revokes
// permission to create or read its future contents.
export function narrowsGoalScope(previous: Scope, next: Scope): boolean {
  return previous.allowedPaths.some((allowed) => {
    if (previous.excludedPaths.some((excluded) => contains(excluded, allowed))) return false;
    if (!next.allowedPaths.some((parent) => contains(parent, allowed))) return true;
    return next.excludedPaths.some((excluded) => {
      if (!contains(allowed, excluded) && !contains(excluded, allowed)) return false;
      const intersection = contains(allowed, excluded) ? excluded : allowed;
      return !previous.excludedPaths.some((parent) => contains(parent, intersection));
    });
  });
}
