"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

interface Drag {
  field: string;
  width: number;
  offsetX: number;
  offsetY: number;
}
interface Session extends Drag {
  element: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
}

/** Mouse-only dragging. Touch and keyboard retain the ordinary button action. */
export function useSourceDrag(onDrop: (columnId: string, field: string) => void, onActiveChange?: (active: boolean) => void) {
  const root = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const session = useRef<Session | null>(null);
  const callbacks = useRef({ onDrop, onActiveChange });
  const frame = useRef<number | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);

  useLayoutEffect(() => { callbacks.current = { onDrop, onActiveChange }; }, [onDrop, onActiveChange]);

  const targetAt = useCallback((x: number, y: number) => {
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-mapping-column-id]");
    return target && root.current?.contains(target) ? target.dataset.mappingColumnId ?? null : null;
  }, []);

  const position = useCallback(() => {
    const current = session.current;
    if (!current) return;
    const element = preview.current;
    if (element) {
      const x = Math.max(8, Math.min(current.x - current.offsetX, window.innerWidth - current.width - 8));
      const y = Math.max(8, Math.min(current.y - current.offsetY, window.innerHeight - element.offsetHeight - 8));
      element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    setOverColumn(targetAt(current.x, current.y));
  }, [targetAt]);

  useLayoutEffect(() => { if (drag) position(); }, [drag, position]);

  const clear = useCallback((unmount = false) => {
    const current = session.current;
    session.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (current?.element.hasPointerCapture?.(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    if (current) callbacks.current.onActiveChange?.(false);
    if (current?.active) {
      // A mouse click may follow pointerup even after a drag. Do not select the source again.
      clickTimer.current = setTimeout(() => { suppressClick.current = false; clickTimer.current = null; }, 0);
    }
    if (!unmount) { setDrag(null); setOverColumn(null); }
  }, []);

  const begin = useCallback((event: ReactPointerEvent<HTMLElement>, field: string) => {
    suppressClick.current = false;
    if (event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary || session.current) return;
    const element = event.currentTarget;
    const bounds = element.getBoundingClientRect();
    const width = Math.min(bounds.width, window.innerWidth - 16);
    session.current = { field, element, pointerId: event.pointerId,
      width, offsetX: Math.min(event.clientX - bounds.left, width), offsetY: event.clientY - bounds.top,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false };
    element.setPointerCapture?.(event.pointerId);
    // Lift immediately on press; the movement threshold still protects click selection and assignment.
    setDrag({ field, width, offsetX: session.current.offsetX, offsetY: session.current.offsetY });
    callbacks.current.onActiveChange?.(true);
  }, []);

  useEffect(() => {
    const schedule = () => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => { frame.current = null; position(); });
    };
    const move = (event: PointerEvent) => {
      const current = session.current;
      if (!current || event.pointerId !== current.pointerId) return;
      current.x = event.clientX;
      current.y = event.clientY;
      if (!current.active && Math.hypot(current.x - current.startX, current.y - current.startY) >= 6) {
        current.active = true;
        suppressClick.current = true;

      }
      if (current.active) event.preventDefault();
      schedule();
    };
    const up = (event: PointerEvent) => {
      const current = session.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const columnId = current.active ? targetAt(event.clientX, event.clientY) : null;
      clear();
      if (columnId) callbacks.current.onDrop(columnId, current.field);
    };
    const cancel = () => clear();
    const pointerCancel = (event: PointerEvent) => {
      if (session.current?.pointerId === event.pointerId) clear();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current) { event.preventDefault(); clear(); }
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("lostpointercapture", pointerCancel);
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", cancel);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("lostpointercapture", pointerCancel);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", cancel);
      clear(true);
      if (clickTimer.current !== null) clearTimeout(clickTimer.current);
    };
  }, [clear, position, targetAt]);

  const consumeClick = (detail: number) => detail !== 0 && suppressClick.current;
  return { rootRef: root, previewRef: preview, drag, overColumn, begin, consumeClick };
}
