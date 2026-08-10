import "@fontsource/ibm-plex-sans-condensed/400.css";
import "@fontsource/ibm-plex-sans-condensed/500.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { initializePortalTheme } from "./hooks/use-portal-preferences.js";
import "./styles.css";

initializePortalTheme();

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Missing portal root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
