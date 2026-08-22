import { useEffect, useRef } from "react";

type ShortcutKey = string; // e.g., 'k', 'n', '\\', 'e'
type ShortcutAction = (e: KeyboardEvent) => void;

interface ShortcutConfig {
  key: ShortcutKey;
  ctrlOrCmd?: boolean; // Requires Ctrl on Windows/Linux or Cmd on Mac
  shift?: boolean;
  alt?: boolean;
  action: ShortcutAction;
}

export function useKeyboardShortcuts(shortcuts: ShortcutConfig[]) {
  // Callers pass an inline array, so its identity changes every render —
  // using it directly as the effect dep re-registered the window listener on
  // every render (every stream chunk). A ref keeps the listener stable while
  // still executing the latest actions.
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts if the user is typing in an input, textarea, or contenteditable
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      for (const shortcut of shortcutsRef.current) {
        const isCmdOrCtrl = e.metaKey || e.ctrlKey;
        const needsCmdOrCtrl = shortcut.ctrlOrCmd ?? false;
        const needsShift = shortcut.shift ?? false;
        const needsAlt = shortcut.alt ?? false;

        if (
          e.key.toLowerCase() === shortcut.key.toLowerCase() &&
          isCmdOrCtrl === needsCmdOrCtrl &&
          e.shiftKey === needsShift &&
          e.altKey === needsAlt
        ) {
          e.preventDefault();
          shortcut.action(e);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
}
