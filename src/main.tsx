import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

try {
  const container = document.getElementById("root");
  if (container) {
    createRoot(container).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  } else {
    const el = document.createElement("div");
    el.style.color = "red";
    el.textContent = "Error: #root element not found!";
    document.body.appendChild(el);
  }
} catch (err: any) {
  const el = document.createElement("pre");
  el.style.color = "#ff3366";
  el.style.background = "#000000";
  el.style.padding = "20px";
  el.textContent = "FATAL REACT ROOT ERROR:\n" + (err?.stack || String(err));
  document.body.appendChild(el);
}
