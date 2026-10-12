import { useCallback, useEffect, useState } from "react";
import { HomePage } from "./pages/HomePage";
import { LobbyPage } from "./pages/LobbyPage";
import { USE_MOCK } from "./lib/api";
import { toggleTheme, useTheme } from "./lib/theme";
import { Icon } from "./components/Icon";

// İki sayfa için router kütüphanesi gereksiz: "/" ana sayfa, "/l/KOD" lobi.
function lobbyCodeFromPath(path: string): string | null {
  const m = path.match(/^\/l\/([A-Za-z0-9]+)\/?$/);
  return m ? m[1].toUpperCase() : null;
}

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  const theme = useTheme();

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    window.history.pushState(null, "", to);
    setPath(window.location.pathname);
  }, []);

  const code = lobbyCodeFromPath(path);

  return (
    <div className="app">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          WatchParty
        </a>
        {USE_MOCK && <span className="badge">mock sunucu</span>}
        <div className="topbar-end">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Açık temaya geç" : "Koyu temaya geç"}
            aria-label={theme === "dark" ? "Açık temaya geç" : "Koyu temaya geç"}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
        </div>
      </header>
      {code ? <LobbyPage key={code} code={code} navigate={navigate} /> : <HomePage navigate={navigate} />}
    </div>
  );
}
