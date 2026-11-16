import { describe, expect, it } from "vitest";
import { rangeSelection, selectAllPaths, toggleSelection } from "../selection";

const items = ["a", "b", "c", "d"].map((path) => ({ path }));

describe("selection", () => {
  it("toggle 添加和移除路径", () => {
    expect(toggleSelection([], "a")).toEqual(["a"]);
    expect(toggleSelection(["a", "b"], "a")).toEqual(["b"]);
  });

  it("范围选择包含锚点和目标", () => {
    expect(rangeSelection(items, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeSelection(items, "d", "a")).toEqual(["a", "b", "c", "d"]);
  });

  it("锚点失效时退化为单选", () => {
    expect(rangeSelection(items, "missing", "c")).toEqual(["c"]);
    expect(rangeSelection(items, null, "c")).toEqual(["c"]);
  });

  it("全选返回全部路径", () => {
    expect(selectAllPaths(items)).toEqual(["a", "b", "c", "d"]);
  });
});
