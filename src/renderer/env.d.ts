/// <reference types="vite/client" />
import type { WebviewTag } from "electron";
import type { GappBridge } from "../shared/api";

declare global {
  interface Window {
    gapp: GappBridge;
  }
}

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      webview: HTMLAttributes<WebviewTag> & { src?: string; partition?: string };
    }
  }
}
