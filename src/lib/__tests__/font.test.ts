import { describe, expect, it } from "vitest";
// @ts-ignore 缺少 @types/node 时仍可在 vitest node 环境运行
import { readFileSync } from "node:fs";
// @ts-ignore 缺少 @types/node 时仍可在 vitest node 环境运行
import { join } from "node:path";

/** 字体回归：mac/Windows 统一以 mac 系统字体为先 */
describe("font 字体栈", () => {
  // @ts-ignore vitest node 环境提供 process
  const css: string = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf-8");

  it("默认字体以 mac 系统字体开头", () => {
    expect(css).toContain("--font-family-default");
    const stack = css.slice(css.indexOf("--font-family-default"));
    expect(stack.indexOf("-apple-system")).toBeLessThan(stack.indexOf('"PingFang SC"'));
    expect(stack).toContain('"Microsoft YaHei"');
    expect(stack).toContain('"Segoe UI"');
  });

  it("等宽字体包含跨平台回退", () => {
    expect(css).toContain("ui-monospace");
    expect(css).toContain('"SF Mono"');
    expect(css).toContain('"Cascadia Code"');
  });
});
