import { describe, expect, it } from "vitest";
// @ts-ignore 缺少 @types/node 时仍可在 vitest node 环境运行
import { readFileSync, readdirSync } from "node:fs";
// @ts-ignore 缺少 @types/node 时仍可在 vitest node 环境运行
import { join } from "node:path";
import { i18nKeys } from "../i18n";

/**
 * 守卫测试：组件里 `t("key")` / `tr("key")` 用到的 key 必须存在于字典。
 * 漏翻、拼错 key 会在这里直接失败，避免英文界面出现裸 key。
 */
describe("i18n 使用一致性", () => {
  // @ts-ignore vitest node 环境提供 process
  const root = join(process.cwd(), "src");
  const zhKeys = new Set(i18nKeys("zh"));
  const enKeys = new Set(i18nKeys("en"));

  const files: string[] = [];
  for (const dir of ["components", "lib", "store"]) {
    const abs = join(root, dir);
    for (const name of readdirSync(abs)) {
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      if (name.includes(".test.")) continue;
      files.push(join(abs, name));
    }
  }

  it("组件引用的文案 key 全部存在（中英各一份）", () => {
    const missing = new Set<string>();
    const pattern = /\b(?:t|tr)\("([a-zA-Z][\w.]*\.[\w.]+)"/g;
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      for (const m of src.matchAll(pattern)) {
        const key = m[1];
        if (!zhKeys.has(key) || !enKeys.has(key)) missing.add(key);
      }
    }
    expect([...missing].sort()).toEqual([]);
  });

  it("覆盖核心界面：至少引用了 120 个不同文案 key", () => {
    const used = new Set<string>();
    const pattern = /\b(?:t|tr)\("([a-zA-Z][\w.]*\.[\w.]+)"/g;
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      for (const m of src.matchAll(pattern)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThanOrEqual(120);
  });
});
