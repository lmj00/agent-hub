import type { NotificationConfig } from "./notification-config.js";
import { deliverNotification } from "./notification-delivery.js";
import type { createNotificationStore } from "./notification-store.js";

export function createNotificationWorker(options: {
  config: NotificationConfig;
  store: ReturnType<typeof createNotificationStore>;
  report: (event: {
    code: "NOTIFICATION_STORAGE_ERROR" | "NOTIFICATION_STORAGE_RECOVERED";
  }) => void;
}) {
  let started = false;
  let stopped = false;
  let storageError = false;
  let lastCheckedAt: string | null = null;
  let delivering = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const controller = new AbortController();
  const report = (code: Parameters<typeof options.report>[0]["code"]) => {
    try {
      options.report({ code });
    } catch {
      /* Logging is not a delivery dependency. */
    }
  };
  function tick() {
    if (stopped || running) return;
    running = (async () => {
      try {
        options.store.scan();
        const claim = options.store.claim();
        lastCheckedAt = new Date().toISOString();
        if (claim) {
          delivering = true;
          const result = await deliverNotification(
            options.config,
            claim.payload,
            controller.signal,
          );
          options.store.finish(claim.id, claim.attempt, result);
        }
        if (storageError) report("NOTIFICATION_STORAGE_RECOVERED");
        storageError = false;
      } catch {
        if (!storageError) report("NOTIFICATION_STORAGE_ERROR");
        storageError = true;
      } finally {
        delivering = false;
      }
    })().finally(() => {
      running = undefined;
      if (!stopped) timer = setTimeout(tick, options.config.pollIntervalMs);
    });
  }
  return {
    start() {
      if (!started && !stopped) {
        started = true;
        tick();
      }
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      await running;
    },
    getStatus() {
      return {
        enabled: started && !stopped,
        storageError,
        delivering,
        lastCheckedAt,
      };
    },
  };
}
