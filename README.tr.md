# TZR Cost Tracker

[Read in English](README.md)

[Güncel sürüm: v1.0.0](https://github.com/orhaniscoding/tzrcosttracker/releases/tag/v1.0.0)

TZR Cost Tracker, proje maliyetlerini, gelirleri, kasayı, banka hesaplarını ve ödemeleri izlemek için kendi bilgisayarınızda veya sunucunuzda çalıştırabileceğiniz bir web uygulamasıdır. Node.js veya Docker Compose ile başlattıktan sonra tarayıcıda açın.

## Hızlı başlangıç

Node.js 24 LTS ve npm kurun. Docker ile çalıştırmayı seçerseniz Docker ve Compose eklentisini de kurun. Kaynak arşivini indirin veya depoyu klonlayın ve kaynak dizininde bir terminal açın.

```sh
git clone https://github.com/orhaniscoding/tzrcosttracker.git
cd tzrcosttracker
```

| Kurulum | Komut | Tarayıcıda açın |
| --- | --- | --- |
| Docker olmadan | `node scripts/run-local.mjs` | http://127.0.0.1:3000 |
| Docker ile | `node scripts/run-docker.mjs` | http://127.0.0.1:18080 |

İlk açılışta bağımlılıkların kurulması veya imajların derlenmesi birkaç dakika sürebilir. Başlatıcı bağımsız sunucu anahtarları üretir ve tek seferlik kurulum anahtarını nereden alacağınızı gösterir. Sihirbazda bu anahtarla ilk yöneticiyi oluşturun. Yeniden başlatırken veya yükseltirken anahtarlarınızı koruyun. [Kurulum, ilk açılış ve sorun giderme](docs/tr/INSTALL.md)

## Yapabilecekleriniz

- Gelir, gider ve ödemeleri proje, kategori ve para birimine göre izleyin.
- Kasa ve banka bakiyelerini görüntüleyin, para girişlerini ve transferleri kaydedin, carileri yönetin.
- Kullanıcı ekleyin ve proje erişimi atayın. İki faktörlü doğrulama kullanın ve denetim zincirini kontrol edin.
- Mali raporları görüntüleyin, CSV dışa aktarın ve desteklenen tabloları içe alın.
- Parola korumalı V2 yedek alın. Çevrimdışı kurtarmayı ayrı bir test veritabanında prova edin. Ek dosyaları V2 kurtarma kapsamı dışındadır.

Sentetik veriyle deneyin. Bir proje, bir kategori ve 1.000 TRY açılış bakiyeli bir kasa oluşturun. Bu kasadan 125,25 TRY tutarında ödenmiş gider kaydedin. Son bakiye 874,75 TRY olur. [Kullanıcı kılavuzu](docs/tr/USER-GUIDE.md)

## Dokümantasyon

| Kılavuz | English | Türkçe |
| --- | --- | --- |
| Kurulum ve ilk açılış | [Install](docs/INSTALL.md) | [Kurulum](docs/tr/INSTALL.md) |
| Projeler, giderler ve raporlar | [User guide](docs/USER-GUIDE.md) | [Kullanıcı kılavuzu](docs/tr/USER-GUIDE.md) |
| HTTP API ve örnekler | [API](docs/API.md) | [API](docs/tr/API.md) |
| Mimari ve veri modeli | [Architecture](docs/ARCHITECTURE.md) | [Mimari](docs/tr/ARCHITECTURE.md) |
| İşletim, yedek ve geri yükleme | [Operations](docs/OPERATIONS.md) | [İşletim](docs/tr/OPERATIONS.md) |
| Docker ve VPS pilotu | [Docker](deploy/README.md) · [Pilot](deploy/VPS_PILOT_RUNBOOK.md) | [Docker](docs/tr/DOCKER.md) · [Pilot](docs/tr/VPS_PILOT_RUNBOOK.md) |
| Katkı, davranış ve güvenlik | [Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md) | [Katkı](docs/tr/CONTRIBUTING.md) · [Davranış](docs/tr/CODE_OF_CONDUCT.md) · [Güvenlik](docs/tr/SECURITY.md) |

## Projenin durumu

Bu, kendi sunucunuzda çalıştırabileceğiniz v1.0.0 kaynak sürümüdür; barındırılan bir hizmet değildir. Kurulum kılavuzundaki platform tablosu test edilen işletim sistemlerini ve kurulum yöntemlerini gösterir. İnternetten erişilen bir sunucuda şirket verisi saklamadan önce pilot adımlarını inceleyin. Sunucu seçili hassas alanları şifreler. SQLite veritabanını, yedekleri ve anahtarları ayrıca koruyun.

## Lisans ve atıf

TZR Cost Tracker [Apache-2.0](LICENSE) lisanslıdır. Dağıtımda [NOTICE](NOTICE) dosyasındaki `orhaniscoding` ve TZR Cost Tracker atfını koruyun. Bileşen lisansları için [üçüncü taraf bildirimlerine](THIRD_PARTY_NOTICES.md) bakın.
