import { isAbsolute, relative, sep } from "node:path";

export function isWithin(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
