import "./styles.css";
import "./i18n";
import { mountGEBotWidget, mountGebWidget } from "./widget/mount";

declare global {
  interface Window {
    GEBOT_WIDGET?: {
      mount: typeof mountGEBotWidget;
    };
    GEB_CHATBOT_WIDGET?: {
      mount: typeof mountGebWidget;
    };
  }
}

window.GEBOT_WIDGET = {
  mount: mountGEBotWidget,
};

window.GEB_CHATBOT_WIDGET = {
  mount: mountGebWidget,
};

// Auto-mount in dev if #root exists
const root = document.getElementById("root");
if (root) {
  mountGEBotWidget({
    target: root,
    apiBaseUrl: "http://localhost:8787",
  });
}

