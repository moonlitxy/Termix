/** 分屏相关的纯逻辑：数量上限与 pane 标题 */

/** 单个标签最多支持的终端屏数（1 个主终端 + 3 个分屏 pane） */
export const MAX_SPLIT_PANES = 4;

/**
 * 分屏 pane 的标题。screenNo 表示屏序号（第 2 屏、第 3 屏、第 4 屏）。
 */
export function paneTitle(base: string, screenNo: number): string {
  return `${base} (${screenNo})`;
}

/**
 * 判断是否还能继续分屏。
 * @param paneCount 已存在的分屏 pane 数量（0 = 未分屏）
 */
export function canSplitMore(paneCount: number): { ok: boolean; reason?: string } {
  if (paneCount >= MAX_SPLIT_PANES - 1) {
    return { ok: false, reason: "最多支持 4 屏" };
  }
  return { ok: true };
}
