import { describe, expect, it } from "vitest";
import { connButtonClass, toConnVisual } from "../connectionStatus";

describe("connectionStatus 连接视觉态", () => {
  it("已连接与连接中各自映射", () => {
    expect(toConnVisual("connected")).toBe("connected");
    expect(toConnVisual("connecting")).toBe("connecting");
  });

  it("断开、失败与未知统一归为离线（标红）", () => {
    expect(toConnVisual("disconnected")).toBe("offline");
    expect(toConnVisual("error")).toBe("offline");
    expect(toConnVisual(undefined)).toBe("offline");
  });

  it("按钮类名携带视觉态", () => {
    expect(connButtonClass("offline")).toContain("editor-tabs__conn--offline");
    expect(connButtonClass("connected")).toContain("editor-tabs__conn--connected");
  });
});
