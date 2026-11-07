import { createHash } from "node:crypto";
import type { changeApplications } from "../../db/schema.js";
import {
  assertDevelopmentBase,
  assertDevelopmentRepository,
  developmentRef,
  verifyDevelopmentCandidate,
  type DevelopmentRepository,
  type DevelopmentInput,
  type DevelopmentCandidate,
} from "./development-workspace.js";
import { git } from "./workspace-git.js";

type Application = typeof changeApplications.$inferSelect;
type CommitInput = Pick<
  Application,
  "id" | "baseRevision" | "tree" | "createdAt"
>;

// Fixed identity, message and timestamp make retries produce the SAME object.
// Computing the object ID performs no Git write; it precedes the durable intent.
export function applicationCommit(input: CommitInput) {
  const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  const timestamp = Math.floor(input.createdAt.getTime() / 1000);
  if (
    !/^[a-f0-9-]{36}$/.test(input.id) ||
    !oid.test(input.baseRevision) ||
    !oid.test(input.tree) ||
    input.baseRevision.length !== input.tree.length ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  )
    throw new Error("Invalid change application commit");
  const identity = `agent-hub <agent-hub@localhost> ${timestamp} +0000`;
  const body = Buffer.from(
    [
      `tree ${input.tree}`,
      `parent ${input.baseRevision}`,
      `author ${identity}`,
      `committer ${identity}`,
      "",
      `agent-hub change ${input.id}`,
      "",
    ].join("\n"),
  );
  const oidValue = createHash(
    input.baseRevision.length === 40 ? "sha1" : "sha256",
  )
    .update(`commit ${body.length}\0`)
    .update(body)
    .digest("hex");
  return { body, oid: oidValue };
}

// Git I/O stays outside SQLite transactions. A lost response is not evidence of
// failure: callers keep the intent and reconcile this same object on restart.
export async function applyGitChange(
  application: Application,
  repository: DevelopmentRepository,
  input: DevelopmentInput,
  candidate: DevelopmentCandidate,
  signal: AbortSignal,
) {
  const commit = applicationCommit(application);
  if (
    application.targetRef !== developmentRef ||
    application.resultCommit !== commit.oid ||
    application.repositoryId !== repository.id ||
    application.runId !== candidate.runId ||
    application.candidateDigest !== candidate.digest ||
    application.baseRevision !== candidate.baseRevision ||
    application.tree !== candidate.tree ||
    repository.head !== application.baseRevision
  )
    throw new Error("Change application identity changed");
  const storage = await assertDevelopmentRepository(repository, signal);
  const refs = (
    await git(
      storage,
      [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(symref)",
        developmentRef,
      ],
      signal,
    )
  )
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\0"));
  const ref = refs.find((parts) => parts[0] === developmentRef);
  if (
    !ref ||
    ref[2] !== "" ||
    (ref[1] !== application.baseRevision && ref[1] !== application.resultCommit)
  )
    throw new Error(
      "Development branch changed outside the recorded application",
    );
  if (ref[1] === application.baseRevision) {
    await verifyDevelopmentCandidate(repository, input, candidate, signal);
    const written = (
      await git(
        storage,
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        signal,
        commit.body,
      )
    )
      .toString()
      .trim();
    if (written !== application.resultCommit)
      throw new Error("Change application commit does not match intent");
    // --no-deref prevents a concurrently substituted symbolic ref from redirecting
    // this operation to another branch. The expected old OID fences stale writers.
    await git(
      storage,
      [
        "update-ref",
        "--no-deref",
        developmentRef,
        application.resultCommit,
        application.baseRevision,
      ],
      signal,
    );
  }
  const updated = {
    ...repository,
    head: application.resultCommit,
    headTree: application.tree,
  };
  await assertDevelopmentBase(updated, signal);
  const actual = await git(
    storage,
    ["cat-file", "commit", application.resultCommit],
    signal,
  );
  if (!actual.equals(commit.body))
    throw new Error("Applied commit does not match verified change");
  return updated;
}
