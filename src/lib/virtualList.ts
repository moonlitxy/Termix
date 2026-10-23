export interface VirtualRange {
  start: number;
  end: number;
  topPadding: number;
  bottomPadding: number;
}

/** 根据滚动位置计算窗口化行范围；offsetTop 用于扣除吸顶表头等固定内容。 */
export function getVirtualRange(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 8,
  offsetTop = 0
): VirtualRange {
  if (total <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, topPadding: 0, bottomPadding: 0 };
  }

  const safeScrollTop = Math.max(0, scrollTop - Math.max(0, offsetTop));
  const visibleStart = Math.min(
    total - 1,
    Math.floor(safeScrollTop / rowHeight)
  );
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const start = Math.max(0, visibleStart - overscan);
  const end = Math.min(total, visibleStart + visibleCount + overscan);

  return {
    start,
    end,
    topPadding: start * rowHeight,
    bottomPadding: (total - end) * rowHeight,
  };
}
