// The bundled host picker. It reaches the shell only through `connect` and `saved_host`.
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
const form = document.getElementById("picker");
const input = document.getElementById("host");
const button = document.getElementById("connect");
const error = document.getElementById("error");
const UNREACHABLE = "Suplex cannot reach this host. Check the address and the network, then retry.";

function origin(value) {
  const text = value.trim();
  try { return new URL(text.includes("://") ? text : `https://${text}`).origin; } catch { return null; }
}

async function connect() {
  error.textContent = "";
  button.disabled = true;
  const host = origin(input.value);
  try {
    if (host) {
      // An opaque answer is enough: it proves that the phone reaches the host.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try { await fetch(`${host}/manifest.webmanifest`, { mode: "no-cors", cache: "no-store", signal: controller.signal }); }
      catch { error.textContent = UNREACHABLE; return; }
      finally { clearTimeout(timer); }
    }
    // The shell checks the address again and explains a bad one.
    await invoke("connect", { url: input.value });
  } catch (reason) {
    error.textContent = String(reason);
  } finally {
    button.disabled = false;
  }
}

form.addEventListener("submit", event => { event.preventDefault(); void connect(); });

if (!new URLSearchParams(location.search).has("pick")) {
  void invoke("saved_host").then(saved => {
    if (!saved) return;
    input.value = saved;
    void connect();
  });
}
