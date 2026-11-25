import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";

const terms = new Map<string, Terminal>();
const searches = new Map<string, SearchAddon>();
let focusedTabId: string | null = null;

export const TERMINAL_FOCUS_CHANGED_EVENT = "termix:terminal-focus-changed";

function notifyFocusChanged(tabId: string | null) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(TERMINAL_FOCUS_CHANGED_EVENT, { detail: { tabId } })
  );
}

/** 终端实例与输出缓冲注册表（按 tabId），供工具栏/快捷键跨组件访问。 */
export const terminalRegistry = {
  set(tabId: string, t: Terminal): void {
    terms.set(tabId, t);
  },
  get(tabId: string): Terminal | undefined {
    return terms.get(tabId);
  },
  remove(tabId: string): void {
    terms.delete(tabId);
    searches.delete(tabId);
    if (focusedTabId === tabId) focusedTabId = null;
  },

  /** 记录最近获得焦点的终端（分屏 pane 无法被激活，搜索等操作以此为目标） */
  setFocus(tabId: string): void {
    if (focusedTabId === tabId) return;
    focusedTabId = tabId;
    notifyFocusChanged(tabId);
  },
  getFocus(): string | null {
    return focusedTabId;
  },

  /** 聚焦指定终端（切回终端视图等场景下恢复键盘输入与命令历史） */
  focus(tabId: string): void {
    const t = terms.get(tabId);
    if (t) t.focus();
  },

  setSearch(tabId: string, s: SearchAddon): void {
    searches.set(tabId, s);
  },
  getSearch(tabId: string): SearchAddon | undefined {
    return searches.get(tabId);
  },

};
