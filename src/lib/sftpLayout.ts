/**
 * SFTP 列表布局稳定性 helper。
 *
 * 背景：选中文件后顶部曾出现批量操作条，导致文件行整体下移，
 * 单击后再双击容易点错进入错误目录。现改为不在顶部展示该条，
 * 已选数量只显示在底部提示区（不占行高、不推动列表）。
 */

/** 同一目录二次刷新（后台补充目录大小）时不再重算列宽，避免列抖动 */
export function shouldAutoFit(
  lastKey: string | null,
  key: string,
  customized: boolean,
  hasItems: boolean
): boolean {
  if (customized || !hasItems) return false;
  return lastKey !== key;
}

/** 底部提示区文本：上传提示 + 已选数量（右键批量操作，Esc 清空） */
export function selectionHint(selectedCount: number): string {
  const base = "可拖拽本地文件到此处上传";
  if (selectedCount <= 0) return base;
  return `${base} · 已选 ${selectedCount} 项（右键批量操作，Esc 清空）`;
}
