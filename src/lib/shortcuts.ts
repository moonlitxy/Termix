import { isWindowsPlatform } from "./windowControls";

export interface ShortcutEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * 应用级快捷键：macOS 使用 Cmd+key；Windows 使用 Ctrl+Shift+key。
 * Windows 不用裸 Ctrl，避免抢占终端里的 Ctrl+C/D/L/F/K/T 等控制序列。
 */
export function appShortcutKey(key: string): string {
  return isWindowsPlatform() ? `Ctrl+Shift+${key}` : `⌘${key}`;
}

export function copyShortcutKey(): string {
  return isWindowsPlatform() ? "Ctrl+C" : "⌘C";
}

export function zoomShortcutLabel(): string {
  return isWindowsPlatform() ? "Ctrl + / -" : "⌘ + / -";
}

export function isAppShortcut(event: ShortcutEvent, key: string): boolean {
  if (event.altKey) return false;
  if (event.key.toLowerCase() !== key.toLowerCase()) return false;
  if (isWindowsPlatform()) {
    return event.ctrlKey && event.shiftKey && !event.metaKey;
  }
  return event.metaKey && !event.ctrlKey && !event.shiftKey;
}

export function isZoomShortcut(
  event: ShortcutEvent,
  key: "=" | "+" | "-"
): boolean {
  if (event.altKey || event.key !== key) return false;
  return isWindowsPlatform()
    ? event.ctrlKey && !event.metaKey
    : event.metaKey && !event.ctrlKey;
}
