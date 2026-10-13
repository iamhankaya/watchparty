"""WatchParty için video indirme aracı.

Bir video URL'sini yt-dlp ile indirir, ffmpeg ile web'e uygun MP4'e
(H.264 + AAC + faststart) çevirir ve isteğe bağlı olarak S3'e yükleyip
lobiye yapıştırılacak https linkini yazdırır.

Kullanım:
    python indir.py <url> [--maks-yukseklik 720] [--s3-bucket BUCKET] [--cdn-url URL]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import unicodedata
from pathlib import Path
from urllib.parse import quote

# Backend MediaValidator.MaxIdLength ile aynı olmalı.
MAKS_URL_UZUNLUGU = 200


class AracHatasi(Exception):
    """Kullanıcıya gösterilecek Türkçe hata."""


def slug(metin: str, maks: int = 60) -> str:
    """Başlığı dosya adı ve S3 anahtarı için güvenli, ASCII bir ada çevirir."""
    # ı NFKD ile ayrışmadığı için elle çevrilir.
    metin = metin.translate(str.maketrans({"ı": "i", "İ": "I"}))
    metin = unicodedata.normalize("NFKD", metin).encode("ascii", "ignore").decode()
    sonuc = []
    for karakter in metin.lower():
        if karakter.isalnum():
            sonuc.append(karakter)
        elif sonuc and sonuc[-1] != "-":
            sonuc.append("-")
    return "".join(sonuc)[:maks].strip("-") or "video"


def format_secici(maks_yukseklik: int | None) -> str:
    """Önce dönüştürmesiz kopyalanabilecek H.264/AAC akışlarını tercih eden yt-dlp format ifadesi."""
    h = f"[height<={maks_yukseklik}]" if maks_yukseklik else ""
    return "/".join([
        f"bv*{h}[vcodec^=avc1]+ba[acodec^=mp4a]",
        f"b{h}[ext=mp4]",
        f"bv*{h}+ba",
        f"b{h}",
        "bv*+ba/b",
    ])


def kopyalanabilir_mi(akislar: list[dict], maks_yukseklik: int | None) -> bool:
    """Akışlar yeniden kodlanmadan tarayıcıda oynatılabiliyorsa True."""
    video = [a for a in akislar if a.get("codec_type") == "video"]
    ses = [a for a in akislar if a.get("codec_type") == "audio"]
    if not video:
        return False
    v = video[0]
    if v.get("codec_name") != "h264" or v.get("pix_fmt") != "yuv420p":
        return False
    if maks_yukseklik and int(v.get("height") or 0) > maks_yukseklik:
        return False
    return not ses or ses[0].get("codec_name") == "aac"


def ffmpeg_argumanlari(girdi: Path, cikti: Path, kopyala: bool,
                       maks_yukseklik: int | None, crf: int) -> list[str]:
    args = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-stats",
            "-i", str(girdi), "-map", "0:v:0", "-map", "0:a:0?"]
    if kopyala:
        args += ["-c", "copy"]
    else:
        args += ["-c:v", "libx264", "-crf", str(crf), "-preset", "medium", "-pix_fmt", "yuv420p"]
        if maks_yukseklik:
            args += ["-vf", f"scale=-2:'min({maks_yukseklik},ih)'"]
        args += ["-c:a", "aac", "-b:a", "128k", "-ac", "2"]
    return args + ["-movflags", "+faststart", str(cikti)]


def s3_anahtari(onek: str, dosya_adi: str) -> str:
    onek = onek.strip("/")
    return f"{onek}/{dosya_adi}" if onek else dosya_adi


def gizli_onek(onek: str) -> str:
    """Linki bilmeyenin bulamaması için öneke tahmin edilemez bir klasör ekler."""
    return f"{onek.strip('/')}/{secrets.token_hex(16)}".lstrip("/")


def genel_url(key: str, bucket: str, bolge: str, cdn_url: str | None) -> str:
    if cdn_url:
        return f"{cdn_url.rstrip('/')}/{quote(key)}"
    return f"https://{bucket}.s3.{bolge}.amazonaws.com/{quote(key)}"


def araclari_kontrol_et() -> None:
    eksik = [a for a in ("ffmpeg", "ffprobe") if shutil.which(a) is None]
    if eksik:
        raise AracHatasi(f"{', '.join(eksik)} bulunamadı. Kurun (ör. 'winget install Gyan.FFmpeg') ve PATH'e ekleyin.")


def indir(url: str, klasor: Path, maks_yukseklik: int | None) -> tuple[Path, str]:
    """Videoyu indirir; (dosya yolu, ad) döner."""
    import yt_dlp

    ayarlar = {
        "format": format_secici(maks_yukseklik),
        "merge_output_format": "mp4",
        "outtmpl": str(klasor / "ham-%(id)s.%(ext)s"),
        "noplaylist": True,
        "restrictfilenames": True,
        # YouTube JS doğrulamaları için; frontend için zaten kurulu olan Node da kullanılabilsin.
        "js_runtimes": {"deno": {}, "node": {}},
        # Uzun videolarda bağlantı kopabiliyor; beklemeli yeniden dene, yarım .part dosyasından devam et.
        "retries": 30,
        "fragment_retries": 30,
        "retry_sleep_functions": {"http": lambda n: min(2 ** n, 30), "fragment": lambda n: min(2 ** n, 30)},
        "continuedl": True,
    }
    try:
        with yt_dlp.YoutubeDL(ayarlar) as ydl:
            bilgi = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as e:
        raise AracHatasi(f"İndirme başarısız: {e}") from e
    yol = Path(bilgi["requested_downloads"][0]["filepath"])
    # YouTube id'leri büyük/küçük harfe duyarlı; slug'a sokulmaz.
    kimlik = re.sub(r"[^A-Za-z0-9_-]", "", str(bilgi.get("id") or ""))[:20]
    ad = f"{slug(bilgi.get('title') or 'video')}-{kimlik}".rstrip("-")
    return yol, ad


def video_akislari(yol: Path) -> list[dict]:
    sonuc = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", str(yol)],
        capture_output=True, text=True, check=True)
    return json.loads(sonuc.stdout).get("streams", [])


def donustur(girdi: Path, cikti: Path, maks_yukseklik: int | None, crf: int) -> None:
    kopyala = kopyalanabilir_mi(video_akislari(girdi), maks_yukseklik)
    print("Dönüştürme gerekmiyor, faststart ile kopyalanıyor..." if kopyala
          else "Web'e uygun MP4'e dönüştürülüyor (bu biraz sürebilir)...", flush=True)
    try:
        subprocess.run(ffmpeg_argumanlari(girdi, cikti, kopyala, maks_yukseklik, crf), check=True)
    except subprocess.CalledProcessError as e:
        cikti.unlink(missing_ok=True)
        raise AracHatasi(f"ffmpeg başarısız oldu (çıkış kodu {e.returncode}).") from e


class YuklemeIlerlemesi:
    def __init__(self, toplam: int):
        self.toplam, self.gonderilen, self.kilit = toplam, 0, threading.Lock()

    def __call__(self, bayt: int) -> None:
        with self.kilit:
            self.gonderilen += bayt
            yuzde = self.gonderilen * 100 // max(self.toplam, 1)
            print(f"\rS3'e yükleniyor: %{yuzde}", end="", flush=True)


def yukle(yol: Path, bucket: str, key: str, bolge: str | None) -> str:
    """Dosyayı S3'e yükler; bucket'ın bölgesini döner."""
    import boto3
    from boto3.s3.transfer import TransferConfig
    from botocore.config import Config
    from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError

    # Ev bağlantılarında uzun yüklemeler arada kopabiliyor: parça başına daha çok deneme,
    # yavaş hatta zaman aşımına düşmemek için daha az paralel bağlantı.
    ayar = Config(retries={"total_max_attempts": 10, "mode": "standard"})
    aktarim = TransferConfig(max_concurrency=4, multipart_chunksize=16 * 1024 * 1024)
    try:
        istemci = boto3.client("s3", region_name=bolge, config=ayar)
        if not bolge:
            bolge = istemci.get_bucket_location(Bucket=bucket).get("LocationConstraint") or "us-east-1"
        istemci.upload_file(
            str(yol), bucket, key,
            ExtraArgs={"ContentType": "video/mp4", "CacheControl": "public, max-age=31536000, immutable"},
            Callback=YuklemeIlerlemesi(yol.stat().st_size), Config=aktarim)
        print()
    except NoCredentialsError as e:
        raise AracHatasi("AWS kimlik bilgisi bulunamadı. 'aws configure' çalıştırın ya da AWS_PROFILE ayarlayın.") from e
    except (BotoCoreError, ClientError) as e:
        raise AracHatasi(f"S3 yüklemesi başarısız: {e}") from e
    return bolge


def argumanlari_oku(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Videoyu indirir, web'e uygun MP4'e çevirir ve S3'e yükler.")
    p.add_argument("url", nargs="?", help="İndirilecek videonun adresi")
    p.add_argument("--dosya", type=Path, help="İndirmek yerine bu hazır MP4'ü yükle")
    p.add_argument("--gizli", action="store_true", help="Anahtara tahmin edilemez bir klasör ekle")
    p.add_argument("--cikti", type=Path, default=Path("indirilenler"), help="İndirme klasörü (varsayılan: indirilenler)")
    p.add_argument("--maks-yukseklik", type=int, help="Örn. 720: daha yüksek çözünürlükler küçültülür")
    p.add_argument("--crf", type=int, default=23, help="x264 kalite değeri, küçük = daha kaliteli/büyük (varsayılan: 23)")
    p.add_argument("--s3-bucket", default=os.environ.get("WP_S3_BUCKET"), help="Hedef bucket (ya da WP_S3_BUCKET)")
    p.add_argument("--s3-onek", default=os.environ.get("WP_S3_ONEK", "videolar"), help="S3 anahtar öneki (varsayılan: videolar)")
    p.add_argument("--bolge", default=os.environ.get("AWS_REGION"), help="Bucket bölgesi (verilmezse sorgulanır)")
    p.add_argument("--cdn-url", default=os.environ.get("WP_CDN_URL"), help="CloudFront adresi (ya da WP_CDN_URL), ör. https://dxxxx.cloudfront.net")
    p.add_argument("--sadece-indir", action="store_true", help="S3'e yükleme yapma")
    a = p.parse_args(argv)
    if bool(a.url) == bool(a.dosya):
        p.error("ya bir url ya da --dosya verin")
    return a


def main(argv: list[str] | None = None) -> int:
    # Windows konsolunda Türkçe karakterler bozulmasın.
    for akis in (sys.stdout, sys.stderr):
        if hasattr(akis, "reconfigure"):
            akis.reconfigure(encoding="utf-8", errors="replace")
    a = argumanlari_oku(argv)
    try:
        if not a.sadece_indir and not a.s3_bucket:
            raise AracHatasi("Bucket belirtilmedi: --s3-bucket verin, WP_S3_BUCKET ayarlayın ya da --sadece-indir kullanın.")
        if a.dosya:
            if not a.dosya.is_file():
                raise AracHatasi(f"Dosya bulunamadı: {a.dosya}")
            son = a.dosya
        else:
            araclari_kontrol_et()
            a.cikti.mkdir(parents=True, exist_ok=True)
            ham, ad = indir(a.url, a.cikti, a.maks_yukseklik)
            son = a.cikti / f"{ad}.mp4"
            donustur(ham, son, a.maks_yukseklik, a.crf)
            if ham != son:
                ham.unlink(missing_ok=True)
        print(f"Hazır: {son} ({son.stat().st_size / 1024**3:.2f} GB)")

        if a.sadece_indir:
            return 0
        key = s3_anahtari(gizli_onek(a.s3_onek) if a.gizli else a.s3_onek, son.name)
        bolge = yukle(son, a.s3_bucket, key, a.bolge)
        url = genel_url(key, a.s3_bucket, bolge, a.cdn_url)
        print(f"\nLobiye yapıştırılacak link:\n{url}")
        if len(url) > MAKS_URL_UZUNLUGU:
            print(f"Uyarı: link {MAKS_URL_UZUNLUGU} karakterden uzun, WatchParty kabul etmez. --s3-onek'i kısaltın.")
        if not a.cdn_url:
            print("Not: CloudFront olmadan bu link yalnızca bucket herkese açıksa çalışır ve indirme ücreti daha yüksektir.")
        return 0
    except AracHatasi as e:
        print(f"Hata: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
