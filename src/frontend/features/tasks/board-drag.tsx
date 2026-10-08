import { useEffect, useLayoutEffect, type ReactElement, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { animate, motion, useMotionValue, useSpring, useTransform, useVelocity } from "motion/react";
import type { TaskControlStatus } from "../../contracts/task-control.js";

/** A card that you lift off the board. `dropLeft` is the left edge of the column it was dropped on. */
export type BoardLift = { id: string; from: TaskControlStatus; offsetX: number; offsetY: number; width: number; clientX: number; clientY: number; dropLeft?: number };

type Landing = { left: number; top: number; rotate: number; scale: number };
// The lifted card writes its last position here when it disappears. The board card reads it once and flies from there to its slot.
const landings = new Map<string, Landing>();

const follow = { stiffness: 700, damping: 45, mass: 0.6 };
const sway = { stiffness: 260, damping: 14 };
const settle = { type: "spring", stiffness: 520, damping: 34 } as const;
const lifted = 1.04;

let blankImage: HTMLImageElement | undefined;
/** Replaces the static browser drag image so the lifted card can move with physics. */
export function hideNativeDragImage(dataTransfer: DataTransfer): void {
  if (typeof Image === "undefined" || typeof dataTransfer.setDragImage !== "function") return;
  blankImage ??= Object.assign(new Image(), { src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" });
  dataTransfer.setDragImage(blankImage, 0, 0);
}

/** The lifted card. It follows the pointer on a spring, tilts with its speed, and snaps to the column you drop it on. */
export function BoardDragOverlay({ lift, children }: { lift: BoardLift; children: ReactNode }): ReactElement {
  const x = useMotionValue(lift.clientX - lift.offsetX);
  const y = useMotionValue(lift.clientY - lift.offsetY);
  const springX = useSpring(x, follow);
  const springY = useSpring(y, follow);
  const tilt = useTransform(useVelocity(springX), [-2400, 0, 2400], [-10, 0, 10], { clamp: true });
  const rotate = useSpring(tilt, sway);
  const scale = useSpring(1, sway);
  useEffect(() => { scale.set(lifted); }, [scale]);
  const { offsetX, offsetY, dropLeft } = lift;
  useEffect(() => {
    if (dropLeft !== undefined) { x.set(dropLeft); return; }
    // Native drag reports the pointer through dragover on whatever element it is over.
    const track = (event: DragEvent) => { x.set(event.clientX - offsetX); y.set(event.clientY - offsetY); };
    document.addEventListener("dragover", track);
    return () => document.removeEventListener("dragover", track);
  }, [dropLeft, offsetX, offsetY, x, y]);
  useLayoutEffect(() => () => { landings.set(lift.id, { left: springX.get(), top: springY.get(), rotate: rotate.get(), scale: scale.get() }); }, [lift.id, springX, springY, rotate, scale]);
  return createPortal(<motion.div aria-hidden="true" data-board-drag-overlay className="pointer-events-none fixed top-0 left-0 z-50 rounded-md shadow-lg" style={{ x: springX, y: springY, rotate, scale, width: lift.width }}>{children}</motion.div>, document.body);
}

/** Flies a board card from where the lifted card disappeared into its slot. */
export function useBoardLanding(ref: RefObject<HTMLElement | null>, id: string, hidden: boolean, status: TaskControlStatus): void {
  useLayoutEffect(() => {
    const landing = landings.get(id);
    const node = ref.current;
    if (!landing || !node || hidden) return;
    landings.delete(id);
    const to = node.getBoundingClientRect();
    if (typeof node.animate !== "function") return;
    node.style.zIndex = "20";
    void animate(node, { x: [landing.left - to.left, 0], y: [landing.top - to.top, 0], rotate: [landing.rotate, 0], scale: [landing.scale, 1] }, settle).then(() => { node.style.zIndex = ""; });
  }, [ref, id, hidden, status]);
}
