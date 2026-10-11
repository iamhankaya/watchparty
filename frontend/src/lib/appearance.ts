import { useSyncExternalStore } from "react";

// Görünüm ayarları: tema (koyu/açık) ve tasarım (klasik/sinema). İkisi de <html> üzerindeki
// data-theme / data-design attribute'larıyla CSS'e yansır. İlk değerler index.html'deki inline
// script tarafından sayfa çizilmeden önce yazılır; burası sonraki değişiklikleri yönetir.
export type Theme = "dark" | "light";
export type Design = "classic" | "cinema";

const THEME_KEY = "wp:theme";
const DESIGN_KEY = "wp:design";

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
const root = document.documentElement;
const listeners = new Set<() => void>();

function storedTheme(): Theme | null {
  const t = read(THEME_KEY);
  return t === "dark" || t === "light" ? t : null;
}

function currentTheme(): Theme {
  return storedTheme() ?? (systemDark.matches ? "dark" : "light");
}

function currentDesign(): Design {
  return read(DESIGN_KEY) === "cinema" ? "cinema" : "classic";
}

let snapshot = { theme: currentTheme(), design: currentDesign() };

function apply() {
  snapshot = { theme: currentTheme(), design: currentDesign() };
  root.dataset.theme = snapshot.theme;
  root.dataset.design = snapshot.design;
  listeners.forEach((l) => l());
}

// Kullanıcı tema seçmediyse sistem tercihini canlı takip et.
systemDark.addEventListener("change", () => {
  if (!storedTheme()) apply();
});

export function toggleTheme() {
  write(THEME_KEY, snapshot.theme === "dark" ? "light" : "dark");
  apply();
}

export function setDesign(design: Design) {
  write(DESIGN_KEY, design);
  apply();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAppearance() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
