import "./styles.css";
import { mountGebWidget } from "./widget/mount";

const root = document.getElementById("root");
if (root) {
  mountGebWidget({
    target: root,
    // Same origin in dev so Vite can proxy to the backend (see vite.config.ts).
    apiBaseUrl: import.meta.env.DEV ? "" : "http://localhost:8787",
  });
}

