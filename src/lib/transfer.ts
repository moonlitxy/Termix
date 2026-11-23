import { dirname } from "../store/app";
import type { TransferTask } from "../types";

/** 仍在占用传输队列、需要保留行和操作按钮的状态 */
export function isTransferActive(task: TransferTask): boolean {
  return (
    task.status === "running" ||
    task.status === "paused" ||
    task.status === "interrupted"
  );
}

/** 可以自动移出队列的终态 */
export function isTransferTerminal(task: TransferTask): boolean {
  return (
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled"
  );
}

/** 优先用字节数计算百分比，目录传输继续使用后端文件计数进度 */
export function transferPercent(task: TransferTask): number {
  const total = task.totalBytes ?? 0;
  const transferred = task.transferredBytes ?? 0;
  const raw =
    total > 0 ? (transferred / total) * 100 : Number.isFinite(task.progress) ? task.progress : 0;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, raw));
}

/** 行内展示文件所在目录：下载看本地目录，上传看远端目录 */
export function transferLocation(task: TransferTask): string {
  if (task.direction === "download") {
    return task.localPath ? dirname(task.localPath) : "";
  }
  return task.remotePath ? dirname(task.remotePath) : "";
}

/** 剩余时间（秒）；速度未知或已完成时返回 null */
export function transferEtaSeconds(task: TransferTask): number | null {
  if (task.status !== "running" || !task.speed || task.speed <= 0) return null;
  const total = task.totalBytes ?? 0;
  const transferred = task.transferredBytes ?? 0;
  if (total <= 0 || transferred >= total) return null;
  return (total - transferred) / task.speed;
}

/** 秒数 → 紧凑的 mm:ss / h:mm:ss */
export function formatEta(seconds: number): string {
  const total = Math.max(1, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}
