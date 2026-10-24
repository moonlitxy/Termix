import { describe, expect, it } from "vitest";
import { PALETTE_ACTIVITIES, searchPalette } from "../commandPalette";

describe("searchPalette", () => {
  it("空查询返回全部条目", () => {
    const res = searchPalette("", "session", [
      { id: "1", title: "生产服务器" },
      { id: "2", title: "测试服务器" },
    ]);
    expect(res.map((x) => x.id)).toEqual(["2", "1"]);
  });

  it("匹配标题、副标题和关键词", () => {
    const res = searchPalette("prod", "session", [
      { id: "1", title: "Web", subtitle: "prod-web" },
      { id: "2", title: "DB", keywords: ["production"] },
      { id: "3", title: "Dev" },
    ]);
    expect(res.map((x) => x.id)).toEqual(["2", "1"]);
  });

  it("前缀命中排序高于包含命中", () => {
    const res = searchPalette("disk", "history", [
      { id: "1", title: "disk usage" },
      { id: "2", title: "check disk" },
    ]);
    expect(res[0].id).toBe("1");
  });

  it("限制返回数量", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: `cmd-${i}` }));
    expect(searchPalette("cmd", "history", items)).toHaveLength(12);
  });

  it("内置入口不包含插件占位", () => {
    expect(PALETTE_ACTIVITIES.some((x) => x.id === "plugins")).toBe(false);
  });
});
