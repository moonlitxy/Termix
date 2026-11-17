import { describe, expect, it } from "vitest";
import { selectMonitorConnection } from "../../store/monitor";

describe("selectMonitorConnection", () => {
  const tabs = [
    { id: "tab-a", connectionId: "conn-a", status: "connected" },
    { id: "tab-b", connectionId: "conn-b", status: "connected" },
    { id: "tab-c", connectionId: "conn-c", status: "connecting" },
  ];

  it("优先使用当前激活的已连接标签", () => {
    expect(
      selectMonitorConnection({ connectionId: "conn-a" }, tabs, "tab-b")
    ).toBe("conn-b");
  });

  it("激活标签未连接时回退到 SFTP 绑定连接", () => {
    expect(
      selectMonitorConnection({ connectionId: "conn-a" }, tabs, "tab-c")
    ).toBe("conn-a");
  });

  it("没有可用连接时返回 null", () => {
    expect(selectMonitorConnection(null, tabs, "tab-c")).toBeNull();
  });
});
