# Backlog

Yapılacaklar, önem sırasıyla değil gruplar halinde. Bir madde ele alınınca buradan silinir.

## Arayüz

- **Mobilde tam ekranda yatay mod.** Android'de tam ekrana geçince ekran dik kalıyor. Öneri: `LobbyPage.tsx` `toggleFullscreen` içinde, dokunmatik cihazda (`pointer: coarse`) tam ekran başarılı olunca `screen.orientation.lock("landscape")` (hata sessizce yok sayılır), tam ekrandan çıkınca `screen.orientation.unlock()`. iPhone Safari yön kilidini desteklemez; orada etkisi olmaz.

## Deploy ve altyapı

- **Alan adı + ACM sertifikası.** Şu an `*.cloudfront.net`. Eklenince CloudFront → EC2 trafiği de HTTPS'e alınmalı (origin secret şu an EC2'ye düz HTTP ile gidiyor; asıl koruma güvenlik grubu).
- **CI/CD (GitHub Actions).** Önce GitHub remote'u ve AWS OIDC rolü gerekir.
- **İzleme:** CloudWatch alarmları (sunucu sağlığı, 5xx), log toplama.
- **Remote Terraform state** (S3 + kilit). State şu an lokal `infra/terraform.tfstate`; içinde origin secret var, yedeklenmeli.
- **Dar yetkili IAM.** `watchparty-deploy` kullanıcısı şimdilik `AdministratorAccess`.
- **Release klasörü sahipliği.** `/opt/watchparty` ve release'ler uygulamanın kendi kullanıcısına ait; `root:root` + salt okunur daha güvenli (`user_data.sh.tftpl` ve `remote-deploy.sh` `WP_CHOWN`).
- **Kök dosyaların MIME tipi.** `deploy-frontend.ps1` js/css/html'i açık tiple yüklüyor; favicon gibi diğer kök dosyalar hâlâ Windows kayıt defterinden tahmin edilen tiple gidiyor.
- **Terraform kilit dosyası** yalnızca Windows hash'leri içeriyor; başka işletim sisteminde kullanılacaksa `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`.
- **Smoke testinde zaman aşımları.** `backend/e2e/smoke.mjs` fetch ve hub bağlantılarında süre sınırı yok; yanıt vermeyen bir uçta uzun süre bekleyebilir.
- **İlk sağlık denemesindeki gürültü.** `remote-deploy.sh` Kestrel açılmadan yaptığı ilk `curl` denemesinin hatasını stderr'e yazıyor ("Failed to connect"); deploy başarılı olsa da çıktıda hata gibi görünüyor.

## Uygulama

- Lobi şifresi / kişiyi atma gibi yetki özellikleri, host token.
- Çok sunuculu çalışma için Redis (şu an tüm durum tek sunucunun belleğinde; her deploy açık lobileri düşürür).
- Medya id'si 200 karakter sınırı: uzun (ör. imzalı) film URL'leri reddediliyor.
