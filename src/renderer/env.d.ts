/// <reference types="vite/client" />
import type { WebviewTag } from "electron";
import type { NathAppBridge } from "../shared/api";

declare global {
  interface Window {
    nathapp: NathAppBridge;
  }
}

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      webview: HTMLAttributes<WebviewTag> & { src?: string; partition?: string };
    }
  }
}
