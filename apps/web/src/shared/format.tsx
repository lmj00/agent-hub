import type { TaskStatus } from "@agent-hub/contracts";

export const statusLabels: Record<TaskStatus, string> = {
  queued: "실행 대기",
  running: "작업 중",
  succeeded: "완료",
  failed: "실패",
  cancelled: "취소됨",
  interrupted: "실행 중단",
  blocked: "확인 필요",
  waiting_capacity: "사용량 대기",
  waiting_retry: "재개 대기",
};
export function Status({ value, label }: { value: TaskStatus; label?: string | undefined }) {
  return (
    <span className={`status status-${value}`}>
      <span aria-hidden="true" className="status-dot" />
      {label ?? statusLabels[value]}
    </span>
  );
}
export function taskTitle(instruction: string) {
  const line = instruction.trim().split("\n")[0] ?? instruction;
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
export function dateTime(value: string | Date | null | undefined) {
  return value
    ? new Intl.DateTimeFormat("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "미확인";
}
export function elapsed(start: string, end: string | null) {
  const seconds = Math.max(
    0,
    Math.floor(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000),
  );
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
  return `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`;
}
