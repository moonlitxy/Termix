import { describe, expect, it } from "vitest";
import { selectionHint, shouldAutoFit } from "../sftpLayout";

const t = (key: string, vars?: Record<string, number>) =>
  key === "sftp.dropHintSel" ? ` · selected ${vars?.n}` : "drop here";

describe("sftpLayout 列表稳定性", () => {
  it("选中后提示只出现在底部，不推动列表", () => {
    expect(selectionHint(0, t)).toBe("drop here");
    expect(selectionHint(2, t)).toContain("selected 2");
  });

  it("同目录后台补充时不再重算列宽", () => {
    const key = "conn-1|/tmp";
    // 首次快速列表到达：需要自适应
    expect(shouldAutoFit(null, key, false, true)).toBe(true);
    // 同 key 的 enrich 二次到达：跳过，避免列抖动
    expect(shouldAutoFit(key, key, false, true)).toBe(false);
    // 切换目录：重新自适应
    expect(shouldAutoFit(key, "conn-1|/var", false, true)).toBe(true);
  });

  it("用户手动调整列宽后不再覆盖", () => {
    expect(shouldAutoFit(null, "k", true, true)).toBe(false);
    expect(shouldAutoFit(null, "k", false, false)).toBe(false);
  });
});
