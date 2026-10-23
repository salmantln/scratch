import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";
const App = lazy(() => import("./App"));
const CallPanel = lazy(() => import("./quietnote/CallPanel"));
import QuietNoteApp from "./quietnote/QuietNoteApp";
import "./App.css";

const params = new URLSearchParams(location.search);
const panel = params.get("panel") === "call";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={panel ? null : <div>Opening QuietNote…</div>}>{panel ? <CallPanel /> : params.has("workspace") || params.get("mode") === "preview" ? <App /> : <QuietNoteApp />}</Suspense>
  </React.StrictMode>,
);
