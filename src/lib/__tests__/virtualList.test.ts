import { describe, expect, it } from "vitest";
import { getVirtualRange } from "../virtualList";

describe("getVirtualRange", () => {
  it("空列表返回空范围", () => {
    expect(getVirtualRange(0, 0, 300, 28)).toEqual({
      start: 0,
      end: 0,
      topPadding: 0,
      bottomPadding: 0,
    });
  });

  it("滚动到中部时只返回可视区与 overscan 行", () => {
    expect(getVirtualRange(1000, 2798, 280, 28, 5, 26)).toEqual({
      start: 94,
      end: 114,
      topPadding: 2632,
      bottomPadding: 24808,
    });
  });

  it("滚动到底部时裁掉底部 padding", () => {
    const range = getVirtualRange(100, 2800, 280, 28, 4);
    expect(range.end).toBe(100);
    expect(range.bottomPadding).toBe(0);
  });

  it("负滚动位置按顶部处理", () => {
    expect(getVirtualRange(100, -50, 100, 28, 2)).toEqual({
      start: 0,
      end: 6,
      topPadding: 0,
      bottomPadding: 2632,
    });
  });
});
