import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installTheme, watchSystemAppearance } from "@rally/ui/lib/theme";
import "@rally/ui/styles/app.css";
import "../../common/bridge";
import App from "../App";

installTheme();
// Sideline has no appearance setting, so the choice is always `system`: follow
// the Mac when it switches between light and dark.
watchSystemAppearance();
const root = document.getElementById("root");
if (!root) throw new Error("Sideline renderer root is missing");
createRoot(root).render(<StrictMode><App /></StrictMode>);
