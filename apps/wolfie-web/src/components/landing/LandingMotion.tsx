import {
  LazyMotion,
  domAnimation,
  m,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";

const PREMIUM_EASE = [0.22, 1, 0.36, 1] as const;

export function LandingMotionRoot({ children }: { children: ReactNode }) {
  return <LazyMotion features={domAnimation}>{children}</LazyMotion>;
}

export function PageScrollProgress() {
  const reducedMotion = useReducedMotion();
  const { scrollYProgress } = useScroll();

  if (reducedMotion) return null;

  return (
    <m.div
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-[70] h-[3px] origin-left bg-[linear-gradient(90deg,#cc213b,#ff765f,#ffb45f)] shadow-[0_1px_10px_rgba(204,33,59,.24)]"
      style={{ scaleX: scrollYProgress }}
    />
  );
}

export function Reveal({
  children,
  className = "",
  delay = 0,
  direction = "up",
  amount = 0.18,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  direction?: "up" | "left" | "right" | "scale";
  amount?: number;
}) {
  const reducedMotion = useReducedMotion();
  const offset = direction === "left"
    ? { x: -24, y: 0, scale: 1 }
    : direction === "right"
      ? { x: 24, y: 0, scale: 1 }
      : direction === "scale"
        ? { x: 0, y: 12, scale: 0.965 }
        : { x: 0, y: 24, scale: 1 };

  return (
    <m.div
      className={className}
      initial={reducedMotion ? false : { opacity: 0, ...offset }}
      whileInView={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      viewport={{ once: true, amount, margin: "0px 0px -8% 0px" }}
      transition={{ duration: 0.72, delay, ease: PREMIUM_EASE }}
    >
      {children}
    </m.div>
  );
}

function useWideViewport() {
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return wide;
}

export function ParallaxVisual({
  children,
  className = "",
  distance = 18,
}: {
  children: ReactNode;
  className?: string;
  distance?: number;
}) {
  const targetRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const wideViewport = useWideViewport();
  const { scrollYProgress } = useScroll({
    target: targetRef,
    offset: ["start end", "end start"],
  });
  const y = useTransform(scrollYProgress, [0, 1], [-distance, distance]);
  const scale = useTransform(scrollYProgress, [0, 1], [1.018, 0.992]);
  const enabled = wideViewport && !reducedMotion;

  return (
    <div ref={targetRef} className={`overflow-hidden ${className}`}>
      <m.div className="h-full w-full" style={enabled ? { y, scale } : undefined}>
        {children}
      </m.div>
    </div>
  );
}
