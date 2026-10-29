import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import donustur as d

H264 = {"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p"}


def ses(kodek):
    return {"codec_type": "audio", "codec_name": kodek}


class PlanTestleri(unittest.TestCase):
    def test_uyumsuz_sesler_donusturulur(self):
        for kodek in ("ac3", "eac3", "dts", "truehd"):
            self.assertEqual(d.plan([H264, ses(kodek)])[0], "ses", kodek)

    def test_aac_dokunulmaz(self):
        self.assertEqual(d.plan([H264, ses("aac")])[0], "dokunma")

    def test_sessiz_dokunulmaz(self):
        self.assertEqual(d.plan([H264])[0], "dokunma")

    def test_yalniz_ilk_ses_izine_bakilir(self):
        self.assertEqual(d.plan([H264, ses("aac"), ses("eac3")])[0], "dokunma")
        self.assertEqual(d.plan([H264, ses("eac3"), ses("aac")])[0], "ses")

    def test_h264_olmayan_video_uyumlu_sesle_dokunulmaz(self):
        self.assertEqual(d.plan([{**H264, "codec_name": "hevc"}, ses("aac")])[0], "dokunma")

    def test_h264_olmayan_video_uyumsuz_sesle_atlanir(self):
        karar, neden = d.plan([{**H264, "codec_name": "hevc"}, ses("eac3")])
        self.assertEqual(karar, "atla")
        self.assertIn("H.264", neden)

    def test_video_yoksa_atlanir(self):
        self.assertEqual(d.plan([ses("eac3")])[0], "atla")


class ArgumanTestleri(unittest.TestCase):
    def test_ses_donusumu_argumanlari(self):
        a = d.ffmpeg_argumanlari(Path("a.mkv"), Path("b.mp4.tmp"))
        self.assertEqual(a[0], "ffmpeg")
        self.assertEqual(a[a.index("-c:v") + 1], "copy")
        self.assertEqual(a[a.index("-c:a") + 1], "aac")
        self.assertEqual(a[a.index("-b:a") + 1], "192k")
        self.assertEqual(a[a.index("-ac") + 1], "2")
        self.assertEqual(a[a.index("-map") + 1], "0:v:0")
        self.assertIn("0:a:0", a)
        self.assertEqual(a[a.index("-f") + 1], "mp4")
        self.assertIn("+faststart", a)
        self.assertEqual(a[-1], "b.mp4.tmp")

    def test_tire_ile_baslayan_girdi_secenek_sayilmaz(self):
        a = d.ffmpeg_argumanlari(Path("-kotu.mkv"), Path("b.mp4.tmp"))
        for yol in (a[a.index("-i") + 1], a[-1]):
            self.assertFalse(yol.startswith("-"), yol)
        a = d.ffmpeg_argumanlari(Path("a.mkv"), Path("-cikti.mp4"))
        self.assertFalse(a[-1].startswith("-"))


class SureTestleri(unittest.TestCase):
    def test_esit_sure_gecer(self):
        self.assertTrue(d.sure_yeterli_mi(600.0, 600.1))

    def test_kesik_cikti_gecmez(self):
        self.assertFalse(d.sure_yeterli_mi(2486.0, 3.97))

    def test_kucuk_fark_gecer(self):
        self.assertTrue(d.sure_yeterli_mi(600.0, 598.5))

    def test_girdi_suresi_yoksa_ciktinin_suresi_yeter(self):
        self.assertTrue(d.sure_yeterli_mi(None, 10.0))

    def test_cikti_suresi_yoksa_gecmez(self):
        self.assertFalse(d.sure_yeterli_mi(10.0, None))
        self.assertFalse(d.sure_yeterli_mi(None, None))


class YolTestleri(unittest.TestCase):
    def test_cikti_yolu_ad_aac_mp4(self):
        self.assertEqual(d.cikti_yolu(Path("x/film.mkv"), None), Path("x/film-aac.mp4"))

    def test_cikti_dizini(self):
        self.assertEqual(d.cikti_yolu(Path("x/film.mkv"), Path("o")), Path("o/film-aac.mp4"))

    def test_dizinde_video_dosyalari_bulunur(self):
        with tempfile.TemporaryDirectory() as t:
            kok = Path(t)
            for ad in ("a.mkv", "b.MP4", "c.txt", "d-aac.mp4"):
                (kok / ad).write_bytes(b"x")
            self.assertEqual([p.name for p in d.girdileri_bul(kok)], ["a.mkv", "b.MP4"])

    def test_tek_dosya(self):
        with tempfile.TemporaryDirectory() as t:
            f = Path(t) / "a.mkv"
            f.write_bytes(b"x")
            self.assertEqual(d.girdileri_bul(f), [f])

    def test_olmayan_yol_hata(self):
        with self.assertRaises(d.DonusturucuHatasi):
            d.girdileri_bul(Path("yok-boyle-bir-yol"))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg yok")
