/// <reference types="vite/client" />

declare module "*.svg?raw" {
  const content: string;
  export default content;
}

/** vite define 注入的应用版本号（源：package.json） */
declare const __TERMIX_VERSION__: string;
