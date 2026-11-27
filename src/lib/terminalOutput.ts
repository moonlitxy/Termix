import { onTerminalOutput, type TerminalOutputEvent } from "./ipc";

type Listener = (e: TerminalOutputEvent) => void;

const listeners = new Map<string, Set<Listener>>();
let unlisten: (() => void) | null = null;
let subscribing = false;

function dispatch(e: TerminalOutputEvent): void {
  const set = listeners.get(e.tabId);
  if (!set) return;
  for (const cb of set) cb(e);
}

function ensureSubscribed(): void {
  if (unlisten || subscribing) return;
  subscribing = true;
  void onTerminalOutput(dispatch)
    .then((un) => {
      subscribing = false;
      // 订阅建立期间所有监听者已退订：立即取消，避免空转
      if (listeners.size === 0) {
        un();
        return;
      }
      unlisten = un;
    })
    .catch((e) => {
      subscribing = false;
      console.error("terminal-output subscribe failed:", e);
    });
}

/**
 * 共享唯一的 `terminal-output` 订阅并按 tabId 分发。
 * 多标签/分屏时后端事件只触发一次路由，组件只收到自己标签的数据。
 */
export function subscribeTerminalOutput(
  tabId: string,
  cb: Listener
): () => void {
  let set = listeners.get(tabId);
  if (!set) {
    set = new Set();
    listeners.set(tabId, set);
  }
  set.add(cb);
  ensureSubscribed();

  return () => {
    const current = listeners.get(tabId);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) listeners.delete(tabId);
    if (listeners.size === 0 && unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}
