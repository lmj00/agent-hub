import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export type PasswordHash = { salt: string; hash: string };
// OWASP가 제시한 scrypt 조합 중 메모리 32 MiB, 병렬화 계수 3을 사용합니다.
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, Buffer.from(salt, "hex"), 64,
    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<PasswordHash> {
  if (password.length < 12 || Buffer.byteLength(password) > 1024) throw new Error("Password must contain at least 12 characters and at most 1024 bytes");
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: (await derive(password, salt)).toString("hex") };
}
export async function verifyPassword(password: string, stored: PasswordHash) {
  if (Buffer.byteLength(password) > 1024) return false;
  return timingSafeEqual(await derive(password, stored.salt), Buffer.from(stored.hash, "hex"));
}
