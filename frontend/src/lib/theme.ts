import { useSyncExternalStore } from "react";

// Tema (koyu/açık) <html data-theme> ile CSS'e yansır. İlk değer index.html'deki inline script
// tarafından sayfa çizilmeden önce yazılır; burası sonraki değişiklikleri yönetir.
export type Theme = "dark" | "light";

const THEME_KEY = "wp:theme";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Kalıcılık olmadan devam edilir.
  }
}

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function storedTheme(): Theme | null {
  const t = read(THEME_KEY);
  return t === "dark" || t === "light" ? t : null;
}

function currentTheme(): Theme {
  return storedTheme() ?? (systemDark.matches ? "dark" : "light");
}

let theme = currentTheme();

function apply() {
  theme = currentTheme();
  document.documentElement.dataset.theme = theme;
  listeners.forEach((l) => l());
}

// Kullanıcı tema seçmediyse sistem tercihini canlı takip et.
systemDark.addEventListener("change", () => {
  if (!storedTheme()) apply();
});

export function toggleTheme() {
  write(THEME_KEY, theme === "dark" ? "light" : "dark");
  apply();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => theme);
}
