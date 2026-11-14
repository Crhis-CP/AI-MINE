// Phone search (TASK-0715): the search layer is no part of any page's first download; the first open loads it.
import { createContext, useCallback, useContext, useRef, useState, type ComponentType, type ReactNode } from "react";

/** Opens phone search with a query to start from; focus goes back to the trigger when it closes. */
export type OpenSearch = (query?: string, trigger?: HTMLElement) => void;
type Panel = ComponentType<{ register: (open: OpenSearch | null) => void }>;
type Pending = { query: string; trigger: HTMLElement | undefined; field: HTMLInputElement };

const SearchContext = createContext<OpenSearch | null>(null);
export const useOpenSearch = () => useContext(SearchContext);

/**
 * Phone browsers open the software keyboard only for a field focused during the tap, and on the first open the
 * panel's own field does not exist yet: a transparent stand-in takes focus during the tap and hands it on.
 */
function holdKeyboard(): HTMLInputElement {
  const field = document.createElement("input");
  field.setAttribute("aria-hidden", "true");
  field.tabIndex = -1;
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;pointer-events:none";
  document.body.append(field);
  field.focus({ preventScroll: true });
  return field;
}

export function SearchProvider({ children }: { children: ReactNode }) {
  const [Panel, setPanel] = useState<Panel | null>(null);
  const panelOpen = useRef<OpenSearch | null>(null);
  const pending = useRef<Pending | null>(null);
  const open = useCallback<OpenSearch>((query = "", trigger) => {
    if (panelOpen.current) return panelOpen.current(query, trigger);
    pending.current?.field.remove();
    const opener = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    pending.current = { query, trigger: opener, field: holdKeyboard() };
    import("./SearchPanel").then(
      (module) => setPanel(() => module.SearchPanel),
      () => {
        // Nothing opened: put focus back where the reader was; the next tap tries again.
        const request = pending.current;
        pending.current = null;
        request?.field.remove();
        request?.trigger?.focus({ preventScroll: true });
      },
    );
  }, []);
  const register = useCallback((panel: OpenSearch | null) => {
    panelOpen.current = panel;
    const request = pending.current;
    if (!panel || !request) return;
    pending.current = null;
    panel(request.query, request.trigger);
    request.field.remove();
  }, []);
  return (
    <SearchContext.Provider value={open}>
      {children}
      {Panel && <Panel register={register} />}
    </SearchContext.Provider>
  );
}
