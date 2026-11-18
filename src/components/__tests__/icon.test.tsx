import { describe, expect, it } from "vitest";
import { Icon } from "../Icon";

describe("Icon", () => {
  it("已接线的图标渲染非空", () => {
    for (const name of ["arrow-down", "check-circle", "alert-triangle"]) {
      expect(Icon({ name })).not.toBeNull();
    }
  });

  it("未知图标返回 null", () => {
    expect(Icon({ name: "not-a-real-icon" })).toBeNull();
  });
});
