import "./polyfills";
import "@fontsource/big-shoulders-display/latin-600";
import "@fontsource/big-shoulders-display/latin-800";
import "@fontsource/atkinson-hyperlegible/latin-400";
import "@fontsource/atkinson-hyperlegible/latin-700";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
