import { describe, expect, it } from "vitest";
import { formatBytePair, formatBytes, formatPct } from "../formatBytes";

const GB = 1024 * 1024 * 1024;
const TB = 1024 * 1024 * 1024 * 1024;

describe("formatBytes 共用格式化", () => {
  it("小单位保持一位小数", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("GB/TB 使用两位小数", () => {
    expect(formatBytes(356 * GB)).toBe("356.00 GB");
    expect(formatBytes(1 * TB)).toBe("1.00 TB");
  });

  it("总量为 T 时统一按 T 换算两端", () => {
    // 356G/1T → 0.35T/1.00T，避免混单位
    expect(formatBytePair(356 * GB, 1 * TB)).toBe("0.35T/1.00T");
    // 356G/1026G（总量约 1T）同样统一为 T
    expect(formatBytePair(356 * GB, 1026 * GB)).toBe("0.35T/1.00T");
  });

  it("总量为 G 时统一按 G 换算", () => {
    expect(formatBytePair(512 * 1024 * 1024, 1 * GB)).toBe("0.5G/1.0G");
  });

  it("总量无效时回退", () => {
    expect(formatBytePair(356 * GB, 0)).toBe("356.00 GB / -");
    expect(formatPct(1, 0)).toBe("-");
  });

  it("百分比保留一位小数", () => {
    expect(formatPct(356 * GB, 1026 * GB)).toBe("34.7%");
  });
});
