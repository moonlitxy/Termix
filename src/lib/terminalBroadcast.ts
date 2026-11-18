import type { Tab } from "../types";

/**
 * 同步输入（multi-exec 广播）：把当前终端的输入同步写到其他已连接终端。
 * - 只发给 `connected` 且有 shell 的标签（含分屏 pane）；
 * - 排除输入来源自身，避免回显重复；
 * - 纯函数，便于单测；实际写操作由调用方执行并各自处理失败。
 */

export interface BroadcastTarget {
  connectionId: string;
  shellId: string;
}

export function broadcastTargets(
  tabs: Pick<Tab, "id" | "status" | "connectionId" | "shellId">[],
  selfId: string
): BroadcastTarget[] {
  return tabs
    .filter(
      (t) =>
        t.id !== selfId &&
        t.status === "connected" &&
        !!t.connectionId &&
        !!t.shellId
    )
    .map((t) => ({
      connectionId: t.connectionId as string,
      shellId: t.shellId as string,
    }));
}

/** 开启同步输入时的确认文案（目标数为 0 时提示先建连接） */
export function broadcastHint(targetCount: number): string {
  if (targetCount <= 0) return "当前没有其他已连接终端，同步输入将只作用于本终端";
  return `将同步输入到另外 ${targetCount} 个已连接终端（分屏同样生效）`;
}
