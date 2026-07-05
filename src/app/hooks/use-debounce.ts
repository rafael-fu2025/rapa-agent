// Debounce a value. Returns the most recent value of `value` after
// it has been stable for `delay` ms. Useful for search inputs
// where you want to wait for the user to stop typing before
// firing a network request.
//
// We use useState + setTimeout rather than useEffect so the
// returned value updates synchronously on the trailing edge —
// that way the search effect can depend on `debouncedValue`
// directly and re-fire at most once per debounce window.
import { useEffect, useState } from "react";

export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
