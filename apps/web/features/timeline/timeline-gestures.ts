import { useEffect, useRef, type RefObject } from "react";

import { minimumVisibleMs, type TimelineRange } from "./timeline-model.js";

/**
 * Trackpad, wheel, and touch gestures for the timeline chart.
 *
 * - Pinch on a trackpad, or Ctrl + wheel, zooms around the pointer. Browsers report a trackpad pinch as a wheel event with ctrlKey.
 * - A sideways two-finger scroll, or Shift + wheel, moves the view through time. Vertical scrolling still scrolls the page.
 * - On a touch screen, two fingers pinch to zoom and drag to move. One finger still scrolls the page.
 */
export function useTimelineGestures({
  chart,
  labelWidth,
  range,
  fullRange,
  onRangeChange,
  onGestureStart,
}: {
  chart: RefObject<HTMLDivElement | null>;
  labelWidth: number;
  range: TimelineRange;
  fullRange: TimelineRange;
  onRangeChange: (range: TimelineRange) => void;
  onGestureStart: () => void;
}): RefObject<boolean> {
  const latest = useRef({ range, fullRange, onRangeChange, onGestureStart });
  latest.current = { range, fullRange, onRangeChange, onGestureStart };
  const touching = useRef(false);

  useEffect(() => {
    const element = chart.current;
    if (!element) return;
    const plot = (): { left: number; width: number } => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left + labelWidth, width: Math.max(1, rect.width - labelWidth) };
    };
    const fractionAt = (clientX: number): number => {
      const { left, width } = plot();
      return Math.max(0, Math.min(1, (clientX - left) / width));
    };
    // Keeps the duration between the minimum zoom and the whole range, and keeps the window inside the range.
    // Trackpads send many events between renders, so each step starts from the last range this hook sent.
    const apply = (next: TimelineRange): void => {
      latest.current.range = next;
      latest.current.onRangeChange(next);
    };
    const place = (start: number, duration: number): TimelineRange => {
      const { fullRange: bounds } = latest.current;
      const available = Math.max(1, bounds.end - bounds.start);
      const length = Math.min(available, Math.max(Math.min(minimumVisibleMs, available), duration));
      const from = Math.max(bounds.start, Math.min(bounds.end - length, start));
      return { start: from, end: from + length };
    };

    const onWheel = (event: WheelEvent): void => {
      if (event.clientX < plot().left) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      const deltaX = event.deltaX * unit;
      const deltaY = event.deltaY * unit;
      const current = latest.current.range;
      const duration = current.end - current.start;
      if (event.ctrlKey) {
        event.preventDefault();
        const fraction = fractionAt(event.clientX);
        const anchor = current.start + fraction * duration;
        const next = duration * Math.exp(deltaY * 0.01);
        apply(place(anchor - fraction * next, next));
        return;
      }
      const sideways = event.shiftKey && deltaX === 0 ? deltaY : Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : 0;
      if (sideways === 0) return;
      event.preventDefault();
      apply(place(current.start + (sideways / plot().width) * duration, duration));
    };

    let pinch: { distance: number; anchor: number; duration: number } | null = null;
    const measure = (touches: TouchList): { distance: number; middle: number } => {
      const [a, b] = [touches[0]!, touches[1]!];
      return { distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), middle: (a.clientX + b.clientX) / 2 };
    };
    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 2) return;
      const { range: current, onGestureStart: start } = latest.current;
      touching.current = true;
      start();
      const { distance, middle } = measure(event.touches);
      const duration = current.end - current.start;
      pinch = { distance, anchor: current.start + fractionAt(middle) * duration, duration };
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const { distance, middle } = measure(event.touches);
      const next = pinch.duration * (pinch.distance / distance);
      apply(place(pinch.anchor - fractionAt(middle) * next, next));
    };
    const onTouchEnd = (event: TouchEvent): void => {
      if (event.touches.length >= 2) return;
      pinch = null;
      if (event.touches.length === 0) touching.current = false;
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchEnd);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [chart, labelWidth]);

  return touching;
}
