import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../../store/app";
import { canSplitMore, MAX_SPLIT_PANES, paneTitle } from "../split";
import type { Tab } from "../../types";

function makeTab(id: string, extra: Partial<Tab> = {}): Tab {
  return {
    id,
    kind: "terminal",
    sessionId: "s1",
    title: id,
    status: "connected",
    ...extra,
  };
}

describe("split 纯函数", () => {
  it("paneTitle 生成带序号标题", () => {
    expect(paneTitle("prod", 2)).toBe("prod (2)");
    expect(paneTitle("prod", 4)).toBe("prod (4)");
  });

  it("canSplitMore：最多 4 屏（1 主 + 3 pane）", () => {
    expect(MAX_SPLIT_PANES).toBe(4);
    expect(canSplitMore(0).ok).toBe(true);
    expect(canSplitMore(2).ok).toBe(true);
    expect(canSplitMore(3).ok).toBe(false);
    expect(canSplitMore(3).reason).toBe("最多支持 4 屏");
  });
});

describe("store 分屏行为", () => {
  beforeEach(() => {
    useApp.setState({ tabs: [], activeTabId: null });
  });

  it("addTab 激活普通标签", () => {
    useApp.getState().addTab(makeTab("a"));
    expect(useApp.getState().activeTabId).toBe("a");
  });

  it("addTab 分屏 pane 不改变激活标签", () => {
    useApp.getState().addTab(makeTab("main"));
    useApp.getState().addTab(makeTab("p1", { hidden: true, splitOf: "main" }));
    expect(useApp.getState().tabs).toHaveLength(2);
    expect(useApp.getState().activeTabId).toBe("main");
  });

  it("closeTab 关闭主标签时级联关闭其分屏 pane", () => {
    useApp.getState().addTab(makeTab("main"));
    useApp.getState().addTab(makeTab("p1", { hidden: true, splitOf: "main" }));
    useApp.getState().addTab(makeTab("p2", { hidden: true, splitOf: "main" }));
    useApp.getState().closeTab("main");
    expect(useApp.getState().tabs).toHaveLength(0);
    expect(useApp.getState().activeTabId).toBeNull();
  });

  it("closeTab 关闭单个 pane 不影响主标签与其他 pane", () => {
    useApp.getState().addTab(makeTab("main"));
    useApp.getState().addTab(makeTab("p1", { hidden: true, splitOf: "main" }));
    useApp.getState().addTab(makeTab("p2", { hidden: true, splitOf: "main" }));
    useApp.getState().closeTab("p1");
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual(["main", "p2"]);
    expect(useApp.getState().activeTabId).toBe("main");
  });

  it("关闭激活主标签后激活最后一个可见标签（跳过隐藏 pane）", () => {
    useApp.getState().addTab(makeTab("a"));
    useApp.getState().addTab(makeTab("b"));
    useApp.getState().addTab(makeTab("p", { hidden: true, splitOf: "a" }));
    useApp.getState().setActiveTab("a");
    useApp.getState().closeTab("a");
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual(["b"]);
    expect(useApp.getState().activeTabId).toBe("b");
  });
});
