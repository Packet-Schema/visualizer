"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  value: number;
  min: number;
  max: number;
  visible: boolean;
  /** The range input this tooltip is anchored to. */
  inputRef: React.RefObject<HTMLInputElement | null>;
};

/**
 * Floating value chip rendered above the range slider thumb. Anchored to the
 * input via its ref so we don't need to fight the browser-default native
 * thumb positioning.
 */
export default function SliderTooltip({
  value,
  min,
  max,
  visible,
  inputRef,
}: Props) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const w = input.offsetWidth;
    const thumbW = 16;
    const range = max - min || 1;
    const ratio = (value - min) / range;
    const x = ratio * (w - thumbW) + thumbW / 2;
    setLeft(x);
  }, [value, min, max, inputRef, visible]);

  if (!visible) return null;
  return (
    <span ref={ref} className="slider-tooltip" style={{ left }} aria-hidden="true">
      {value}
    </span>
  );
}
