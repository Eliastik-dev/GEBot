import React from "react";
import { createRoot, Root } from "react-dom/client";
import { Widget } from "./widget";

export type MountOptions = {
  target: HTMLElement;
  apiBaseUrl: string;
};

type Mounted = {
  root: Root;
  container: HTMLDivElement;
  unmount: () => void;
};

export function mountGebWidget(opts: MountOptions): Mounted {
  const container = document.createElement("div");
  container.setAttribute("data-gebot-widget", "true");
  opts.target.appendChild(container);

  const root = createRoot(container);
  root.render(<Widget apiBaseUrl={opts.apiBaseUrl} />);

  return {
    root,
    container,
    unmount: () => root.unmount(),
  };
}

export const mountGEBotWidget = mountGebWidget;

