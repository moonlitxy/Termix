import { describe, expect, it } from "vitest";
import { switchRemotePath } from "../remotePath";

describe("switchRemotePath", () => {
  it("首次连接从根目录开始", () => {
    expect(switchRemotePath({}, null, "conn-a")).toEqual({
      paths: {},
      path: "/",
    });
  });

  it("切换连接时保存旧路径并为新连接恢复根目录", () => {
    expect(
      switchRemotePath({}, { connectionId: "conn-a", path: "/var/log" }, "conn-b")
    ).toEqual({
      paths: { "conn-a": "/var/log" },
      path: "/",
    });
  });

  it("恢复目标连接上次浏览的目录", () => {
    expect(
      switchRemotePath(
        { "conn-a": "/var/log", "conn-b": "/opt/app" },
        { connectionId: "conn-a", path: "/tmp" },
        "conn-b"
      )
    ).toEqual({
      paths: { "conn-a": "/tmp", "conn-b": "/opt/app" },
      path: "/opt/app",
    });
  });

  it("关闭上下文时保存路径并回到根目录", () => {
    expect(
      switchRemotePath({}, { connectionId: "conn-a", path: "/data" }, null)
    ).toEqual({
      paths: { "conn-a": "/data" },
      path: "/",
    });
  });
});
