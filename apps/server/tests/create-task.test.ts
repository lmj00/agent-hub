import { expect, test, vi } from "vitest";
import { createTask, type Task, type TaskStore } from "../src/modules/tasks/create-task.js";

const saved: Task = {
  id: "saved-task",
  projectId: "project",
  instruction: "Inspect the project",
  requestKey: "request-1",
  status: "queued",
  createdAt: new Date("2026-11-01T00:00:00Z"),
};

function existingStore(): TaskStore {
  return {
    register: vi.fn(() => ({ task: saved, created: false })),
    listByProject: () => [saved],
    findById: () => saved,
  };
}

test("rejects a missing project before calling task storage", () => {
  const store = existingStore();
  expect(() => createTask("missing", saved, store, () => false)).toThrow("Project not found");
  expect(store.register).not.toHaveBeenCalled();
});

test("accepts an equivalent retry after trimming surrounding instruction whitespace", () => {
  const result = createTask(
    "project",
    { ...saved, instruction: ` \n${saved.instruction}\n ` },
    existingStore(),
    () => true,
  );
  expect(result).toEqual({ task: saved, created: false });
});

test("rejects reuse of a request key for a different instruction", () => {
  expect(() =>
    createTask(
      "project",
      { ...saved, instruction: "Change the project" },
      existingStore(),
      () => true,
    ),
  ).toThrow("Request key already used for a different instruction");
  expect(saved.instruction).toBe("Inspect the project");
});
