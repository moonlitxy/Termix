import { getCurrentWindow } from "@tauri-apps/api/window";

export function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ||
    navigator.platform ||
    "";
  return /Windows|Win32|Win64|WOW64/i.test(ua) || /^Win/i.test(platform);
}

export const windowControls = {
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
  startDragging: () => getCurrentWindow().startDragging(),
  isMaximized: () => getCurrentWindow().isMaximized(),
};
