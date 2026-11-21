# Kurulum ve ilk açılış

[English](../INSTALL.md) · [Proje ana sayfası](../../README.tr.md)

## Kurulum yöntemini seçin

Uygulamayı denemek için yerel ve sentetik bir kurulum kullanın. Her iki yöntem de arayüzü tarayıcıda açar ve verileri ana makinede tutar. Veritabanları ve anahtarları ayrıdır. Node.js 24 LTS ile npm kurun. Kaynak arşivini açın veya depoyu klonlayın ve kök dizininde terminal açın.

| Ana makine | Docker olmadan | Docker ile |
| --- | --- | --- |
| Windows x64 | PowerShell'de Windows Node.js ile çalıştırın. | Docker Desktop'ı Linux konteyner modunda kullanın. |
| Linux x64 veya WSL2 | Linux kabuğunda Linux Node.js ile çalıştırın. | Docker Engine ve Compose kullanın. |
| macOS | Node.js ve npm gerekir. Fiziksel macOS testi bekliyor. | Docker Desktop ve Compose kullanın. Fiziksel macOS testi bekliyor. |

Yerel bağımlılıklar Node sürümü ve ana makine mimarisiyle eşleşmelidir. Windows ve WSL arasında geçiş yaparken ayrı kurulum yapın. SQLite uyumlu ikili dosya bulamayıp kaynaktan derlerse çıktıda belirtilen platform derleme gereksinimlerini uygulayın. Yerel macOS ve fiziksel ARM donanımı doğrulanmış platform listesinde yer almıyor.

## Docker olmadan başlatın

```sh
node scripts/run-local.mjs
```

Başlatıcı npm aracılığıyla sabitlenmiş pnpm sürümüyle bağımlılıkları kurar, yerel bağımlılıkları yeniden derler ve uygulamayı derler. İlk çalıştırma indirme için ağ erişimi gerektirir. Fastify API `4000`, tarayıcı arayüzü `3000` portunu kullanır. İkisi de `127.0.0.1` adresine bağlanır. `Open http://127.0.0.1:3000` iletisini bekleyip adresi açın.

Başlatıcı `cost-core.sqlite` ile `.env` anahtar dosyasını kullanıcı dizininizde `.tzr-cost-tracker/local` altında saklar. Bağımsız bir test kurulumu için başlatmadan önce `COSTCORE_DATA_DIR` değişkenini özel bir dizine yönlendirin. Windows'ta dizini kendi kullanıcı profilinizin altında tutun ve yalnız güvenilen hesapların okuyabildiğinden emin olun. Yeniden başlatırken aynı veri dizini ve anahtarları koruyun. Ctrl+C ile durdurun. Bu başlatma modu yerel kullanım içindir. İnternete açık kurulum için [VPS pilotunu](VPS_PILOT_RUNBOOK.md) tamamlayın.

## Docker ile başlatın

Docker'ın çalıştığını ve `docker compose version` komutunun yanıt verdiğini kontrol edin. Başlatıcıyı kök dizinde çalıştırın.

```sh
node scripts/run-docker.mjs
```

Konteynerler sağlıklı duruma geldiğinde `http://127.0.0.1:18080` adresini açın. API portu konteyner ağı içinde kalır. Başlatıcı bu kaynak kopyası için ayrı bir Compose projesi oluşturur ve anahtarlar ile port için `.cache/costcore-docker/local.env` dosyasını kullanır. SQLite projenin adlandırılmış volume'ünde saklanır. Kaynak kopyasını taşımadan önce anahtar dosyasını güvenli şekilde yedekleyin ve gösterilen Compose proje adını kaydedin. 18080 portu doluysa ilk açılıştan önce `WEB_PORT` ayarlayın veya anahtar dosyasında `WEB_PORT` değerini değiştirin. Yeniden başlatırken aynı kaynak konumunu ve Docker context'ini kullanın.

Durdurulan ortamı `node scripts/run-docker.mjs` ile yeniden başlatın. Ctrl+C ön plandaki Compose çalışmasını durdurur. Aşağıdaki komut konteynerleri kaldırır ve veritabanı volume'ünü korur.

```sh
node scripts/run-docker.mjs down
```

## İlk yöneticiyi oluşturun

1. Kurulumunuza ait adreste kurulum sayfasını açın. Dil seçicisinden Türkçe veya İngilizceyi seçin.
2. Kuruluş adını ve ana para birimini girin. İlk projenin adını da verebilirsiniz.
3. Güçlü bir parolayla ilk yöneticiyi oluşturun ve ekran kilidi için kişisel dört haneli PIN belirleyin. Hazır giriş bilgileri yoktur.
4. Yerel başlatıcının gösterdiği dosyadaki `BOOTSTRAP_TOKEN` değerini girin. Docker için özel bir terminalde `node scripts/run-docker.mjs setup-key` komutunu kullanın. Anahtarı paylaşılan çıktılara eklemeyin. Sektör şablonunu seçip kurulumu bitirin.
5. İlk yönetici oluşturulduktan sonra tek kullanımlık kurulum anahtarını kaldırın. Yerel kurulumda başlatıcıyı Ctrl+C ile durdurup `.tzr-cost-tracker/local/.env` dosyasındaki (özel veri dizini seçtiyseniz `$COSTCORE_DATA_DIR/.env`) yalnızca `BOOTSTRAP_TOKEN` satırını silin. Docker kurulumunda `node scripts/run-docker.mjs down` komutunu çalıştırın, `.cache/costcore-docker/local.env` dosyasındaki yalnızca `BOOTSTRAP_TOKEN` satırını silin ve yeniden başlatın. `JWT_SECRET`, `MASTER_KEY` ve `BLIND_INDEX_PEPPER` değerlerini değiştirmeyin.
6. [Kullanıcı kılavuzu](USER-GUIDE.md) ile devam edin. Web adresindeki `/health` yanıtını kontrol edin ve kullanımdan önce rapor ve yedek akışlarını sentetik verilerle deneyin.

## Sorun giderme

| Belirti | Kontrol |
| --- | --- |
| `node` veya `npm` bulunamadı | Aynı kabuğun `PATH` değerinde Node.js 24 LTS ve npm bulunduğunu kontrol edin. |
| Kurulum veya derleme durdu | İlk hatayı okuyun. Paket kayıt servisine erişimi ve boş disk alanını kontrol edin. Etkin Node ve yerel paketlerin ana makinenizle eşleştiğini doğrulayın. Aynı kilit dosyasıyla yeniden başlatın. |
| Port kullanımda | Gerekli yerel portu kullanan işlemi durdurun veya Docker için başka bir web portu seçin. |
| Kurulum anahtarı eksik veya reddedildi | Çalışan kurulumun ürettiği anahtarı kullanın. İlk kurulum tamamlanınca kurulum ucu kapanır. |
| Mevcut verinin anahtar dosyası eksik | Başlatmadan önce orijinal anahtarları güvenli kopyalarınızdan geri alın. |
| Veritabanı kilidi veya kurtarma işareti | Diğer işlemi durdurun veya [çevrimdışı kurtarma talimatlarını](OPERATIONS.md) izleyin. Veritabanı ve SQLite yan dosyalarını birlikte tutun. |

Elle Compose kurulumu ve diğer yönetim seçenekleri için [Docker ve operatör yapılandırmasına](DOCKER.md) bakın.
