import { createRoot } from "react-dom/client";
import GlassboxPanel from "./GlassboxPanel.tsx";

const HOST_ID = "glassbox-panel-host";

export function injectPanel() {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:2147483647;";

  const shadow = host.attachShadow({ mode: "open" });

  // Reset styles inside the shadow so nothing leaks in
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    *, *::before, *::after { box-sizing: border-box; }
  `;
  shadow.appendChild(style);

  const mountPoint = document.createElement("div");
  shadow.appendChild(mountPoint);

  document.body.appendChild(host);

  createRoot(mountPoint).render(<GlassboxPanel />);
}
