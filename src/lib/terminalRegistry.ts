import type { Terminal } from "@xterm/xterm";

const terms = new Map<string, Terminal>();
const buffers = new Map<string, string>();
const MAX_BUF = 400_000;

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
  },

  append(tabId: string, data: string): void {
    const cur = buffers.get(tabId) ?? "";
    const next = cur.length + data.length > MAX_BUF ? cur.slice(data.length) + data : cur + data;
    buffers.set(tabId, next);
  },
  getBuffer(tabId: string): string {
    return buffers.get(tabId) ?? "";
  },
  clearBuffer(tabId: string): void {
    buffers.delete(tabId);
  },

  setFontSize(size: number): void {
    terms.forEach((t) => {
      t.options.fontSize = size;
    });
  },
};
