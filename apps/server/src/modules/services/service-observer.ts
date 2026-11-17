import { observeService } from "./observe-service.js";
import type { ServiceStore } from "./drizzle-service-store.js";
import type { ServiceTargetConfig } from "./service-config.js";

export function createServiceObserver(options: {
  targets: ServiceTargetConfig[];
  store: ServiceStore;
  observe?: typeof observeService;
  report: (event: {
    code: "SERVICE_OBSERVER_ERROR" | "SERVICE_OBSERVER_RECOVERED";
    targetKey: string;
  }) => void;
}) {
  const nextChecks = new Map(options.targets.map((target) => [target.key, new Date()]));
  const errors = new Set<string>();
  const lastReported = new Map<string, number>();
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const report = (event: Parameters<typeof options.report>[0]) => {
    try {
      options.report(event);
    } catch {
      /* 진단 실패가 관측 루프를 멈추지 않게 합니다. */
    }
  };

  function schedule() {
    if (stopped || !options.targets.length) return;
    const due = Math.min(
      ...options.targets.map((target) =>
        target.onDemand ? Date.now() + 1000 : nextChecks.get(target.key)!.getTime(),
      ),
    );
    timer = setTimeout(check, Math.max(0, due - Date.now()));
  }
  function check() {
    if (stopped || running) return;
    let inspectionRunIds: string[] = [];
    const target = options.targets
      .toSorted((a, b) => nextChecks.get(a.key)!.getTime() - nextChecks.get(b.key)!.getTime())
      .find((candidate) => {
        if (nextChecks.get(candidate.key)!.getTime() > Date.now()) return false;
        if (!candidate.onDemand) return true;
        try {
          options.store.assertOwner();
          const pending = options.store.inspections(candidate);
          if (!pending.runIds.length) return false;
          nextChecks.set(candidate.key, new Date(pending.nextCheckAt));
          if (pending.nextCheckAt > Date.now()) return false;
          inspectionRunIds = pending.runIds;
          return true;
        } catch {
          errors.add(candidate.key);
          nextChecks.set(candidate.key, new Date(Date.now() + candidate.intervalMs));
          report({ code: "SERVICE_OBSERVER_ERROR", targetKey: candidate.key });
          return false;
        }
      });
    if (!target) {
      schedule();
      return;
    }
    controller = new AbortController();
    const signal = controller.signal;
    running = (async () => {
      try {
        options.store.assertOwner();
        const result = await (options.observe ?? observeService)(target, signal);
        if (signal.aborted) return;
        options.store.save(target, result, inspectionRunIds);
        if (errors.delete(target.key)) {
          report({ code: "SERVICE_OBSERVER_RECOVERED", targetKey: target.key });
          lastReported.delete(target.key);
        }
      } catch {
        if (!signal.aborted) {
          errors.add(target.key);
          if (Date.now() - (lastReported.get(target.key) ?? -Infinity) >= 60000) {
            lastReported.set(target.key, Date.now());
            report({ code: "SERVICE_OBSERVER_ERROR", targetKey: target.key });
          }
        }
      } finally {
        nextChecks.set(target.key, new Date(Date.now() + target.intervalMs));
      }
    })().finally(() => {
      running = undefined;
      controller = undefined;
      schedule();
    });
  }
  return {
    start() {
      if (started || stopped) return;
      started = true;
      check();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      await running;
    },
    getStatus() {
      return {
        enabledKeys: new Set(
          started && !stopped ? options.targets.map((target) => target.key) : [],
        ),
        errors: new Set(errors),
        nextChecks: new Map(
          [...nextChecks].filter(
            ([key]) => !options.targets.find((target) => target.key === key)?.onDemand,
          ),
        ),
      };
    },
  };
}
