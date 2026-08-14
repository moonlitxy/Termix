import { describe, expect, it } from "vitest";
import { RES_LEVEL, resBarColor, resTextColor } from "../resColor";

describe("resColor 资源占用颜色映射", () => {
  it("阈值定义明确", () => {
    expect(RES_LEVEL.LOW).toBe(70);
    expect(RES_LEVEL.HIGH).toBe(90);
  });

  it("低占用（<70%）返回绿色标识", () => {
    expect(resBarColor(0)).toBe("res-bar__fill--success");
    expect(resBarColor(22)).toBe("res-bar__fill--success");
    expect(resBarColor(69.9)).toBe("res-bar__fill--success");
    expect(resTextColor(22)).toBe("var(--status-success-default)");
  });

  it("中占用（70%~90%）返回黄色标识", () => {
    expect(resBarColor(70)).toBe("res-bar__fill--warning");
    expect(resBarColor(89.9)).toBe("res-bar__fill--warning");
    expect(resTextColor(70)).toBe("var(--status-warning-default)");
  });

  it("高占用（>=90%）返回红色标识", () => {
    expect(resBarColor(90)).toBe("res-bar__fill--error");
    expect(resBarColor(100)).toBe("res-bar__fill--error");
    expect(resTextColor(95)).toBe("var(--status-error-default)");
  });
});
