import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { validateOrigin } from "./modules/auth/auth-config.js";
import { hashPassword } from "./modules/auth/password.js";

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      origin: { type: "string" },
      "password-stdin": { type: "boolean" },
    },
  });
  if (!values.config || !values.origin)
    throw new Error(
      "Usage: pnpm auth:setup --config .local/auth.json --origin http://127.0.0.1:3000 [--password-stdin]",
    );
  const origin = validateOrigin(values.origin);
  let password = randomBytes(24).toString("base64url");
  if (values["password-stdin"]) {
    if (process.stdin.isTTY)
      throw new Error("Provide the password through a pipe; interactive input is not echoed");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 1026) throw new Error("Password input is too long");
    }
    password = input.replace(/\r?\n$/, "");
  }
  const config = {
    version: 1,
    origin,
    sessionSecret: randomBytes(32).toString("hex"),
    password: await hashPassword(password),
  };
  const path = resolve(fileURLToPath(new URL("../../../", import.meta.url)), values.config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 기존 로그인 설정을 덮어쓰지 않습니다. 변경 시 새 파일을 만들고 서버 설정을 바꿉니다.
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(
    "Authentication config created. Set AUTH_CONFIG to this file when starting the server.",
  );
  if (!values["password-stdin"]) console.log(`Generated password (save it now): ${password}`);
}
main().catch(() => {
  console.error(
    "Unable to create authentication config. Check arguments, password length and that the target file does not already exist.",
  );
  process.exitCode = 1;
});
