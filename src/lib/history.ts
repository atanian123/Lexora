import { useEffect, useRef } from "react";

let entryCounter = 0;

export function navigateToView(view: string): void {
  const state = window.history.state;
  if (state?.lexoraSession || state?.lexoraMenu) {
    // The view underneath this temporary entry is already in history.
    window.history.replaceState({ view }, "", `#${view}`);
  } else {
    window.history.pushState({ view }, "", `#${view}`);
  }
}

/**
 * Gives a session or menu its own history entry so Back dismisses it. Forward can revisit a
 * closed entry without reopening it. The next activation reuses that slot.
 */
export function useBackDismiss(active: boolean, onDismiss: () => void, marker: string): void {
  const entryId = useRef<string | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (active && !entryId.current) {
      entryCounter += 1;
      const id = `${marker}:${Date.now()}:${entryCounter}`;
      const state = window.history.state;
      const entry = { ...(state ?? {}), [marker]: id };
      if (state?.[marker]) window.history.replaceState(entry, "");
      else window.history.pushState(entry, "");
      entryId.current = id;
    } else if (!active && entryId.current) {
      const id = entryId.current;
      entryId.current = null;
      if (window.history.state?.[marker] === id) window.history.back();
    }
  }, [active, marker]);

  useEffect(() => {
    const handlePopState = () => {
      const reached = window.history.state?.[marker];
      if (entryId.current && reached !== entryId.current) {
        entryId.current = null;
        dismiss.current();
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [marker]);
}
