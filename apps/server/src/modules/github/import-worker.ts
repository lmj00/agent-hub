import { createImportStore } from "./import-store.js";
import type { importRuntime } from "./import-runtime.js";
import { ImportError, prepareImportedSource } from "./import-workspace.js";
import { GitHubError, type createGitHubClient } from "./github-client.js";

export function createImportWorker(options: {
  store: ReturnType<typeof createImportStore>;
  runtime: ReturnType<typeof importRuntime>;
  client: Pick<ReturnType<typeof createGitHubClient>, "downloadRepository">;
  report: () => void;
}) {
  let stopping = false,
    pending: Promise<void> | undefined,
    timer: ReturnType<typeof setInterval> | undefined;
  let active: { id: string; controller: AbortController } | undefined;
  async function tick() {
    const job = options.store.claim();
    if (!job) return;
    const controller = new AbortController();
    active = { id: job.id, controller };
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
    try {
      const source = await options.client.downloadRepository(job.repositoryId, signal);
      signal.throwIfAborted();
      const prepared = await prepareImportedSource(
        options.runtime.root,
        {
          jobId: job.id,
          attemptId: job.attemptId!,
          repositoryId: job.repositoryId,
          revision: source.revision,
        },
        source.archive,
        signal,
      );
      signal.throwIfAborted();
      const activate = options.runtime.prepare(job, prepared.workspace);
      if (
        options.store.finish(job, {
          fullName: source.fullName,
          revision: source.revision,
          localRevision: prepared.localRevision,
        })
      )
        activate();
    } catch (error) {
      options.store.fail(
        job,
        error instanceof ImportError || error instanceof GitHubError
          ? error.code
          : stopping
            ? "IMPORT_INTERRUPTED"
            : signal.aborted
              ? "IMPORT_TIMEOUT"
              : "IMPORT_FAILED",
      );
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
    cancel(id: string) {
      if (active?.id === id) active.controller.abort();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      active?.controller.abort();
      await pending;
    },
  };
}
