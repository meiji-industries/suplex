import { Moon, Sun } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";

import { Button } from "../ui/button.js";

export const themeStorageKey = "suplex.theme";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

type ThemeContextValue = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function parseThemePreference(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readThemePreference(): ThemePreference {
  try { return parseThemePreference(window.localStorage.getItem(themeStorageKey)); }
  catch { return "system"; }
}

function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0a0a0a" : "#ffffff");
}

function saveThemePreference(preference: ResolvedTheme): void {
  try { window.localStorage.setItem(themeStorageKey, preference); }
  catch { /* Browser storage can be disabled. */ }
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(readThemePreference(), systemPrefersDark()));

  const updateTheme = useCallback((nextPreference: ThemePreference): void => {
    const nextTheme = resolveTheme(nextPreference, systemPrefersDark());
    setPreference(nextPreference);
    setResolvedTheme(nextTheme);
    applyTheme(nextTheme);
  }, []);

  useEffect(() => {
    updateTheme(readThemePreference());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemTheme = (): void => {
      setPreference(current => {
        if (current === "system") {
          const nextTheme = resolveTheme(current, media.matches);
          setResolvedTheme(nextTheme);
          applyTheme(nextTheme);
        }
        return current;
      });
    };
    const handleStorage = (event: StorageEvent): void => {
      if (event.key === themeStorageKey || event.key === null) updateTheme(parseThemePreference(event.newValue));
    };
    media.addEventListener("change", handleSystemTheme);
    window.addEventListener("storage", handleStorage);
    return () => {
      media.removeEventListener("change", handleSystemTheme);
      window.removeEventListener("storage", handleStorage);
    };
  }, [updateTheme]);

  const toggleTheme = useCallback((): void => {
    const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
    saveThemePreference(nextTheme);
    updateTheme(nextTheme);
  }, [resolvedTheme, updateTheme]);

  return <ThemeContext.Provider value={{ preference, resolvedTheme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("Theme is not available outside ThemeProvider");
  return value;
}

export function ThemeToggle(): ReactElement {
  const { resolvedTheme, toggleTheme } = useTheme();
  const label = resolvedTheme === "dark" ? "Use light theme" : "Use dark theme";
  return <Button type="button" variant="ghost" size="icon" aria-label={label} title={label} onClick={toggleTheme}>{resolvedTheme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</Button>;
}
