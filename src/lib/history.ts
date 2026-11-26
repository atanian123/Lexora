import { useEffect, useRef } from "react";

let entryCounter = 0;

/**
 * Gives a temporary state (a study session, an open menu) its own browser history entry, so the
 * phone's back button dismisses it instead of leaving the screen or the app.
 *
 * While `active` is true, one history entry sits on top, tagged under `marker` with an ID unique
 * to this activation. Back pops it and calls `onDismiss`. When the state ends some other way, the
 * entry is removed again so it does not cost an extra back press later.
 *
 * An entry for a session or menu that is already closed can be reached again with Forward. It is
 * stale: the state it stood for cannot come back, so the hook steps back off it, and strips the tag
 * from one it finds on mount, so it can never be mistaken for a later activation's entry.
 */
export function useBackDismiss(active: boolean, onDismiss: () => void, marker: string): void {
  const entryId = useRef<string | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (active && !entryId.current) {
      entryCounter += 1;
      const id = `${marker}:${Date.now()}:${entryCounter}`;
      window.history.pushState({ ...(window.history.state ?? {}), [marker]: id }, "");
      entryId.current = id;
    } else if (!active && entryId.current) {
      const id = entryId.current;
      entryId.current = null;
      if (window.history.state?.[marker] === id) window.history.back();
    }
  }, [active, marker]);

  useEffect(() => {
    const stateWithoutMarker = () => {
      const state = { ...(window.history.state ?? {}) };
      delete state[marker];
      return state;
    };

    if (window.history.state?.[marker] && window.history.state[marker] !== entryId.current) {
      window.history.replaceState(stateWithoutMarker(), "");
    }

    const handlePopState = () => {
      const reached = window.history.state?.[marker];
      if (entryId.current && reached !== entryId.current) {
        entryId.current = null;
        dismiss.current();
        return;
      }
      if (reached && reached !== entryId.current) {
        // Forward onto a closed session or menu: there is nothing to restore, so step back off it.
        window.history.back();
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [marker]);
}
