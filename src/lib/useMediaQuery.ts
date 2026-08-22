"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * SSR-safe media query hook, built on `useSyncExternalStore` (the React-
 * idiomatic way to read an external, possibly-changing value like
 * `matchMedia` without the "setState inside an effect" cascading-render
 * problem `react-hooks/set-state-in-effect` warns about). The server
 * snapshot is always `false` — there is no viewport on the server — so SSR
 * and the very first client render both render the phone/mobile branch;
 * once hydrated, `getSnapshot` reads the real `matchMedia` result and stays
 * subscribed to further changes (e.g. resizing across the breakpoint).
 *
 * Consumers that need "render the phone version first, upgrade to desktop
 * after hydration" — e.g. deciding whether to mount a modal bottom sheet vs.
 * a persistent sticky side panel, where the two are different component
 * trees with different side effects (scroll lock, ARIA `dialog` semantics),
 * not just different CSS — get exactly that.
 *
 * For anything that's a pure CSS difference (spacing, columns, widths),
 * prefer a Tailwind `lg:` variant instead of this hook — it's for
 * structural/mounting decisions only.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  const getServerSnapshot = useCallback(() => false, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
