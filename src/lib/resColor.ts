/**
 * 资源占用率 → 状态颜色映射。
 *
 * 统一阈值（百分比）：
 * - 低水平：< 70%   → 绿色（success）
 * - 中水平：70% ~ 90% → 黄色（warning）
 * - 高水平：≥ 90%   → 红色（error）
 *
 * 用于右侧资源监控、监控面板的进度条与数值文字，保证视觉标识一致。
 */
export const RES_LEVEL = {
  /** 低占用阈值：低于该值视为低水平，绿色标识 */
  LOW: 70,
  /** 高占用阈值：达到该值视为高水平，红色标识 */
  HIGH: 90,
} as const;

/** 资源占用率 → 进度条填充样式类 */
export function resBarColor(pct: number): string {
  if (pct < RES_LEVEL.LOW) return "res-bar__fill--success";
  if (pct < RES_LEVEL.HIGH) return "res-bar__fill--warning";
  return "res-bar__fill--error";
}

/** 资源占用率 → 数值文字颜色（CSS 变量） */
export function resTextColor(pct: number): string {
  if (pct < RES_LEVEL.LOW) return "var(--status-success-default)";
  if (pct < RES_LEVEL.HIGH) return "var(--status-warning-default)";
  return "var(--status-error-default)";
}
