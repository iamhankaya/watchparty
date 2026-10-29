import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from indir import (MAKS_URL_UZUNLUGU, AracHatasi, argumanlari_oku, donusum_plani, donustur,
                   ffmpeg_argumanlari, format_secici, genel_url, gizli_onek, icerik_turu,
                   s3_anahtari, ses_hazirla, slug)


class SlugTestleri(unittest.TestCase):
    def test_turkce_karakterler_ascii_olur(self):
        self.assertEqual(slug("Işık Çağı: Şövalye Öykü"), "isik-cagi-sovalye-oyku")

    def test_bos_ya_da_sembol_video_olur(self):
        self.assertEqual(slug("!!!"), "video")

    def test_uzunluk_sinirlanir_ve_tire_ile_bitmez(self):
        sonuc = slug("a " * 100, maks=10)
        self.assertLessEqual(len(sonuc), 10)
        self.assertFalse(sonuc.endswith("-"))


class FormatTestleri(unittest.TestCase):
    def test_yukseklik_siniri_eklenir(self):
        self.assertIn("[height<=720]", format_secici(720))

    def test_sinirsiz(self):
        self.assertNotIn("height", format_secici(None))

    def test_son_care_sinirsizdir(self):
        self.assertTrue(format_secici(720).endswith("bv*+ba/b"))


class DonusumPlaniTestleri(unittest.TestCase):
    H264 = {"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p", "height": 1080}
    AAC = {"codec_type": "audio", "codec_name": "aac"}

    def test_h264_aac_kopyalanir(self):
        self.assertEqual(donusum_plani([self.H264, self.AAC], None), "kopya")

    def test_sessiz_h264_kopyalanir(self):
        self.assertEqual(donusum_plani([self.H264], None), "kopya")

    def test_vp9_donusturulur(self):
        self.assertEqual(donusum_plani([{**self.H264, "codec_name": "vp9"}, self.AAC], None), "tam")

    def test_opus_yalniz_ses_donusturulur(self):
        self.assertEqual(donusum_plani([self.H264, {**self.AAC, "codec_name": "opus"}], None), "ses")

    def test_eac3_video_kopyalanir_yalniz_ses_donusturulur(self):
        self.assertEqual(donusum_plani([self.H264, {**self.AAC, "codec_name": "eac3"}], None), "ses")

    def test_uyumsuz_ses_ve_uygunsuz_video_tam(self):
        self.assertEqual(donusum_plani([{**self.H264, "codec_name": "vp9"}, {**self.AAC, "codec_name": "eac3"}], None), "tam")

    def test_yuksek_cozunurluk_sinir_varsa_donusturulur(self):
        self.assertEqual(donusum_plani([self.H264, self.AAC], 720), "tam")

    def test_video_yoksa_donusturulur(self):
        self.assertEqual(donusum_plani([self.AAC], None), "tam")


class FfmpegTestleri(unittest.TestCase):
    def test_kopyalama(self):
        args = ffmpeg_argumanlari(Path("a.mkv"), Path("b.mp4"), "kopya", None, 23)
        self.assertIn("copy", args)
        self.assertNotIn("libx264", args)
        self.assertEqual(args[-3:], ["-movflags", "+faststart", "b.mp4"])

    def test_donusturme_ve_kucultme(self):
        args = ffmpeg_argumanlari(Path("a.mkv"), Path("b.mp4"), "tam", 720, 20)
        self.assertIn("libx264", args)
        self.assertEqual(args[args.index("-crf") + 1], "20")
        self.assertEqual(args[args.index("-vf") + 1], "scale=-2:'min(720,ih)'")
        self.assertIn("+faststart", args)
        self.assertEqual(args[args.index("-b:a") + 1], "192k")

    def test_ses_modu_videoyu_kopyalar(self):
        args = ffmpeg_argumanlari(Path("a.mkv"), Path("b.mp4"), "ses", 720, 20)
        self.assertEqual(args[args.index("-c:v") + 1], "copy")
        self.assertEqual(args[args.index("-c:a") + 1], "aac")
        self.assertEqual(args[args.index("-b:a") + 1], "192k")
        self.assertEqual(args[args.index("-ac") + 1], "2")
        self.assertNotIn("libx264", args)
        self.assertNotIn("-vf", args)
        self.assertIn("+faststart", args)
        self.assertEqual(args[-1], "b.mp4")


class IcerikTuruTestleri(unittest.TestCase):
    def test_mkv(self):
        self.assertEqual(icerik_turu(Path("a.MKV")), "video/x-matroska")

    def test_mp4_ve_digerleri(self):
        self.assertEqual(icerik_turu(Path("a.mp4")), "video/mp4")
        self.assertEqual(icerik_turu(Path("a.m4v")), "video/mp4")


