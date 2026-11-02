import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import rough from "roughjs";
import type { Stage } from "../shared";

const ink = "#252323";
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const shapes: Record<string, React.ReactNode> = {
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    arrow: <path d="M4 12h15m-6-6 6 6-6 6"/>,
    settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="17" r="3" fill="currentColor"/></>,
    check: <path d="m5 12 4 4L20 5"/>,
    stop: <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/>,
    play: <path d="m8 4 13 8-13 8z" fill="currentColor"/>,
    history: <><path d="M4 4v6h6M4 10a8 8 0 1 1 1 8"/><path d="M12 7v6l4 2"/></>,
    screen: <><rect x="3" y="4" width="18" height="14" rx="1"/><path d="M8 22h8m-4-4v4"/></>,
    download: <><path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/></>,
    file: <><path d="M5 2h10l5 5v15H5zM15 2v6h5M8 12h8m-8 4h6"/></>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/></>,
    menu: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
    expand: <><path d="M3 9V3h6m6 0h6v6M3 15v6h6m12-6v6h-6"/></>,
    quote: <><path d="M4 6h6v7H5c0 3 1 4 4 5M15 6h6v7h-5c0 3 1 4 4 5"/></>,
    spark: <><path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name] ?? shapes.file}</svg>;
}

export function PaperPi({ working = false, small = false, unhappy = false }: { working?: boolean; small?: boolean; unhappy?: boolean }) {
  const reduced = useReducedMotion();
  return <motion.svg className={small ? "paper-pi small" : "paper-pi"} viewBox="0 0 200 180" aria-label="小π，文档工坊助手"
    animate={working && !reduced ? { y: [0,-5,0], rotate: [-2,2,-2] } : { y: 0, rotate: 0 }} transition={{ duration: 1.8, repeat: working ? Infinity : 0 }}>
    <ellipse cx="101" cy="164" rx="58" ry="7" fill="#252323" opacity=".11"/>
    <path d="m64 127-10 28-22 4m104-32 11 28 19 4" stroke={ink} strokeWidth="7" strokeLinecap="round" fill="none"/>
    <path d="m55 75-24 7-11-17m125 12 26-9 7-17" stroke={ink} strokeWidth="6" strokeLinecap="round" fill="none"/>
    <path d="m55 16 75 3 24 26-5 91-95-3z" fill="#fffef8" stroke={ink} strokeWidth="4" strokeLinejoin="round"/>
    <path d="m130 20-1 26 25-1" fill="#ffe16b" stroke={ink} strokeWidth="3" strokeLinejoin="round"/>
    <path d="m66 30 43 2m-44 8 30 1" stroke="#3b67ed" strokeWidth="4" strokeLinecap="round"/>
    <path d="m75 69 1 10m39-10 1 10" stroke={ink} strokeWidth="7" strokeLinecap="round"/>
    <ellipse cx="69" cy="86" rx="9" ry="5" fill="#ff9b95" opacity=".8"/><ellipse cx="124" cy="87" rx="9" ry="5" fill="#ff9b95" opacity=".8"/>
    <path d={unhappy ? "M86 101q12-13 24 0" : "M86 94q12 17 24 0"} stroke={ink} strokeWidth="3" fill="none" strokeLinecap="round"/>
    <text x="97" y="127" textAnchor="middle" fontSize="22" fontWeight="700" fill="#3b67ed">π</text>
    {!small && <><path d="m165 17 5-9m7 17 10-3M20 118l-9 5m12 4-3 10" stroke={ink} strokeWidth="3" strokeLinecap="round"/><path d="m158 103 8 2-4 7-6-3z" fill="#ffe16b" stroke={ink} strokeWidth="2"/></>}
  </motion.svg>;
}

export function RoughOutline({ seed }: { seed: number }) {
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!svg.current) return; const node = svg.current; node.replaceChildren();
    const r = rough.svg(node);
    const shape = r.rectangle(4,4,292,170,{ seed, stroke: ink, strokeWidth: 1.8, roughness: 1.05, bowing: .7 });
    shape.querySelectorAll("path").forEach(p => p.setAttribute("vector-effect","non-scaling-stroke"));
    node.appendChild(shape);
  }, [seed]);
  return <svg className="rough-outline" viewBox="0 0 300 178" preserveAspectRatio="none" ref={svg} aria-hidden="true"/>;
}

