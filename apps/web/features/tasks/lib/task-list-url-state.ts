import { useEffect } from "react";

/** The filters of the Tasks and Board views. They live in the list URL, so Back, reload, and a copied link restore the same view. */
export type TaskListFilters = {
  archived: boolean;
  status: string;
  projectId: string;
  query: string;
  boardView: "compact" | "full";
  boardStatus: string;
  boardShow: "all" | "tasks" | "moves";
};

const RETURN_KEY = "suplex.tasks.returnTo";
const SCROLL_KEY = "suplex.tasks.scroll";

function isListPath(path: string): boolean {
  return /^\/(?:tasks|board)(?:[?#]|$)/.test(path);
}

export function readTaskListFilters(): TaskListFilters {
  const params = new URLSearchParams(window.location.search);
  return {
    archived: params.get("archived") === "1",
    status: params.get("status") ?? "all",
    projectId: params.get("project") ?? "all",
    query: params.get("q") ?? "",
    boardView: params.get("view") === "full" ? "full" : "compact",
    boardStatus: params.get("boardStatus") ?? "all",
    boardShow: params.get("show") === "tasks" ? "tasks" : params.get("show") === "moves" ? "moves" : "all",
  };
}

/** Writes the filters to the list URL and remembers that URL as the place a task page returns to. */
export function useTaskListUrl(filters: TaskListFilters, onList: boolean): void {
  const { archived, status, projectId, query, boardView, boardStatus, boardShow } = filters;
  useEffect(() => {
    if (!onList) return;
    const url = new URL(window.location.href);
    const set = (key: string, value: string, fallback: string): void => {
      if (value === fallback) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    };
    set("archived", archived ? "1" : "0", "0");
    set("status", status, "all");
    set("project", projectId, "all");
    set("q", query, "");
    set("view", boardView, "compact");
    set("boardStatus", boardStatus, "all");
    set("show", boardShow, "all");
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, "", next);
    try { window.sessionStorage.setItem(RETURN_KEY, next); } catch { /* Browser storage can be disabled. */ }
  }, [onList, archived, status, projectId, query, boardView, boardStatus, boardShow]);
}

/** The Tasks or Board view the person last had open, with its filters, or the fallback. */
export function taskListReturnHref(fallback: string): string {
  try {
    const saved = window.sessionStorage.getItem(RETURN_KEY);
    if (saved && isListPath(saved)) return saved;
  } catch { /* Browser storage can be disabled. */ }
  return fallback;
}

/** Keeps the page and board scroll positions of a list view, and restores them when the same view opens again. */
export function useTaskListScroll(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const board = (): HTMLElement | null => document.querySelector("[data-task-board]");
    // The list's own path, read before a task opens; filters are left out because the URL can change while the list stays open.
    const view = window.location.pathname;
    let restoring = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(SCROLL_KEY) ?? "null") as { view: string; y: number; x: number } | null;
      if (saved?.view === view) {
        // Rows can arrive after the first render, so try again until the page is tall enough or a second has passed.
        const started = performance.now();
        const restore = (): void => {
          window.scrollTo(0, saved.y);
          board()?.scrollTo(saved.x, 0);
          if (Math.abs(window.scrollY - saved.y) > 1 && performance.now() - started < 1000) timer = setTimeout(restore, 50);
          else restoring = false;
        };
        timer = setTimeout(restore, 0);
      } else restoring = false;
    } catch { restoring = false; }
    const save = (): void => {
      if (restoring || window.location.pathname !== view) return;
      try { window.sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ view, y: window.scrollY, x: board()?.scrollLeft ?? 0 })); } catch { /* Browser storage can be disabled. */ }
    };
    window.addEventListener("scroll", save, { passive: true });
    document.addEventListener("scroll", save, { passive: true, capture: true });
    // A click can open a task before the next scroll event arrives, so save on the click too.
    document.addEventListener("click", save, { capture: true });
    return () => { clearTimeout(timer); window.removeEventListener("scroll", save); document.removeEventListener("scroll", save, { capture: true }); document.removeEventListener("click", save, { capture: true }); };
  }, [ready]);
}
