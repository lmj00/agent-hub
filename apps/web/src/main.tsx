import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "./features/workspace/workspace.css";

createRoot(document.getElementById("root")!).render(<App />);
