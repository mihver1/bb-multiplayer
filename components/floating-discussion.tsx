import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { IconAction } from "./icon-action";

type Point = { x: number; y: number };
type Size = { width: number; height: number };
export function clampWidgetPosition(
  point: Point,
  size: Size,
  viewport: Size,
): Point {
  return {
    x: Math.min(
      Math.max(8, point.x),
      Math.max(8, viewport.width - size.width - 8),
    ),
    y: Math.min(
      Math.max(8, point.y),
      Math.max(8, viewport.height - size.height - 8),
    ),
  };
}

/** Plugin-owned floating chrome. No selectors or mutations of BB's DOM.
 * Non-modal on desktop: only this surface catches keys, never the host page.
 */
export function FloatingDiscussion({
  title,
  subtitle,
  badge,
  open,
  onOpenChange,
  headerActions,
  children,
}: {
  title: string;
  subtitle: string;
  badge: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  headerActions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<Point | null>(null);
  const drag = useRef<{ id: number; pointer: Point; origin: Point } | null>(
    null,
  );

  useEffect(() => {
    if (!open) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // An anchored message action may already have focused the reply input.
    if (!(
      document.activeElement instanceof HTMLTextAreaElement &&
      root.current?.contains(document.activeElement)
    )) {
      close.current?.focus({ preventScroll: true });
    }
  }, [open]);

  // Clamp only the widget's own bounds after drag, resize or expansion. A
  // ResizeObserver avoids reading or watching the host's layout or timeline.
  useEffect(() => {
    const reposition = () => {
      const rect = root.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition((old) => {
        if (!old) return old;
        const next = clampWidgetPosition(old, rect, {
          width: window.innerWidth,
          height: window.innerHeight,
        });
        return next.x === old.x && next.y === old.y ? old : next;
      });
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(reposition);
    if (root.current) observer?.observe(root.current);
    window.addEventListener("resize", reposition);
    reposition();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", reposition);
    };
  }, []);

  function minimize() {
    onOpenChange(false);
    const previous = returnFocus.current;
    // Prefer the floating launcher; it stays mounted in the same thread.
    if (launcher.current) launcher.current.focus({ preventScroll: true });
    else if (previous?.isConnected) previous.focus({ preventScroll: true });
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !root.current || window.innerWidth < 640) return;
    const rect = root.current.getBoundingClientRect();
    drag.current = {
      id: event.pointerId,
      pointer: { x: event.clientX, y: event.clientY },
      origin: { x: rect.x, y: rect.y },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current,
      rect = root.current?.getBoundingClientRect();
    if (!current || current.id !== event.pointerId || !rect) return;
    setPosition(
      clampWidgetPosition(
        {
          x: current.origin.x + event.clientX - current.pointer.x,
          y: current.origin.y + event.clientY - current.pointer.y,
        },
        rect,
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }
  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const style: CSSProperties = position
    ? { left: position.x, top: position.y }
    : {
        right: "max(1rem, env(safe-area-inset-right))",
        bottom: "max(1rem, env(safe-area-inset-bottom))",
      };

  return (
    <div
      ref={root}
      style={style}
      className="fixed z-40 flex max-w-[calc(100vw-32px)] flex-col-reverse gap-2"
      data-multiplayer-widget=""
    >
      <div className="flex justify-end">
        <Button
          ref={launcher}
          aria-expanded={open}
          aria-controls={id}
          aria-label={`Team discussion · ${badge} comments`}
          variant="outline"
          className="gap-2 rounded-full bg-card shadow-lg"
          onClick={() => onOpenChange(!open)}
        >
          <Icon name="multiplayer/people" className="size-4" />
          <span>Team</span>
          <span className="rounded-full bg-muted px-2 text-xs">{badge}</span>
        </Button>
      </div>
      <section
        id={id}
        hidden={!open}
        role="dialog"
        aria-modal={false}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-subtitle`}
        className="multiplayer-widget-dialog flex min-h-0 w-[min(420px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            minimize();
          } else if (event.target instanceof HTMLTextAreaElement)
            event.stopPropagation();
        }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <button
            type="button"
            aria-label="Move team widget"
            title="Drag to move; double-click to reset"
            className="hidden cursor-grab touch-none rounded p-1 text-muted-foreground focus-visible:outline sm:block"
            onPointerDown={startDrag}
            onPointerMove={move}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={() => {
              drag.current = null;
            }}
            onDoubleClick={() => setPosition(null)}
            onKeyDown={(event) => {
              const directions: Record<string, Point> = {
                ArrowLeft: { x: -24, y: 0 },
                ArrowRight: { x: 24, y: 0 },
                ArrowUp: { x: 0, y: -24 },
                ArrowDown: { x: 0, y: 24 },
              };
              const delta = directions[event.key],
                rect = root.current?.getBoundingClientRect();
              if (!delta || !rect) return;
              event.preventDefault();
              event.stopPropagation();
              setPosition(
                clampWidgetPosition(
                  { x: rect.x + delta.x, y: rect.y + delta.y },
                  rect,
                  { width: window.innerWidth, height: window.innerHeight },
                ),
              );
            }}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="size-4"
              fill="currentColor"
            >
              <circle cx="5" cy="3" r="1.25" />
              <circle cx="11" cy="3" r="1.25" />
              <circle cx="5" cy="8" r="1.25" />
              <circle cx="11" cy="8" r="1.25" />
              <circle cx="5" cy="13" r="1.25" />
              <circle cx="11" cy="13" r="1.25" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="truncate text-sm font-semibold">
              {title}
            </h2>
            <p
              id={`${id}-subtitle`}
              className="mt-0.5 truncate text-xs text-muted-foreground"
            >
              {subtitle}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {headerActions}
            <IconAction
              ref={close}
              label="Minimize team discussion"
              onClick={minimize}
            >
              <Icon name="X" className="size-4" />
            </IconAction>
          </div>
        </header>
        <div className="multiplayer-widget-body min-h-0 px-3 py-2">
          {children}
        </div>
      </section>
    </div>
  );
}
