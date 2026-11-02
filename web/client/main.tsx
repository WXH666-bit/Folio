import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "@fontsource/zcool-kuaile/400.css";
import App from "./App";
import { lazy, Suspense } from "react";
const Comparison=lazy(()=>import("./Comparison"));
import "./style.css";
createRoot(document.getElementById("root")!).render(<MotionConfig reducedMotion="user">{new URLSearchParams(location.search).get("view")==="compare"?<Suspense fallback={<p style={{padding:30}}>正在打开对照舞台…</p>}><Comparison/></Suspense>:<App/>}</MotionConfig>);
