export function loadConfig(env: NodeJS.ProcessEnv) {
  const portText = env.PORT ?? "3000";
  const port = Number(portText);

  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return { host: "127.0.0.1", port };
}
