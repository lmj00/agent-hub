import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";

export function readPrivateJson(path: string, label: string, maxBytes = 8192) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: unknown;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077) !== 0)
      throw new Error(`${label} must be a private regular file (chmod 600)`);
    try {
      value = JSON.parse(readFileSync(descriptor, "utf8"));
    } catch {
      throw new Error(`${label} must contain valid JSON`);
    }
  } finally {
    closeSync(descriptor);
  }
  return { value, sourcePath: realpathSync(path) };
}
