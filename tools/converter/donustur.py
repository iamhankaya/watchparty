"""Tarayıcıda çalmayan sesi (E-AC3/AC3/DTS/TrueHD) AAC'ye çeviren yerel araç.

Video akışına dokunulmaz (-c:v copy); yalnız ilk ses izi AAC stereo 192k olur
ve sonuç <ad>-aac.mp4 olarak yazılır. Orijinal dosya korunur. Ses zaten
uyumluysa dosyaya dokunulmaz.

Kullanım:
    python donustur.py <dosya-ya-da-dizin> [--cikti KLASOR] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

VIDEO_UZANTILARI = {".mkv", ".mp4", ".m4v"}
# Chrome'un sessizce çalmadığı sesler.
UYUMSUZ_SESLER = {"ac3", "eac3", "dts", "truehd", "mlp"}
SONEK = "-aac"
GECICI_UZANTI = ".tmp"
# Süre doğrulaması: çıktı girdiden en fazla bu kadar kısa olabilir.
SURE_PAYI_SN = 2.0
SURE_PAYI_ORAN = 0.01


class DonusturucuHatasi(Exception):
    """Kullanıcıya gösterilecek Türkçe hata."""


@dataclass
class Sonuc:
    girdi: Path
    durum: str  # donusturuldu | donusturulecek | dokunulmadi | atlandi | hata
    mesaj: str = ""
    cikti: Path | None = None


def plan(akislar: list[dict]) -> tuple[str, str]:
    """(karar, neden) döner; karar: 'ses' (sesi çevir), 'dokunma' ya da 'atla' (araç uygun değil)."""
    video = [a for a in akislar if a.get("codec_type") == "video"]
    ses = [a for a in akislar if a.get("codec_type") == "audio"]
    if not video:
        return "atla", "video akışı yok"
    if video[0].get("codec_name") != "h264":
        return "atla", f"video H.264 değil ({video[0].get('codec_name')}); bu araç videoyu yeniden kodlamaz"
    if not ses:
        return "dokunma", "ses akışı yok"
    kodek = ses[0].get("codec_name")
    if kodek in UYUMSUZ_SESLER:
        return "ses", f"ses {kodek}, AAC'ye çevrilecek"
    return "dokunma", f"ses zaten uyumlu ({kodek})"


def ffmpeg_argumanlari(girdi: Path, cikti: Path) -> list[str]:
    # Tire ile başlayan göreli yol ffmpeg'de seçenek sanılmasın.
    g = girdi if girdi.is_absolute() or not girdi.name.startswith("-") else Path(".") / girdi
    return ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-stats",
            "-i", str(g), "-map", "0:v:0", "-map", "0:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ac", "2",
            "-movflags", "+faststart", "-f", "mp4", str(cikti)]


def sure_yeterli_mi(girdi_sure: float | None, cikti_sure: float | None) -> bool:
    """ffmpeg kesik girdide bile 0 çıkışla kısa dosya üretebilir; süreyi karşılaştır."""
    if not girdi_sure or not cikti_sure:
        return False
    return cikti_sure >= girdi_sure - max(SURE_PAYI_SN, girdi_sure * SURE_PAYI_ORAN)


def cikti_yolu(girdi: Path, cikti_dizini: Path | None) -> Path:
    return (cikti_dizini or girdi.parent) / f"{girdi.stem}{SONEK}.mp4"


def girdileri_bul(yol: Path) -> list[Path]:
    if yol.is_file():
        return [yol]
    if not yol.is_dir():
        raise DonusturucuHatasi(f"Yol bulunamadı: {yol}")
    return sorted(p for p in yol.iterdir()
                  if p.is_file() and p.suffix.lower() in VIDEO_UZANTILARI
                  and not p.stem.endswith(SONEK))


def probe(yol: Path) -> tuple[list[dict], float | None]:
    """(akışlar, süre sn) döner."""
    try:
        sonuc = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format",
             "--", str(yol)],
            capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as e:
        raise DonusturucuHatasi(f"ffprobe dosyayı okuyamadı: {yol.name}") from e
    veri = json.loads(sonuc.stdout)
    try:
        sure = float(veri.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        sure = None
    return veri.get("streams", []), sure


def donustur_dosya(girdi: Path, cikti_dizini: Path | None, dry_run: bool) -> Sonuc:
    try:
        akislar, girdi_sure = probe(girdi)
    except DonusturucuHatasi as e:
        return Sonuc(girdi, "hata", str(e))
    karar, neden = plan(akislar)
    if karar != "ses":
        return Sonuc(girdi, "dokunulmadi", neden)
    cikti = cikti_yolu(girdi, cikti_dizini)
    if cikti.exists():
        return Sonuc(girdi, "atlandi", f"{cikti.name} zaten var, ezilmedi")
    if dry_run:
        return Sonuc(girdi, "donusturulecek", f"{neden}; yazılacak: {cikti}", cikti)
    gecici = cikti.with_name(cikti.name + GECICI_UZANTI)
    try:
        cikti.parent.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(ffmpeg_argumanlari(girdi, gecici), check=True)
        except subprocess.CalledProcessError as e:
            return Sonuc(girdi, "hata", f"ffmpeg başarısız oldu (çıkış kodu {e.returncode}).")
        _, cikti_sure = probe(gecici)
        if not sure_yeterli_mi(girdi_sure, cikti_sure):
            return Sonuc(girdi, "hata",
                         f"çıktı süresi girdiyle uyuşmuyor ({cikti_sure} sn, girdi {girdi_sure} sn); girdi kesik olabilir, çıktı silindi.")
        gecici.replace(cikti)
        return Sonuc(girdi, "donusturuldu", neden, cikti)
    except (DonusturucuHatasi, OSError) as e:
        return Sonuc(girdi, "hata", str(e))
    finally:
        gecici.unlink(missing_ok=True)


def argumanlari_oku(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Uyumsuz sesi AAC'ye çevirir (video kopyalanır, orijinal korunur).")
    p.add_argument("yol", type=Path, help="Tek dosya ya da video dosyaları içeren dizin")
    p.add_argument("--cikti", type=Path, help="Çıktı klasörü (varsayılan: girdinin yanı)")
    p.add_argument("--dry-run", action="store_true", help="Yalnız planı yazdır, dosya üretme")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    for akis in (sys.stdout, sys.stderr):
        if hasattr(akis, "reconfigure"):
            akis.reconfigure(encoding="utf-8", errors="replace")
    a = argumanlari_oku(argv)
    try:
        eksik = [x for x in ("ffmpeg", "ffprobe") if shutil.which(x) is None]
        if eksik:
            raise DonusturucuHatasi(f"{', '.join(eksik)} bulunamadı. Kurun (ör. 'winget install Gyan.FFmpeg') ve PATH'e ekleyin.")
        girdiler = girdileri_bul(a.yol)
    except DonusturucuHatasi as e:
        print(f"Hata: {e}", file=sys.stderr)
        return 1
    if not girdiler:
        print("Dönüştürülecek video dosyası bulunamadı.")
        return 0
    sonuclar = []
    for g in girdiler:
        s = donustur_dosya(g, a.cikti, a.dry_run)
        sonuclar.append(s)
        print(f"[{s.durum}] {g.name}: {s.mesaj}", file=sys.stderr if s.durum == "hata" else sys.stdout)
    hatali = sum(s.durum == "hata" for s in sonuclar)
    print(f"\n{len(sonuclar)} dosya: {sum(s.durum in ('donusturuldu', 'donusturulecek') for s in sonuclar)} dönüştürülen, "
          f"{sum(s.durum in ('dokunulmadi', 'atlandi') for s in sonuclar)} atlanan, {hatali} hatalı.")
    return 1 if hatali else 0


if __name__ == "__main__":
    sys.exit(main())
