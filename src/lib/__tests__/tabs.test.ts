import { describe, expect, it } from "vitest";
import { createSplitTab } from "../tabs";

describe("createSplitTab", () => {
  it("创建隐藏且归属主标签的新连接标签", () => {
    expect(
      createSplitTab(
        {
          id: "main",
          kind: "terminal",
          sessionId: "session-1",
          title: "生产服务器",
        },
        "split-1"
      )
    ).toEqual({
      id: "split-1",
      kind: "terminal",
      sessionId: "session-1",
      title: "生产服务器",
      status: "connecting",
      hidden: true,
      splitOf: "main",
    });
  });
});
