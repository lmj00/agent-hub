import { BackupError } from "./modules/operations/backup-files.js";
import { parseArgs } from "node:util";
import {
  createStateBackup,
  inspectStateBackup,
  previewStateRestore,
  restoreStateBackup,
} from "./modules/operations/state-backup.js";

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      database: { type: "string" },
      destination: { type: "string" },
      backup: { type: "string" },
      apply: { type: "boolean" },
    },
  });
  const action = positionals[0];
  if (
    positionals.length !== 1 ||
    !["create", "inspect", "restore"].includes(action ?? "") ||
    (action === "create" &&
      (!values.database ||
        !values.destination ||
        values.backup ||
        values.apply)) ||
    (action === "inspect" &&
      (!values.backup ||
        values.database ||
        values.destination ||
        values.apply)) ||
    (action === "restore" &&
      (!values.backup || !values.database || values.destination))
  )
    throw new Error(
      "Use backup create --database PATH --destination PATH; inspect --backup PATH; or restore --backup PATH --database ORIGINAL_PATH [--apply]",
    );
  const cancelled = new AbortController();
  const stop = () =>
    cancelled.abort(new BackupError("Backup operation cancelled"));
  const signal = AbortSignal.any([
    cancelled.signal,
    AbortSignal.timeout(10 * 60 * 1000),
  ]);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const manifest =
      action === "create"
        ? await createStateBackup(values.database!, values.destination!, signal)
        : action === "inspect"
          ? await inspectStateBackup(values.backup!, signal)
          : values.apply
            ? await restoreStateBackup(values.backup!, values.database!, signal)
            : await previewStateRestore(
                values.backup!,
                values.database!,
                signal,
              );
    // Paths are for this operator's review. Contents, credentials and model output never go to stdout.
    console.log(
      JSON.stringify({
        action:
          action === "restore" && !values.apply ? "restore-preview" : action,
        createdAt: manifest.createdAt,
        originalDatabasePath: manifest.databasePath,
        schemaDigest: manifest.schemaDigest,
        files: manifest.entries.filter((entry) => entry.kind === "file").length,
        bytes: manifest.entries.reduce(
          (sum, entry) => sum + (entry.kind === "file" ? entry.bytes : 0),
          0,
        ),
      }),
    );
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
main().catch((error: unknown) => {
  // Only controlled errors have safe public messages; native filesystem/Git/SQLite errors can contain private paths or records.
  console.error(
    error instanceof BackupError ||
      (error instanceof Error && error.message.startsWith("Use backup "))
      ? error.message
      : "Backup operation failed. Check private paths, compatibility, integrity and that all execution is stopped and reconciled.",
  );
  process.exitCode = 1;
});
