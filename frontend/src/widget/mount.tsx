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

const mountedByTarget = new WeakMap<HTMLElement, Mounted>();

export function mountGebWidget(opts: MountOptions): Mounted {
  if (!opts.target || !opts.target.isConnected) {
    throw new Error("GEBot widget mount target must be a connected DOM element.");
  }

  const previous = mountedByTarget.get(opts.target);
  if (previous) {
    previous.unmount();
  }

  const container = document.createElement("div");
  container.setAttribute("data-gebot-widget", "root");
  container.setAttribute("data-gebot-isolation", "scoped");
  opts.target.appendChild(container);

  const root = createRoot(container);
  root.render(<Widget apiBaseUrl={opts.apiBaseUrl} />);

  const mounted: Mounted = {
    root,
    container,
    unmount: () => {
      root.unmount();
      container.remove();
      mountedByTarget.delete(opts.target);
    },
  };

  mountedByTarget.set(opts.target, mounted);
  return mounted;
}

export const mountGEBotWidget = mountGebWidget;

