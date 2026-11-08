import type { createCreationStore } from "./creation-store.js";
import type { createImportStore } from "./import-store.js";
import { GitHubError, type createGitHubClient } from "./github-client.js";

export function createCreationWorker(options: {
  store: ReturnType<typeof createCreationStore>;
  imports: ReturnType<typeof createImportStore>;
  client: Pick<ReturnType<typeof createGitHubClient>, "createRepository" | "isBusy">;
  profiles: ReadonlySet<string>;
  wakeImporter: () => void;
  report: () => void;
}) {
  let stopping = false,
    pending: Promise<void> | undefined,
    timer: ReturnType<typeof setInterval> | undefined;
  let active: AbortController | undefined;
  async function tick() {
    const existing = options.store.nextCreated();
    if (existing) {
      try {
        const imported = options.imports.register({
          requestKey: existing.id,
          repositoryId: existing.repositoryId!,
          name: existing.name,
          profile: existing.profile,
        });
        options.store.link(existing, imported.id);
        options.wakeImporter();
      } catch {
        options.store.linkFailed(existing);
      }
      return;
    }
    if (options.client.isBusy()) return;
    const job = options.store.claim();
    if (!job) return;
    if (!options.profiles.has(job.profile)) {
      options.store.fail(job, "CREATION_PROFILE_UNAVAILABLE");
      return;
    }
    const controller = new AbortController();
    active = controller;
    try {
      const result = await options.client.createRepository(
        job.repositoryName,
        controller.signal,
        () => options.store.dispatch(job),
      );
      // Even shutdown after the response must preserve the known remote identity.
      options.store.created(job, result);
    } catch (error) {
      options.store.fail(job, error instanceof GitHubError ? error.code : "CREATION_INTERRUPTED");
    } finally {
      active = undefined;
    }
  }
  function wake() {
    if (stopping || pending) return;
    pending = tick()
      .catch(() => options.report())
      .finally(() => {
        pending = undefined;
      });
  }
  return {
    wake,
    start() {
      if (timer) return;
      stopping = false;
      wake();
      timer = setInterval(wake, 1000);
      timer.unref();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      active?.abort();
      await pending;
    },
  };
}
