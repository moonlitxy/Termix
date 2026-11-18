import type { Tab } from "../types";

/** 连接视觉态：已连接 / 连接中 / 离线（含断开与失败，便于统一标红） */
export type ConnVisual = "connected" | "connecting" | "offline";

export function toConnVisual(status: Tab["status"] | undefined): ConnVisual {
  if (status === "connected") return "connected";
  if (status === "connecting") return "connecting";
  return "offline";
}

/** 右上连接按钮的视觉修饰类（基类 ds-btn 保持不变） */
export function connButtonClass(visual: ConnVisual): string {
  return `editor-tabs__conn editor-tabs__conn--${visual}`;
}
