import { randomUUID } from "node:crypto";

export type CreateTaskInput = {
  instruction: string;
  requestKey: string;
};

export type Task = CreateTaskInput & {
  id: string;
  projectId: string;
  status: "queued";
  createdAt: Date;
};

export type TaskRegistration = { task: Task; created: boolean };

export type TaskStore = {
  // 같은 프로젝트·요청 키는 한 건만 저장하고, 이미 있으면 기존 기록을 반환합니다.
  register(task: Task): TaskRegistration;
  listByProject(projectId: string): Task[];
  findById(id: string): Task | undefined;
};

export class TaskRegistrationError extends Error {
  constructor(public readonly code: "PROJECT_NOT_FOUND" | "REQUEST_KEY_CONFLICT") {
    super(code === "PROJECT_NOT_FOUND" ? "Project not found" : "Request key already used for a different instruction");
  }
}

export function createTask(
  projectId: string,
  input: CreateTaskInput,
  store: TaskStore,
  projectExists: (id: string) => boolean,
): TaskRegistration {
  if (!projectExists(projectId)) throw new TaskRegistrationError("PROJECT_NOT_FOUND");

  const task: Task = {
    id: randomUUID(),
    projectId,
    instruction: input.instruction.trim(),
    requestKey: input.requestKey,
    status: "queued",
    createdAt: new Date(),
  };

  const result = store.register(task);
  if (result.task.instruction !== task.instruction) throw new TaskRegistrationError("REQUEST_KEY_CONFLICT");
  return result;
}
