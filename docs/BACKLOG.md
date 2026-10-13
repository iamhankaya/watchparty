# Backlog

Yapılacaklar, önem sırasıyla değil gruplar halinde. Bir madde ele alınınca buradan silinir.

## Deploy ve altyapı

- **Alan adı + ACM sertifikası.** Şu an `*.cloudfront.net`. Eklenince CloudFront → EC2 trafiği de HTTPS'e alınmalı (origin secret şu an EC2'ye düz HTTP ile gidiyor; asıl koruma güvenlik grubu).
- **Log toplama:** uygulama logları şu an yalnızca sunucudaki journald'da (SSM ile okunuyor); CloudWatch Logs'a gönderilmiyor.
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
