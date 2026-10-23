import { useLayoutEffect, useState, type RefObject } from "react";

export interface MenuPosition {
  x: number;
  y: number;
}

const VIEWPORT_PADDING = 8;

export function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = VIEWPORT_PADDING
): MenuPosition {
  const maxX = Math.max(padding, viewportWidth - menuWidth - padding);
  const maxY = Math.max(padding, viewportHeight - menuHeight - padding);
  return {
    x: Math.min(Math.max(padding, x), maxX),
    y: Math.min(Math.max(padding, y), maxY),
  };
}

/** 菜单挂载后按真实尺寸夹取到视口内，避免靠近右下角时溢出。 */
export function useClampedMenuPosition<T extends HTMLElement>(
  anchor: MenuPosition | null,
  menuRef: RefObject<T | null>
): MenuPosition | null {
  const [position, setPosition] = useState<MenuPosition | null>(anchor);

  useLayoutEffect(() => {
    if (!anchor) {
      setPosition(null);
      return;
    }
    const menu = menuRef.current;
    if (!menu) {
      setPosition(anchor);
      return;
    }
    const rect = menu.getBoundingClientRect();
    const next = clampMenuPosition(
      anchor.x,
      anchor.y,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight
    );
    setPosition((current) =>
      current?.x === next.x && current.y === next.y ? current : next
    );
  }, [anchor, menuRef]);

  return position;
}
