# TZR Cost Tracker'a katkı

Katkıları yerel ortamda sentetik verilerle doğrulayın.

## Geliştirme ortamı

Node.js 24 ve pnpm 12.16.1 kullanın. Yeni, yerel bir çalışma dizininde:

```sh
pnpm install --frozen-lockfile
pnpm -r rebuild
pnpm exec turbo run test build --force
```

SQLite yerel bağımlılığı için platformunuza uygun derleme araçları gerekebilir. Bu komutlar CI ile uyumludur; yayımlanacak kaynak ağacının temiz clone kurulum doğrulaması ayrı yayın kapısıdır. Windows ve WSL/Linux kanıtları tutulur; fiziksel macOS üzerinde canlı test yapılmadı. Docker ile denemek için yerel kurulum adımlarını izleyin. [Docker kurulumu](deploy/README.md)

## Değişiklik gönderme

Bir değişiklik tek bir sorunu çözmeli. Sorunu, beklenen davranışı ve ilgili test sonucunu açıklayın. Mali hesap, yetki, migration ve kurtarma değişikliklerinde olumsuz senaryo ve rollback kanıtı ekleyin. Geçen testler tek başına gerçek mali veriyle kullanım kabulü oluşturmaz.

Testlerde yalnız sentetik veriler ve izole geçici veritabanları kullanın. Gerçek firma/müşteri bilgisi, fatura, rapor, parola, anahtar, ortam dosyası, veritabanı, WAL veya ajan çıktısı göndermeyin. Güvenlik açıklarını SECURITY.md yönergesine göre bildirin.

Önerdiğiniz değişikliği pull request olarak gönderin ve çalıştırdığınız kontrolleri açıklamaya ekleyin.

Katkınızı gönderirken onu Apache-2.0 altında sunmaya hakkınız bulunduğundan emin olun. Üçüncü taraf kodların mevcut lisans ve telif bildirimlerini koruyun; yeni bağımlılıkları gerekçelendirin. Proje lisansı LICENSE, kaynak atfı NOTICE içindedir.
