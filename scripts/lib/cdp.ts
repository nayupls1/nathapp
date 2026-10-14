// Minimal Chrome DevTools Protocol client for driving the Electron renderer.

export class Page {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, ((params: any) => void)[]>();

  private constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    };
  }

  /** Connects to the first app page exposed on the remote debugging port. */
  static async connect(port: number, timeoutMs = 20_000): Promise<Page> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
          type: string;
          url: string;
          webSocketDebuggerUrl: string;
        }[];
        const target = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
        if (target) {
          const ws = new WebSocket(target.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
          });
          return new Page(ws);
        }
      } catch {
        // not up yet
      }
      await Bun.sleep(200);
    }
    throw new Error(`No page on debugging port ${port}`);
  }

  send<T = any>(method: string, params: object = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, fn: (params: any) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), fn]);
  }

  /** Evaluates an expression (awaiting promises) and returns its JSON value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const res = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result.value as T;
  }

  /** Polls an expression until it is truthy. */
  async waitFor<T>(expression: string, { timeoutMs = 10_000, label = expression } = {}): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.eval<T>(expression).catch(() => undefined);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
      await Bun.sleep(150);
    }
  }

  async screenshot(path: string, { fullPage = false } = {}) {
    const res = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
    });
    await Bun.write(path, Buffer.from(res.data, "base64"));
  }

  close() {
    this.ws.close();
  }
}
