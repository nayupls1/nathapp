/// <reference types="vite/client" />
import type { GappBridge } from "../shared/api";

declare global {
  interface Window {
    gapp: GappBridge;
  }
}
