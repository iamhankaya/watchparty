// SignalR, HubException mesajını "... HubException: Lobi dolu" şeklinde iletir; kullanıcıya sadece son kısmı gösteririz.
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const marker = "HubException: ";
  const i = raw.lastIndexOf(marker);
  return i >= 0 ? raw.slice(i + marker.length) : raw;
}

// Bağlantı kopma sebebi: sunucunun Türkçe HubException metni varsa onu, yoksa (İngilizce SignalR metni, boş hata) genel mesajı verir.
export function describeConnectionError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return raw.includes("HubException: ") ? errorMessage(e) : "Sunucuyla bağlantı kesildi";
}