class DonusturTestleri(unittest.TestCase):
    def _fake(self, girdi_sure, cikti_sure, rc=0):
        import indir
        sureler = iter([girdi_sure, cikti_sure])
        eski = (indir.video_akislari, indir.sure_oku, indir.subprocess.run)
        indir.video_akislari = lambda yol: [DonusumPlaniTestleri.H264,
                                             {"codec_type": "audio", "codec_name": "eac3"}]
        indir.sure_oku = lambda yol: next(sureler)

        def calistir(args, check):
            Path(args[-1]).write_bytes(b"x")
            if rc:
                raise indir.subprocess.CalledProcessError(rc, args)
        indir.subprocess.run = calistir
        self.addCleanup(lambda: (setattr(indir, "video_akislari", eski[0]),
                                 setattr(indir, "sure_oku", eski[1]),
                                 setattr(indir.subprocess, "run", eski[2])))

    def test_kesik_cikti_silinir_girdi_korunur(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            g, c = Path(t) / "g.mkv", Path(t) / "c.mp4"
            g.write_bytes(b"x")
            self._fake(2486.0, 3.97)
            with self.assertRaises(AracHatasi):
                donustur(g, c, None, 23)
            self.assertFalse(c.exists())
            self.assertTrue(g.exists())

    def test_tam_sure_kalir(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            g, c = Path(t) / "g.mkv", Path(t) / "c.mp4"
            g.write_bytes(b"x")
            self._fake(600.0, 600.0)
            donustur(g, c, None, 23)
            self.assertTrue(c.exists())

    def test_ffmpeg_hatasinda_cikti_silinir(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            g, c = Path(t) / "g.mkv", Path(t) / "c.mp4"
            g.write_bytes(b"x")
            self._fake(600.0, 600.0, rc=1)
            with self.assertRaises(AracHatasi):
                donustur(g, c, None, 23)
            self.assertFalse(c.exists())


class S3Testleri(unittest.TestCase):
    def test_anahtar_onek_ile(self):
        self.assertEqual(s3_anahtari("/videolar/", "film.mp4"), "videolar/film.mp4")

    def test_anahtar_oneksiz(self):
        self.assertEqual(s3_anahtari("", "film.mp4"), "film.mp4")

    def test_cdn_url(self):
        self.assertEqual(genel_url("videolar/a b.mp4", "kova", "eu-central-1", "https://d1.cloudfront.net/"),
                         "https://d1.cloudfront.net/videolar/a%20b.mp4")

    def test_s3_url(self):
        self.assertEqual(genel_url("videolar/a.mp4", "kova", "eu-central-1", None),
                         "https://kova.s3.eu-central-1.amazonaws.com/videolar/a.mp4")

    def test_gizli_onek_rastgele_ve_sinirin_altinda(self):
        a, b = gizli_onek("videolar"), gizli_onek("videolar")
        self.assertNotEqual(a, b)
        self.assertRegex(a, r"^videolar/[0-9a-f]{32}$")
        key = s3_anahtari(a, slug("x" * 200) + "-dQw4w9WgXcQ.mp4")
        self.assertLessEqual(len(genel_url(key, "kova", "eu-north-1", "https://dp5rr1tulngd4.cloudfront.net")),
                             MAKS_URL_UZUNLUGU)

    def test_tipik_url_sinirin_altinda(self):
        key = s3_anahtari("videolar", slug("x" * 200) + "-" + slug("dQw4w9WgXcQ", 20) + ".mp4")
        self.assertLessEqual(len(genel_url(key, "kova", "eu-central-1", None)), MAKS_URL_UZUNLUGU)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg yok")
class SesHazirlaTestleri(unittest.TestCase):
    def _uret(self, yol, kodek):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                        "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=2",
                        "-f", "lavfi", "-i", "sine=duration=2",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", kodek, str(yol)], check=True)

    def test_eac3_aac_mp4ye_cevrilir_aac_dokunulmaz(self):
        with tempfile.TemporaryDirectory() as t:
            kok = Path(t)
            self._uret(kok / "a.mkv", "eac3")
            self._uret(kok / "b.mp4", "aac")
            self.assertEqual(ses_hazirla(kok / "a.mkv", kok / "o"), kok / "o" / "a-aac.mp4")
            self.assertTrue((kok / "o" / "a-aac.mp4").is_file())
            self.assertEqual(ses_hazirla(kok / "b.mp4", kok / "o"), kok / "b.mp4")
            self.assertFalse((kok / "o" / "b-aac.mp4").exists())


class ArgumanTestleri(unittest.TestCase):
    def test_url_ya_da_dosya_zorunlu(self):
        with self.assertRaises(SystemExit):
            argumanlari_oku([])

    def test_url_ve_dosya_birlikte_verilemez(self):
        with self.assertRaises(SystemExit):
            argumanlari_oku(["https://x", "--dosya", "a.mp4"])

    def test_ses_donustur_varsayilan_otomatik(self):
        self.assertEqual(argumanlari_oku(["--dosya", "a.mp4"]).ses_donustur, "otomatik")

    def test_ses_donustur_hayir(self):
        self.assertEqual(argumanlari_oku(["--dosya", "a.mp4", "--ses-donustur", "hayir"]).ses_donustur, "hayir")

    def test_sadece_dosya(self):
        self.assertEqual(argumanlari_oku(["--dosya", "a.mp4"]).dosya, Path("a.mp4"))


if __name__ == "__main__":
    unittest.main()
