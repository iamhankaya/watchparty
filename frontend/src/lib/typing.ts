// "Yazıyor…" göstergesi: alıcı tarafı takipçi ve gönderen tarafı hız sınırlayıcı.

const EXPIRY_MS = 5000;
const SEND_GAP_MS = 3000;

export class TypingTracker {
  private entries = new Map<string, { nickname: string; at: number }>();

  add(id: string, nickname: string, now: number): void {
    this.entries.set(id, { nickname, at: now });
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  // Süresi dolmamış kişilerin takma adları (ekleme sırasıyla).
  active(now: number): string[] {
    const names: string[] = [];
    for (const [id, e] of this.entries) {
      if (now - e.at >= EXPIRY_MS) this.entries.delete(id);
      else names.push(e.nickname);
    }
    return names;
  }

  label(names: string[]): string | null {
    if (names.length === 0) return null;
    if (names.length === 1) return `${names[0]} yazıyor…`;
    if (names.length === 2) return `${names[0]} ve ${names[1]} yazıyor…`;
    return `${names.length} kişi yazıyor…`;
  }
}

export class TypingThrottle {
  private last = -Infinity;

  shouldSend(now: number): boolean {
    if (now - this.last < SEND_GAP_MS) return false;
    this.last = now;
    return true;
  }
}
