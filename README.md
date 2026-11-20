# TZR Cost Tracker

TZR Cost Tracker, ekiplerin proje bazında gelir, gider, kasa hareketi ve ödeme durumunu takip edebildiği, kendi sunucunuzda çalıştırabileceğiniz bir web uygulamasıdır. React arayüzü, Fastify API ve SQLite veritabanı aynı TypeScript çalışma alanında yer alır.

Bu depo **V1 kaynak adayını** sunar. Windows ve WSL2/Linux üzerinde derleme ve testler çalıştırıldı. Linux Docker ortamında sentetik verilerle HTTPS, işlem tekrarı ve V2 yedekten geri yükleme doğrulandı. Gerçek şirket verisiyle kullanımdan önce kendi sunucunuzda [pilot kılavuzunu](deploy/VPS_PILOT_RUNBOOK.md) uygulayın. Fiziksel macOS testi henüz yapılmadı.

## Özellikler

- Projeler oluşturun, kullanıcıları projelere atayın ve rollere göre erişim verin.
- Gelir, gider, kasa ve banka hesaplarını takip edin. Hareketleri kategoriye ve para birimine göre inceleyin.
- Raporları görüntüleyin, CSV dışa aktarın ve seçili kaynaklardan veri içe alın. İçe aktarılan değerleri kendi kayıtlarınızla karşılaştırın.
- Yönetici olarak denetim zincirini doğrulayın ve parola korumalı V2 yedek alın. Geri yükleme çevrimdışı yapılır. Ek dosyası olan kayıtlar için V2 kurtarma desteği sınırlıdır.
- API üzerinden aynı `Idempotency-Key` ile yinelenen işlem oluşturma isteğinin ikinci bir mali etki yaratmasını önleyin. İstemci aynı işlem için anahtarı saklamalıdır.

## Yerel kurulum

Docker ve `docker compose` gerekir. Depoyu klonlayın ve ayarları komutları çalıştıran sürece aktarın. İlk kurulumda birbirinden bağımsız rastgele `JWT_SECRET`, `MASTER_KEY`, `BLIND_INDEX_PEPPER` ve `BOOTSTRAP_TOKEN` gerekir. Ayrıntılar [Docker kurulum kılavuzunda](deploy/README.md) yer alır.

```sh
mkdir -p .cache
touch .cache/compose-empty.env
test ! -s .cache/compose-empty.env
docker compose --env-file .cache/compose-empty.env config --quiet
docker compose --env-file .cache/compose-empty.env up --build -d --wait
curl -fsS http://127.0.0.1:18080/health
```

Tarayıcıda `http://127.0.0.1:18080` adresini açın ve kurulum anahtarıyla ilk yöneticiyi oluşturun. Örnek bir proje, kategori ve 1.000 TRY açılış bakiyeli kasa ekleyin. Kasadan 125,25 TRY tutarında ödenmiş gider kaydettiğinizde bakiye 874,75 TRY olur. Yedek ve geri yüklemeyi önce sentetik kayıtlarla deneyin.

## Geliştirme

Node.js 24 ve pnpm 12.16.1 ile bu komutları çalıştırın.

```sh
pnpm install --frozen-lockfile
pnpm -r rebuild
pnpm exec turbo run test build --force
```

| Dizin | İçerik |
| --- | --- |
| `apps/web` | React ve Vite arayüzü |
| `apps/server` | Fastify API, oturumlar, raporlar ve yedekleme |
| `packages/database` | Drizzle, SQLite ve migration işlemleri |
| `packages/crypto` | Şifreleme, kör indeks ve kimlik doğrulama yardımcıları |
| `packages/types` | Ortak TypeScript türleri ve Zod şemaları |

[API rehberi](docs/API.md) · [Katkı kılavuzu](CONTRIBUTING.md) · [Davranış kuralları](CODE_OF_CONDUCT.md)

## Güvenlik ve lisans

Sunucu, seçili hassas alanlarda AES-256-GCM, arama için HMAC-SHA256 kör indeksleri ve parola özetleri için scrypt kullanır. Diğer veritabanı alanları ve sunucu anahtarları ayrıca korunmalıdır. Oturum iptali, TOTP ve tek kullanımlık kurtarma kodları desteklenir. Açık bildirimleri için [güvenlik politikasına](SECURITY.md) bakın.

Kaynak kod [Apache-2.0](LICENSE) lisanslıdır. TZR Cost Tracker ve proje sahibi `orhaniscoding` için [NOTICE](NOTICE) dosyasındaki atıfları koruyun. Üçüncü taraf bileşenler kendi lisanslarına tabidir. [Üçüncü taraf bildirimleri](THIRD_PARTY_NOTICES.md).
