import type { TransferTask } from "../types";

export type TransferMenuAction = "revealLocal" | "copyRemotePath";

/** 已完成传输项可执行的右键操作。 */
export function transferMenuActions(task: TransferTask): TransferMenuAction[] {
  if (task.status !== "completed") return [];
  if (task.direction === "download" && task.localPath) {
    return ["revealLocal"];
  }
  if (task.direction === "upload" && task.remotePath) {
    return ["copyRemotePath"];
  }
  return [];
}