class GercekDosyaTestleri(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.kok = Path(self._t.name)
        self.addCleanup(self._t.cleanup)

    def _uret(self, ad, ses_kodek, sure=2):
        yol = self.kok / ad
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error",
             "-f", "lavfi", "-i", f"testsrc=size=160x120:rate=10:duration={sure}",
             "-f", "lavfi", "-i", f"sine=frequency=440:duration={sure}",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", ses_kodek, str(yol)],
            check=True)
        return yol

    def test_eac3_donusturulur_orijinal_korunur(self):
        girdi = self._uret("film.mkv", "eac3")
        boyut = girdi.stat().st_size
        sonuc = d.donustur_dosya(girdi, None, dry_run=False)
        self.assertEqual(sonuc.durum, "donusturuldu")
        cikti = self.kok / "film-aac.mp4"
        self.assertTrue(cikti.is_file())
        self.assertFalse((self.kok / "film-aac.mp4.tmp").exists())
        self.assertEqual(girdi.stat().st_size, boyut)
        akislar, _ = d.probe(cikti)
        self.assertEqual([a["codec_name"] for a in akislar if a["codec_type"] == "audio"], ["aac"])
        self.assertEqual([a["codec_name"] for a in akislar if a["codec_type"] == "video"], ["h264"])

    def test_tire_ile_baslayan_dosya_adi(self):
        import os
        girdi = self._uret("-film.mkv", "eac3")
        eski = os.getcwd()
        os.chdir(self.kok)
        self.addCleanup(os.chdir, eski)
        sonuc = d.donustur_dosya(Path("-film.mkv"), None, dry_run=False)
        self.assertEqual(sonuc.durum, "donusturuldu", sonuc.mesaj)
        self.assertTrue((self.kok / "-film-aac.mp4").is_file())

    def test_dry_run_dosya_uretmez(self):
        girdi = self._uret("film.mkv", "eac3")
        sonuc = d.donustur_dosya(girdi, None, dry_run=True)
        self.assertEqual(sonuc.durum, "donusturulecek")
        self.assertFalse((self.kok / "film-aac.mp4").exists())

    def test_aac_dokunulmaz(self):
        girdi = self._uret("film.mp4", "aac")
        sonuc = d.donustur_dosya(girdi, None, dry_run=False)
        self.assertEqual(sonuc.durum, "dokunulmadi")
        self.assertFalse((self.kok / "film-aac.mp4").exists())

    def test_ayni_kaynaktan_var_olan_cikti_yeniden_kullanilir(self):
        girdi = self._uret("film.mkv", "eac3")
        self.assertEqual(d.donustur_dosya(girdi, None, dry_run=False).durum, "donusturuldu")
        cikti = self.kok / "film-aac.mp4"
        boyut = cikti.stat().st_size
        sonuc = d.donustur_dosya(girdi, None, dry_run=False)
        self.assertEqual(sonuc.durum, "atlandi")
        self.assertEqual(cikti.stat().st_size, boyut)

    def test_farkli_sureli_ayni_adli_cikti_hata_ve_ezilmez(self):
        # F-watchparty-009: başka klasördeki aynı adlı kaynağın çıktısı sessizce kullanılmasın.
        a = self._uret("film.mkv", "eac3", sure=2)
        d.donustur_dosya(a, self.kok / "o", dry_run=False)
        (self.kok / "b").mkdir()
        b = self.kok / "b" / "film.mkv"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error",
             "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=8",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "eac3", str(b)], check=True)
        cikti = self.kok / "o" / "film-aac.mp4"
        boyut = cikti.stat().st_size
        sonuc = d.donustur_dosya(b, self.kok / "o", dry_run=False)
        self.assertEqual(sonuc.durum, "hata")
        self.assertIn("--cikti", sonuc.mesaj)
        self.assertEqual(cikti.stat().st_size, boyut)

    def test_kaynaktan_uzun_ayni_adli_cikti_hata(self):
        (self.kok / "b").mkdir()
        uzun = self._uret("film.mkv", "eac3", sure=8)
        d.donustur_dosya(uzun, self.kok / "o", dry_run=False)
        kisa = self.kok / "b" / "film.mkv"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error",
             "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=2",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "eac3", str(kisa)], check=True)
        sonuc = d.donustur_dosya(kisa, self.kok / "o", dry_run=False)
        self.assertEqual(sonuc.durum, "hata")

    def test_okunamayan_var_olan_cikti_hata(self):
        girdi = self._uret("film.mkv", "eac3")
        (self.kok / "film-aac.mp4").write_bytes(b"eski")
        sonuc = d.donustur_dosya(girdi, None, dry_run=False)
        self.assertEqual(sonuc.durum, "hata")
        self.assertEqual((self.kok / "film-aac.mp4").read_bytes(), b"eski")

    def test_kesik_cikti_silinir(self):
        girdi = self._uret("film.mkv", "eac3", sure=4)
        eski = d.sure_yeterli_mi
        d.sure_yeterli_mi = lambda *_: False
        self.addCleanup(setattr, d, "sure_yeterli_mi", eski)
        sonuc = d.donustur_dosya(girdi, None, dry_run=False)
        self.assertEqual(sonuc.durum, "hata")
        self.assertFalse((self.kok / "film-aac.mp4").exists())
        self.assertFalse((self.kok / "film-aac.mp4.tmp").exists())
        self.assertTrue(girdi.is_file())

    def test_main_dizin_ve_cikti(self):
        self._uret("a.mkv", "eac3")
        self._uret("b.mkv", "aac")
        o = self.kok / "out"
        self.assertEqual(d.main([str(self.kok), "--cikti", str(o)]), 0)
        self.assertEqual([p.name for p in o.iterdir()], ["a-aac.mp4"])


if __name__ == "__main__":
    unittest.main()
