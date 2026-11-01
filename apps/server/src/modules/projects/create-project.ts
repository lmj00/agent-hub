import { randomUUID } from "node:crypto";

export type CreateProjectInput = {
  name: string;
  workspaceKey: string;
};

export type Project = CreateProjectInput & {
  id: string;
  createdAt: Date;
};

export type ProjectStore = {
  save(project: Project): void;
  list(): Project[];
  findById(id: string): Project | undefined;
};

// 요청 형식 검사를 마친 입력으로 프로젝트를 만들고 저장합니다.
export function createProject(input: CreateProjectInput, store: ProjectStore): Project {
  const project: Project = {
    id: randomUUID(),
    name: input.name.trim(),
    workspaceKey: input.workspaceKey,
    createdAt: new Date(),
  };

  store.save(project);
  return project;
}
