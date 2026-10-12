import unittest
from pathlib import Path

from indir import (MAKS_URL_UZUNLUGU, argumanlari_oku, ffmpeg_argumanlari, format_secici,
                   genel_url, gizli_onek, kopyalanabilir_mi, s3_anahtari, slug)


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


class KopyalanabilirTestleri(unittest.TestCase):
    H264 = {"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p", "height": 1080}
    AAC = {"codec_type": "audio", "codec_name": "aac"}

    def test_h264_aac_kopyalanir(self):
        self.assertTrue(kopyalanabilir_mi([self.H264, self.AAC], None))

    def test_sessiz_h264_kopyalanir(self):
        self.assertTrue(kopyalanabilir_mi([self.H264], None))

    def test_vp9_donusturulur(self):
        self.assertFalse(kopyalanabilir_mi([{**self.H264, "codec_name": "vp9"}, self.AAC], None))

    def test_opus_donusturulur(self):
        self.assertFalse(kopyalanabilir_mi([self.H264, {**self.AAC, "codec_name": "opus"}], None))

    def test_yuksek_cozunurluk_sinir_varsa_donusturulur(self):
        self.assertFalse(kopyalanabilir_mi([self.H264, self.AAC], 720))

    def test_video_yoksa_donusturulur(self):
        self.assertFalse(kopyalanabilir_mi([self.AAC], None))


class FfmpegTestleri(unittest.TestCase):
    def test_kopyalama(self):
        args = ffmpeg_argumanlari(Path("a.mkv"), Path("b.mp4"), True, None, 23)
        self.assertIn("copy", args)
        self.assertNotIn("libx264", args)
        self.assertEqual(args[-3:], ["-movflags", "+faststart", "b.mp4"])

    def test_donusturme_ve_kucultme(self):
        args = ffmpeg_argumanlari(Path("a.mkv"), Path("b.mp4"), False, 720, 20)
        self.assertIn("libx264", args)
        self.assertEqual(args[args.index("-crf") + 1], "20")
        self.assertEqual(args[args.index("-vf") + 1], "scale=-2:'min(720,ih)'")
        self.assertIn("+faststart", args)


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


class ArgumanTestleri(unittest.TestCase):
    def test_url_ya_da_dosya_zorunlu(self):
        with self.assertRaises(SystemExit):
            argumanlari_oku([])

    def test_url_ve_dosya_birlikte_verilemez(self):
        with self.assertRaises(SystemExit):
            argumanlari_oku(["https://x", "--dosya", "a.mp4"])

    def test_sadece_dosya(self):
        self.assertEqual(argumanlari_oku(["--dosya", "a.mp4"]).dosya, Path("a.mp4"))


if __name__ == "__main__":
    unittest.main()
