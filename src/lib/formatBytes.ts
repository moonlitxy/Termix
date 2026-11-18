/**
 * 字节与用量格式化（多处资源/文件模块共用）。
 *
 * 设计说明：
 * - B/KB/MB 沿用一位小数，GB/TB/PB 用两位小数，避免大容量下跳变；
 * - `formatBytePair` 按总量所在单位统一换算两端，
 *   例如总量 1T 时 `356G/1026G` 统一显示为 `0.35T/1.00T`，
 *   避免 `356G/1T` 这类混单位难以一眼比较。
 */

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const TB = 1024 * 1024 * 1024 * 1024;
const PB = 1024 * 1024 * 1024 * 1024 * 1024;

/** 单个字节数 → 带单位字符串 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < KB) return `${Math.round(n)} B`;
  if (n < MB) return `${(n / KB).toFixed(1)} KB`;
  if (n < GB) return `${(n / MB).toFixed(1)} MB`;
  if (n < TB) return `${(n / GB).toFixed(2)} GB`;
  if (n < PB) return `${(n / TB).toFixed(2)} TB`;
  return `${(n / PB).toFixed(2)} PB`;
}

type ShortUnit = "B" | "KB" | "MB" | "G" | "T" | "P";

function unitOf(total: number): { unit: ShortUnit; divisor: number; decimals: number } {
  if (total >= PB) return { unit: "P", divisor: PB, decimals: 2 };
  if (total >= TB) return { unit: "T", divisor: TB, decimals: 2 };
  if (total >= GB) return { unit: "G", divisor: GB, decimals: 1 };
  if (total >= MB) return { unit: "MB", divisor: MB, decimals: 1 };
  if (total >= KB) return { unit: "KB", divisor: KB, decimals: 1 };
  return { unit: "B", divisor: 1, decimals: 0 };
}

/**
 * 已用/总量 → 同单位紧凑字符串（如 `0.35T/1.00T`）。
 * 大单位用用户习惯的短写法 G/T/P，避免 `356G/1T` 这类混单位难以一眼比较。
 * 总量未知或为 0 时回退为 `formatBytes(used) / -`。
 */
export function formatBytePair(used: number, total: number): string {
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;
  if (!Number.isFinite(total) || total <= 0) return `${formatBytes(safeUsed)} / -`;
  const { unit, divisor, decimals } = unitOf(total);
  const lhs = (safeUsed / divisor).toFixed(decimals);
  const rhs = (total / divisor).toFixed(decimals);
  return `${lhs}${unit}/${rhs}${unit}`;
}

/** 已用/总量 → 百分比字符串（如 `34.7%`），总量无效时返回 `-` */
export function formatPct(used: number, total: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return "-";
  return `${((used / total) * 100).toFixed(1)}%`;
}
