import { describe, expect, it } from "vitest";
// @ts-ignore vitest node 环境提供 fs / path
import { readFileSync } from "node:fs";
// @ts-ignore vitest node 环境提供 fs / path
import { join } from "node:path";

declare const process: { cwd: () => string };

describe("macOS 窗口控制与应用图标", () => {
  const controlsSource = readFileSync(
    join(process.cwd(), "src/components/WindowControls.tsx"),
    "utf-8"
  );
  const stylesSource = readFileSync(
    join(process.cwd(), "src/styles/global.css"),
    "utf-8"
  );
  const iconSource = readFileSync(
    join(process.cwd(), "plan/design/icon-concepts/04-orbit-terminal.svg"),
    "utf-8"
  );

  it("三个 macOS 按钮各自渲染悬浮符号", () => {
    expect(controlsSource).toContain('name="window-close"');
    expect(controlsSource).toContain('name="window-minimize"');
    expect(controlsSource).toContain('name="window-maximize"');
    expect(controlsSource.match(/window-controls__glyph/g)).toHaveLength(3);
  });

  it("符号只在按钮自身悬浮或键盘聚焦时显示", () => {
    expect(stylesSource).toContain(".window-controls__glyph");
    expect(stylesSource).toContain("opacity: 0;");
    expect(stylesSource).toContain(
      ".window-controls__dot:hover .window-controls__glyph"
    );
    expect(stylesSource).toContain(
      ".window-controls__dot:focus-visible .window-controls__glyph"
    );
    expect(stylesSource).toContain("pointer-events: none;");
    expect(stylesSource).not.toContain(
      ".window-controls:hover .window-controls__dot::before"
    );
  });

  it("应用图标不再包含外层底板且只保留一个圆角形状", () => {
    expect(iconSource).not.toContain('rx="116"');
    expect(iconSource).not.toContain("linearGradient");
    expect(iconSource.match(/<rect [^>]*rx="92"/g)).toHaveLength(1);
    expect(iconSource).toContain('rx="92"');
    expect(iconSource).toContain('stroke-width="52"');
  });

  it("标题栏只保留软件名称", () => {
    const titlebarSource = readFileSync(
      join(process.cwd(), "src/components/TitleBar.tsx"),
      "utf-8"
    );
    expect(titlebarSource).toContain('<span className="titlebar__brand-text">Termix</span>');
    expect(titlebarSource).not.toContain('name="brand"');
    expect(titlebarSource).not.toContain("titlebar__brand-mark");
    expect(stylesSource).not.toContain(".titlebar__brand-mark");
  });
});
