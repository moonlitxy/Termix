import { describe, expect, it } from "vitest";
import { broadcastHint, broadcastTargets } from "../terminalBroadcast";

const tabs = [
  { id: "self", status: "connected", connectionId: "c1", shellId: "s1" },
  { id: "other", status: "connected", connectionId: "c2", shellId: "s2" },
  { id: "pane", status: "connected", connectionId: "c2", shellId: "s3" },
  { id: "idle", status: "disconnected", connectionId: undefined, shellId: undefined },
  { id: "connecting", status: "connecting", connectionId: "c3", shellId: undefined },
] as const;

describe("terminalBroadcast 同步输入", () => {
  it("只发给其他已连接且有 shell 的标签", () => {
    const targets = broadcastTargets([...tabs], "self");
    expect(targets).toEqual([
      { connectionId: "c2", shellId: "s2" },
      { connectionId: "c2", shellId: "s3" },
    ]);
  });

  it("无目标时提示先建连接", () => {
    expect(broadcastTargets([...tabs], "other")).toHaveLength(2);
    expect(broadcastHint(0)).toContain("没有其他已连接终端");
    expect(broadcastHint(3)).toContain("另外 3 个");
  });
});
