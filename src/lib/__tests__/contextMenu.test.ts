import { describe, expect, it } from "vitest";
import { clampMenuPosition } from "../contextMenu";

describe("clampMenuPosition", () => {
  it("菜单在视口内时保持原位置", () => {
    expect(clampMenuPosition(120, 80, 160, 200, 1200, 800)).toEqual({
      x: 120,
      y: 80,
    });
  });

  it("菜单越过右边界时向左收回", () => {
    expect(clampMenuPosition(1100, 80, 160, 200, 1200, 800)).toEqual({
      x: 1032,
      y: 80,
    });
  });

  it("菜单越过下边界时向上收回", () => {
    expect(clampMenuPosition(120, 700, 160, 200, 1200, 800)).toEqual({
      x: 120,
      y: 592,
    });
  });

  it("菜单大于视口时固定在左上安全边距", () => {
    expect(clampMenuPosition(100, 100, 1400, 900, 1200, 800, 8)).toEqual({
      x: 8,
      y: 8,
    });
  });
});
