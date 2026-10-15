# Backlog

Yapılacaklar, önem sırasıyla değil gruplar halinde. Bir madde ele alınınca buradan silinir.

## Deploy ve altyapı

- **Alan adı + ACM sertifikası.** Şu an `*.cloudfront.net`. Eklenince CloudFront → EC2 trafiği de HTTPS'e alınmalı (origin secret şu an EC2'ye düz HTTP ile gidiyor; asıl koruma güvenlik grubu).
- **Log toplama:** uygulama logları şu an yalnızca sunucudaki journald'da (SSM ile okunuyor); CloudWatch Logs'a gönderilmiyor.
- **GitHub deploy'unda OIDC'ye geçiş.** Hesap Free Tier'da olduğu için (AWS'nin SCP'si `iam:*Provider*`'ı yasaklıyor) deploy kalıcı access key'le yapılıyor. Hesap Paid Plan'a yükseltilince (en geç hesap 6 ayını doldurunca zorunlu) `infra/github.tf`'te OIDC sağlayıcısı + `master`'a güvenen rol kurulmalı, iş akışı `role-to-assume`'a dönmeli, kullanıcı ve anahtarı silinmeli. Tasarım: `docs/superpowers/specs/2026-10-13-ci-cd.md` (git geçmişinde OIDC hali).
- **Dar yetkili IAM.** `watchparty-deploy` kullanıcısı şimdilik `AdministratorAccess`.
- **Release klasörü sahipliği.** `/opt/watchparty` ve release'ler uygulamanın kendi kullanıcısına ait; `root:root` + salt okunur daha güvenli (`user_data.sh.tftpl` ve `remote-deploy.sh` `WP_CHOWN`).
- **Kök dosyaların MIME tipi.** `deploy-frontend.ps1` js/css/html'i açık tiple yüklüyor; favicon gibi diğer kök dosyalar hâlâ Windows kayıt defterinden tahmin edilen tiple gidiyor.
- **Terraform kilit dosyası** yalnızca Windows hash'leri içeriyor; başka işletim sisteminde kullanılacaksa `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`.
- **Smoke testinde zaman aşımları.** `backend/e2e/smoke.mjs` fetch ve hub bağlantılarında süre sınırı yok; yanıt vermeyen bir uçta uzun süre bekleyebilir.

## Uygulama

- **Yükleme anahtarı işlemleri sunucuyu yeniden başlatıyor.** `upload-keys.ps1`'in her `-Init`/`-Add`/`-Remove` çağrısı servisi yeniden başlatıp açık lobileri düşürüyor (2026-10-15 akşamı üst üste üç yeniden başlatma lobileri düşürdü). Anahtarları ayrı bir dosyadan okuyup değişince yeniden yüklemek (`IOptionsMonitor` + dosya izleme) ya da en azından birden çok işlemi tek yeniden başlatmada toplamak gerekir.
- **Script çıktısında Türkçe karakter bozulması.** `upload-keys.ps1` sunucudan dönen "Sağlık kontrolü başarılı" mesajını "SaÄŸlÄ±k" diye gösteriyor (SSM çıktısı UTF-8, konsol kod sayfası farklı).

- Yükleme sınırları (6 GB / 2 MB) anahtar sahipleri için tavsiye niteliğinde: parça URL'leri ve altyazı putUrl Content-Length imzalamıyor; gerekirse imzalı Content-Length ve tamamlama sonrası HeadObject.
- **Oynatma durumu sürüm numarası.** Hub yayınları kilit dışında gönderildiği için iki değişiklik istemcilere ters sırada ulaşabilir (ör. bekleme başladı/bitti); istemci en fazla 10 sn'lik yeniden yayına kadar eski durumda kalır. `PlaybackState`'e artan bir `Version` eklenip istemcinin eskileri atması çözer.
- **Bekleme küçükleri.** Geç fark edilen kopmadan sonra kişinin eski bağlantı kimliği 10 sn listede kalabiliyor ("hayalet" bekleme); `Lobby`'deki tekrar sayacı sözlükleri lobi ömrü boyunca temizlenmiyor; YouTube reklamları ya da otomatik oynatma engeli BUFFERING görünürse grup bekleyebilir (canlıda gözlenmedi).
- **Sohbet küçükleri.** Yan paneldeki zil satırı mobilde ~40 px yer kaplıyor (sohbet formuna ya da köşeye taşınabilir); aynı takma adlı iki kişide "kendi mesajım" ayrımı takma ada dayanıyor.

- **Sesli sohbet için TURN.** Yalnızca STUN var; simetrik NAT ya da kısıtlı ağlardaki kişiler "Bağlanamadı" görür. coturn (EC2'de ayrı port/güvenlik grubu) ya da bir TURN hizmeti kurulup `Voice:IceServers` ayarına eklenir (istemci değişmez).
- **Sesli sohbette bas-konuş.** Şu an mikrofon açık/kapalı var; tuşa basılı tutarak konuşma yok.
- **6+ kişilik sesli sohbet için SFU.** Mesh en fazla 6 kişi; daha fazlası için sunucu tarafı yönlendirici (SFU) gerekir.
- Lobi şifresi / kişiyi atma gibi yetki özellikleri, host token.
- Çok sunuculu çalışma için Redis (şu an tüm durum tek sunucunun belleğinde; her deploy açık lobileri düşürür).
- Medya id'si 200 karakter sınırı: uzun (ör. imzalı) film URL'leri reddediliyor.
