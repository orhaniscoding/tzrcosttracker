# TZR Cost Tracker'a katkı

[English](../../CONTRIBUTING.md)

Değişiklikleri derlemek ve doğrulamak için temiz bir kaynak kopyası ve sentetik kayıtlar kullanın. Yerel SQLite derleme önkoşulları için [kurulum kılavuzuna](INSTALL.md), konteyner akışı için [Docker kılavuzuna](DOCKER.md) bakın.

## Kontrolleri çalıştırma

Node.js 24 ve pnpm 12.16.1 kullanın. Aşağıdaki komutları depo kökünden çalıştırın.

```sh
pnpm install --frozen-lockfile
pnpm -r rebuild
pnpm exec turbo run test build --force
```

Linux CI görevi bu kontrolleri çalıştırır. Test ettiğiniz işletim sistemlerini ve çalışma zamanlarını belirtin. Linux testi WSL üzerindeyse bunu yazın. Mali hesaplama, yetkilendirme, şema geçişi veya kurtarma değişikliklerinde sınadığınız olumsuz durumları ve geri alma kontrollerini açıklayın.

## Pull request açma

1. Depoyu fork edin ve tek bir soruna odaklanan dal açın. Sorunu, beklenen davranışı ve çalıştırdığınız kontrolleri açıklayın. Davranış değiştiğinde İngilizce ve Türkçe belgeleri birlikte güncelleyin.
2. `main` dalını hedefleyen bir pull request açın. Dış katkıcının fork üzerinden açtığı pull request için CI başlamadan önce bir bakımcı Actions çalıştırmasını onaylamalıdır.
3. Dalınızı `main` ile güncelleyin, zorunlu `build-test` kontrolünün geçmesini bekleyin ve birleştirmeden önce inceleme konuşmalarını çözün. [Main kural seti](https://github.com/orhaniscoding/tzrcosttracker/rules/27718371) pull request ve squash birleştirmesi gerektirir. Zorlamalı push ve dal silme engellenir. Tek bakımcılı deponun mevcut onay eşiği sıfırdır. Zorunlu kontrol ve konuşma kuralı bakımcılar için de geçerlidir.

Testlerde sentetik, yalıtılmış veritabanları ve örnekler kullanın. Firma ve müşteri verilerini, faturaları, raporları, parolaları, anahtarları, ortam dosyalarını, SQLite dosyalarını ve yan dosyalarını, ayrıca ajan günlüklerini katkı dışında tutun. Güvenlik açıkları için [güvenlik politikasını](SECURITY.md) izleyin.

Yalnızca [Apache-2.0](../../LICENSE) altında sunma hakkınız bulunan çalışmaları gönderin. Üçüncü taraf kodlarının telif ve lisans bilgilerini koruyun, yeni bağımlılıkları açıklayın. [NOTICE](../../NOTICE), [üçüncü taraf bildirimleri](../../THIRD_PARTY_NOTICES.md) ve [davranış kurallarına](CODE_OF_CONDUCT.md) bakın.
