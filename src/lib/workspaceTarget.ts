import type { Tab } from "../types";

/**
 * 选择底部文件面板和全局命令输入应绑定的终端。
 * 分屏 pane 不是 activeTabId，但获得焦点后必须优先于所属主标签。
 */
export function selectWorkspaceTargetTab(
  tabs: Tab[],
  activeTabId: string | null,
  focusedTabId: string | null
): Tab | null {
  const active = activeTabId
    ? tabs.find((tab) => tab.id === activeTabId && !tab.hidden)
    : undefined;
  const focused = focusedTabId
    ? tabs.find((tab) => tab.id === focusedTabId)
    : undefined;
  const focusedInActiveGroup =
    !!active &&
    !!focused &&
    (focused.id === active.id || focused.splitOf === active.id);
  if (
    focusedInActiveGroup &&
    focused.status === "connected" &&
    focused.connectionId
  ) {
    return focused;
  }
  return active ?? null;
}