export function Machine({ stage, active }: { stage: Stage; active: boolean }) {
  const reduce = useReducedMotion();
  return <svg className={`machine machine-${stage}`} viewBox="0 0 150 100" fill="none" stroke={ink} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {stage === "inbox" && <><path d="M24 57 39 45h75l14 14v32H24z" fill="#f6bd49"/><path d="M24 59h104M45 59v13h61V59"/><motion.g animate={active && !reduce ? {y:[-4,3,-4]}: {y:0}} transition={{duration:1.3,repeat:Infinity}}><path d="m53 12 43 3 10 13-3 34-51-2z" fill="#fffef8"/><path d="m95 16-1 14 11-1M64 34h23m-24 9h32"/></motion.g><path d="m13 33-6-8m17 1-1-10m113 32 7-7"/></>}
    {stage === "search" && <><path d="m25 26 70-5 5 62-70 5z" fill="#fffef8"/><path d="m38 38 34-3m-34 16 30-2m-29 15 17-1" stroke="#8fa8f8"/><motion.g animate={active && !reduce?{x:[-3,8,-3],y:[0,-3,0]}:{x:0,y:0}} transition={{duration:1.6,repeat:Infinity}}><circle cx="92" cy="45" r="25" fill="#dce9ff" fillOpacity=".7"/><path d="m109 65 23 22" strokeWidth="10"/><path d="m109 65 23 22" stroke="#3b67ed" strokeWidth="5"/><path d="M80 39q5-9 14-8" stroke="#fff"/></motion.g><path d="m23 15-4-6m101 10 8-6"/></>}
    {stage === "evidence" && <><path d="M19 34q27-13 55 0 28-13 56 0v51q-28-12-56 0-28-12-55 0z" fill="#fffef8"/><path d="M74 34v51m-43-36 30-1m-30 12h25m34-12h27m-27 12h24"/><path d="m87 15 25-3 2 15-26 4z" fill="#ffe16b"/><path d="m45 12 4 20" stroke="#3b67ed" strokeWidth="6"/><path d="m34 70 22-1m32 1h31" stroke="#3b67ed" strokeWidth="4"/></>}
    {stage === "draft" && <><path d="m28 23 70-2 5 67-76 3z" fill="#fffef8"/><path d="M39 38h39M39 53h26m-27 16h37" stroke="#b5b5b0"/><path d="m38 52 29 2" stroke="#e26763" strokeWidth="4"/><path d="m39 70 30-2" stroke="#3b67ed" strokeWidth="4"/><motion.g animate={active&&!reduce?{rotate:[-3,4,-3]}:{rotate:0}} transition={{duration:1,repeat:Infinity}}><path d="m112 15 13 8-37 51-16 8 2-17z" fill="#ffe16b"/><path d="m74 65 14 9m-13-9-3 17 16-8m18-47 13 8"/></motion.g></>}
    {stage === "approval" && <><path d="m25 70 96-3 3 23-100 2z" fill="#fffef8"/><motion.g animate={active&&!reduce?{y:[0,8,0]}:{y:0}} transition={{duration:1.4,repeat:Infinity}}><path d="M62 50V35q-13-2-11-14 3-18 22-16 19-1 22 16 2 12-11 15v14" fill="#f3a1a2"/><path d="M43 50h60l8 16H36z" fill="#ef716c"/><path d="M38 67h72" strokeWidth="5"/></motion.g><path d="m14 57-7-4m120 3 9-7m-19-31 5-9"/></>}
    {stage === "delivery" && <><path d="M24 44h104v43H24z" fill="#9cb8fc"/><path d="m24 44 52 28 52-28M24 87l30-25m74 25-29-25"/><path d="m48 12 51 2 5 39-28 15-28-15z" fill="#fffef8"/><path d="m62 35 10 9 18-20" stroke="#3b67ed" strokeWidth="5"/><path d="m15 20-7-6m124 15 7-8M8 77l-6 4"/></>}
  </svg>;
}
