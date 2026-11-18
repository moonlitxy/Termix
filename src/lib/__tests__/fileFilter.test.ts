import { describe, expect, it } from "vitest";
import { buildFilterMatcher, filterItems } from "../fileFilter";

const items = [
  { name: "app.log" },
  { name: "error-2026.log" },
  { name: "backup.tar.gz" },
  { name: "README.md" },
];

describe("fileFilter", () => {
  it("按普通关键词忽略大小写匹配", () => {
    expect(filterItems(items, "readme")).toEqual([{ name: "README.md" }]);
  });

  it("支持星号与问号通配符", () => {
    expect(filterItems(items, "*.log").map((item) => item.name)).toEqual([
      "app.log",
      "error-2026.log",
    ]);
    expect(buildFilterMatcher("error-????.log")("error-2026.log")).toBe(true);
  });

  it("空格表示 AND，竖线表示 OR", () => {
    expect(filterItems(items, "error 2026").map((item) => item.name)).toEqual([
      "error-2026.log",
    ]);
    expect(filterItems(items, "README|backup").map((item) => item.name)).toEqual([
      "backup.tar.gz",
      "README.md",
    ]);
  });

  it("空查询返回全部", () => {
    expect(filterItems(items, "  ")).toEqual(items);
  });

  it("空白 pattern 的匹配器接受任意名称", () => {
    expect(buildFilterMatcher("   ")("anything-at-all")).toBe(true);
  });

  it("仅分隔符的 pattern 接受任意名称", () => {
    expect(buildFilterMatcher("|")("anything-at-all")).toBe(true);
  });
});
