import { useEffect, useRef, useState } from "react";

interface Tip {
  text: string;
  x: number;
  y: number;
  /** 提示框显示在元素上方（避免超出视口底部） */
  above: boolean;
}

/**
 * 全局悬浮提示：对带 title / data-tooltip 的元素在 100ms 延迟后
 * 显示统一样式（深色底、浅色文字、边框、箭头）的提示框。
 * 基于 pointermove 跟踪当前悬停元素：鼠标移出元素立即隐藏，
 * 在元素内部（含子元素）移动不重置计时，避免闪烁与残留。
 * 优先读取 data-tooltip，其次 title；显示期间临时禁用原生 title 提示。
 */
export function GlobalTooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const currentRef = useRef<HTMLElement | null>(null);
  const savedTitlesRef = useRef<Map<Element, string>>(new Map());

  useEffect(() => {
    const saved = savedTitlesRef.current;

    const clearTimer = () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };

    const restoreTitle = (el: Element) => {
      const orig = saved.get(el);
      if (orig !== undefined) {
        el.setAttribute("title", orig);
        saved.delete(el);
      }
    };

    const hide = () => {
      clearTimer();
      setTip(null);
    };

    const onMove = (e: PointerEvent) => {
      const t = e.target as Element | null;
      const el = t?.closest?.("[data-tooltip],[title]") as HTMLElement | null;
      // 仍在同一元素（含内部子元素移动）：保持计时/显示，不重置
      if (el === currentRef.current) return;

      // 离开旧元素：恢复原生 title 并立即隐藏
      if (currentRef.current) {
        restoreTitle(currentRef.current);
        currentRef.current = null;
      }
      hide();
      if (!el) return;

      currentRef.current = el;
      const text =
        el.getAttribute("data-tooltip") || el.getAttribute("title") || "";
      if (!text) return;
      if (el.hasAttribute("title")) {
        saved.set(el, el.getAttribute("title") || "");
        el.removeAttribute("title");
      }
      timerRef.current = window.setTimeout(() => {
        if (!el.isConnected) return;
        const rect = el.getBoundingClientRect();
        const belowY = Math.round(rect.bottom + 8);
        const above = belowY + 120 > window.innerHeight;
        setTip({
          text,
          x: Math.round(rect.left + rect.width / 2),
          y: above ? Math.round(rect.top - 8) : belowY,
          above,
        });
      }, 100);
    };

    document.addEventListener("pointermove", onMove, true);
    return () => {
      document.removeEventListener("pointermove", onMove, true);
      clearTimer();
      // 卸载时恢复所有暂存 title
      saved.forEach((v, k) => k.setAttribute("title", v));
      saved.clear();
    };
  }, []);

  if (!tip) return null;
  return (
    <div
      className={"global-tooltip" + (tip.above ? " is-above" : "")}
      style={{ left: tip.x, top: tip.y }}
      role="tooltip"
    >
      {tip.text}
    </div>
  );
}
