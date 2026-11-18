import { describe, expect, it } from "vitest";
import { filterLocalItems, sortLocalItems } from "../localFiles";
import type { SftpItem } from "../../types";

function item(name: string, isDir = false): SftpItem {
  return { name, path: `/tmp/${name}`, isDir, size: 0, mtime: 0 };
}

describe("sortLocalItems", () => {
  it("目录优先，文件按名称大小写不敏感排序", () => {
    const sorted = sortLocalItems([
      item("zeta.txt"),
      item("Alpha", true),
      item("beta.txt"),
      item("beta", true),
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual([
      "Alpha",
      "beta",
      "beta.txt",
      "zeta.txt",
    ]);
  });

  it("不修改原数组", () => {
    const original = [item("b"), item("a")];
    const sorted = sortLocalItems(original);
    expect(sorted.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(original.map((entry) => entry.name)).toEqual(["b", "a"]);
  });
});

describe("filterLocalItems", () => {
  const items = [item("Alpha.txt"), item("beta.log"), item("alphabet.md")];

  it("按名称大小写不敏感过滤", () => {
    expect(filterLocalItems(items, "ALPHA").map((entry) => entry.name)).toEqual([
      "Alpha.txt",
      "alphabet.md",
    ]);
  });

  it("空白查询返回全部项目", () => {
    expect(filterLocalItems(items, "  ")).toBe(items);
  });

  it("无匹配时返回空数组", () => {
    expect(filterLocalItems(items, "missing")).toEqual([]);
  });
});
