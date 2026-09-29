import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";
const App = lazy(() => import("./App"));
import QuietNoteApp from "./quietnote/QuietNoteApp";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={<div>Opening QuietNote…</div>}>{new URLSearchParams(location.search).has("workspace") || new URLSearchParams(location.search).get("mode") === "preview" ? <App /> : <QuietNoteApp />}</Suspense>
  </React.StrictMode>,
);
