import { useState, type RefObject } from "react";

interface SharedPopupActions {
  close: () => void;
  unmount: () => void;
}

export interface SharedPopup {
  /** Pass to the shared Root. */
  actionsRef: RefObject<SharedPopupActions | null>;
  /** Pass to the shared Root. */
  onOpenChange: (open: boolean, details: { trigger?: Element | undefined }) => void;
  /** Pass to every trigger of the shared Root. */
  triggerRef: (trigger: HTMLElement | null) => (() => void) | undefined;
}

function createSharedPopup(): SharedPopup {
  let activeTriggerId: string | null = null;
  const actionsRef: SharedPopup["actionsRef"] = { current: null };
  return {
    actionsRef,
    onOpenChange: (open, details) => {
      activeTriggerId = open ? (details.trigger?.id ?? null) : null;
    },
    triggerRef: (trigger) => {
      if (!trigger) return;
      return () => {
        // React detaches refs before it removes the element, so check once the commit is done.
        queueMicrotask(() => {
          if (activeTriggerId === trigger.id && !trigger.isConnected) {
            actionsRef.current?.close();
          }
        });
      };
    },
  };
}

/**
 * Lets one page-level popup Root serve many row triggers while still closing
 * when the trigger that opened it unmounts, as a per-row Root would.
 */
export function useSharedPopup(): SharedPopup {
  const [popup] = useState(createSharedPopup);
  return popup;
}
