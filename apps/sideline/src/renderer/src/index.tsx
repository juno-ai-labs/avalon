import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installTheme } from "@rally/ui/lib/theme";
import "@rally/ui/styles/app.css";
import "../../common/bridge";
import App from "../App";

installTheme();
const root = document.getElementById("root");
if (!root) throw new Error("Sideline renderer root is missing");
createRoot(root).render(<StrictMode><App /></StrictMode>);
