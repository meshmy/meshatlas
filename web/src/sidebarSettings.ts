const STORAGE_KEY = "meshatlas:sidebar-settings";

type StoredValue = string | boolean;
type StoredValues = Record<string, StoredValue>;

/** Every persistable control is looked up by its own element `id` -- there's
 * no fixed list of "the sidebar settings" anywhere in this module. Any
 * `<input>`/`<select>` with an id, present in the sidebar HTML or added to
 * it later (e.g. the per-system checkboxes built from GET /api/systems),
 * is saved and restored automatically. Adding a new control to the sidebar
 * needs no change here to get persistence -- see restoreAll()/watchAndPersist(). */

function readStore(): StoredValues {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(values: StoredValues): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Storage full or disabled -- persistence is a nice-to-have, not
    // worth surfacing an error for.
  }
}

/** Reads whatever was last saved for `id`, without needing a live DOM
 * element -- for the rare case (theme.ts's resolveInitialTheme()) that
 * needs a stored value before its control exists in the DOM yet. */
export function getStoredValue(id: string): StoredValue | undefined {
  return readStore()[id];
}

function isPersistable(target: EventTarget | null): target is HTMLInputElement | HTMLSelectElement {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement;
}

/** Applies whatever was last saved for `el.id`, if anything, to `el`'s
 * value/checked state. Returns whether it actually applied a saved value,
 * so callers can tell "nothing to restore" apart from "restored, but it
 * happens to match the default" -- e.g. to decide whether to re-fire the
 * control's own change handling (see dispatchRestored() below). A no-op,
 * leaving the HTML-authored default in place, when: `el` has no id,
 * nothing was ever saved for that id, or (for a `<select>` whose options
 * are populated after the fact, like the region filter) the saved value
 * doesn't match any option currently present. */
export function restoreControl(el: HTMLInputElement | HTMLSelectElement): boolean {
  if (!el.id) return false;
  const stored = readStore()[el.id];
  if (stored === undefined) return false;
  if (el instanceof HTMLInputElement && el.type === "checkbox") {
    if (typeof stored !== "boolean") return false;
    el.checked = stored;
    return true;
  }
  if (typeof stored !== "string") return false;
  el.value = stored;
  return true;
}

/** Restores every id'd `<input>`/`<select>` currently under `container`,
 * and returns the ones that actually had a saved value applied. Safe to
 * call more than once (e.g. once early for whatever's in the static HTML,
 * again later once the map/region dropdown are ready) -- restoring an
 * already-restored control is a no-op. */
export function restoreAll(container: ParentNode): (HTMLInputElement | HTMLSelectElement)[] {
  const restored: (HTMLInputElement | HTMLSelectElement)[] = [];
  for (const el of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[id], select[id]")) {
    if (restoreControl(el)) restored.push(el);
  }
  return restored;
}

/** Re-fires "input" then "change" on each of `elements` so whatever
 * business logic is already wired to that control (a data refetch, a map
 * layer filter, a terrain/building redraw...) applies the restored value
 * exactly as it would a real user interaction -- without this module
 * needing to know what any given control actually does. */
export function dispatchRestored(elements: readonly (HTMLInputElement | HTMLSelectElement)[]): void {
  for (const el of elements) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

/** Delegates a single "change" listener on `container` that saves any id'd
 * `<input>`/`<select>` inside it the moment it changes. Delegated rather
 * than attached per-control so it also covers elements added to the DOM
 * later (the systems checklist) with no extra wiring at the call site. */
export function watchAndPersist(container: HTMLElement): void {
  container.addEventListener("change", (event) => {
    const el = event.target;
    if (!isPersistable(el) || !el.id) return;
    const store = readStore();
    store[el.id] = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : el.value;
    writeStore(store);
  });
}
