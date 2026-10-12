import type { CSSProperties } from "react";

// Lobi kodu, sinema girişlerindeki harf panosu gibi tek tek harf plakalarıyla gösterilir.
export function CodeBoard({ code, onClick, title }: { code: string; onClick?(): void; title?: string }) {
  const tiles = code.split("").map((ch, i) => (
    <span key={i} className="cn-tile" style={{ "--i": i } as CSSProperties} aria-hidden="true">
      {ch}
    </span>
  ));
  return onClick ? (
    <button type="button" className="cn-board" onClick={onClick} title={title} aria-label={`Lobi kodu ${code}. ${title ?? ""}`}>
      {tiles}
    </button>
  ) : (
    <div className="cn-board" role="img" aria-label={`Lobi kodu ${code}`}>
      {tiles}
    </div>
  );
}
