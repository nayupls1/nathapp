import { createResource, createSignal, Show } from "solid-js";
import { api } from "./api";

export default function App() {
  const [health] = createResource(api.health);
  const [name, setName] = createSignal("");
  const [greeting, setGreeting] = createSignal<string>();

  const sayHello = async (e: SubmitEvent) => {
    e.preventDefault();
    const res = await api.hello(name());
    setGreeting(res.message);
  };

  const { versions } = window.gapp;

  return (
    <main>
      <h1>gApp</h1>
      <p class="muted">Electron + SolidJS, backed by a Bun server.</p>

      <section>
        <h2>Server</h2>
        <Show when={!health.error} fallback={<p class="error">Unreachable: {String(health.error)}</p>}>
          <Show when={health()} fallback={<p class="muted">Connecting…</p>}>
            {(h) => (
              <p>
                <span class="dot" /> Running on <code>{window.gapp.serverUrl}</code> (Bun {h().bun})
              </p>
            )}
          </Show>
        </Show>
      </section>

      <section>
        <h2>Say hello</h2>
        <form onSubmit={sayHello}>
          <input
            placeholder="Your name"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <button type="submit">Send</button>
        </form>
        <Show when={greeting()}>{(g) => <p>{g()}</p>}</Show>
      </section>

      <footer class="muted">
        Electron {versions.electron} · Chrome {versions.chrome} · Node {versions.node}
      </footer>
    </main>
  );
}
