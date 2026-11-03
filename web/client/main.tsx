import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "@fontsource/zcool-kuaile/400.css";
import App from "./App";
import "./style.css";
if(new URLSearchParams(location.search).get("view")==="compare")location.replace(`/theater.html${location.search}`);
else createRoot(document.getElementById("root")!).render(<MotionConfig reducedMotion="user"><App/></MotionConfig>);
