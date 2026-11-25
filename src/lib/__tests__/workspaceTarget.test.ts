import { describe, expect, it } from "vitest";
import { selectWorkspaceTargetTab } from "../workspaceTarget";
import type { Tab } from "../../types";

function tab(patch: Partial<Tab> & Pick<Tab, "id">): Tab {
  return {
    kind: "terminal",
    sessionId: "s1",
    title: patch.id,
    status: "connected",
    ...patch,
  };
}

describe("工作区目标标签", () => {
  const main = tab({ id: "main", connectionId: "c-main" });
  const split = tab({
    id: "split",
    connectionId: "c-split",
    hidden: true,
    splitOf: "main",
  });
  const other = tab({ id: "other", connectionId: "c-other" });

  it("分屏获得焦点后优先返回分屏连接", () => {
    expect(
      selectWorkspaceTargetTab([main, split, other], "main", "split")
    ).toEqual(split);
  });

  it("焦点属于其他标签组时回退到当前激活标签", () => {
    expect(
      selectWorkspaceTargetTab([main, split, other], "main", "other")
    ).toEqual(main);
  });

  it("分屏尚未连接时回退到主标签", () => {
    const connecting = {
      ...split,
      status: "connecting" as const,
      connectionId: undefined,
    };
    expect(
      selectWorkspaceTargetTab([main, connecting, other], "main", "split")
    ).toEqual(main);
  });
});
