import { describe, expect, it } from "vitest";
import {
  applyVariables,
  buildVarDefs,
  parseVariables,
  scanPlaceholders,
} from "../variables";

describe("parseVariables", () => {
  it("解析合法 JSON 数组", () => {
    const raw = JSON.stringify([
      { name: "host", default: "127.0.0.1" },
      { name: "port", default: 22 },
    ]);
    expect(parseVariables(raw)).toEqual([
      { name: "host", defaultValue: "127.0.0.1" },
      { name: "port", defaultValue: "22" },
    ]);
  });

  it("空串/非法 JSON/非数组返回空数组", () => {
    expect(parseVariables(undefined)).toEqual([]);
    expect(parseVariables("not json")).toEqual([]);
    expect(parseVariables('"string"')).toEqual([]);
  });

  it("过滤无名变量与缺省默认值", () => {
    const raw = JSON.stringify([{ default: "x" }, { name: "ok" }]);
    expect(parseVariables(raw)).toEqual([{ name: "ok", defaultValue: "" }]);
  });
});

describe("scanPlaceholders / buildVarDefs", () => {
  it("扫描占位符（支持 {{ var }} 空白）", () => {
    expect(scanPlaceholders("ls {{host}} && echo {{ var }}")).toEqual(["host", "var"]);
    expect(scanPlaceholders("no placeholders")).toEqual([]);
  });

  it("buildVarDefs 合并扫描与声明默认值", () => {
    const raw = JSON.stringify([{ name: "host", default: "127.0.0.1" }]);
    expect(buildVarDefs("ssh {{host}} {{port}}", raw)).toEqual([
      { name: "host", defaultValue: "127.0.0.1" },
      { name: "port", defaultValue: "" },
    ]);
  });
});

describe("applyVariables", () => {
  it("替换占位符，未提供的值替换为空", () => {
    expect(applyVariables("echo {{a}} {{b}}", { a: "1" })).toBe("echo 1 ");
  });

  it("与扫描同正则：{{ var }} 带空白也能替换", () => {
    expect(applyVariables("echo {{ var }}", { var: "x" })).toBe("echo x");
  });
});
