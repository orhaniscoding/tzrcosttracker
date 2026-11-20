# VPS canlı pilot runbooku

Bu belge, TZR Cost Tracker'ı internete açmadan önce operatörün tamamlaması gereken adımları sınırlar. Codex otomatik olarak DNS, firewall, TLS, servis veya gerçek veritabanı değiştirmez.

## Mimari

- Compose `web` servisi yalnızca `127.0.0.1:${WEB_PORT:-18080}` üzerinde dinler.
- Dış reverse proxy, Compose için seçilen loopback adresine bağlanır.
- API konteyneri host portuna açılmaz; web nginx `/api/` isteklerini Compose içindeki API'ye iletir.
- TLS sertifikası reverse proxy tarafından yönetilir. Sertifika ve özel anahtar depo içine, Compose env dosyasına veya uygulama konteynerine yazılmaz.

## Pilot önkoşulları

1. VPS işletim sistemi ve Docker Compose sürümü desteklenen Linux sürümünde doğrulanır.
2. Alan adı A/AAAA kaydı VPS adresine yönlendirilir ve DNS yayılımı operatör tarafından doğrulanır.
3. Ağ kuralı HTTPS ve yönetim için gerekli bağlantılara izin verir. HTTP yönlendirmesi veya sertifika doğrulaması için 80 gerekiyorsa ayrıca açılır. Uygulama portu loopback üzerinde kalır.
4. `JWT_SECRET`, `MASTER_KEY`, `BLIND_INDEX_PEPPER` ve ilk kurulum için `BOOTSTRAP_TOKEN` güvenli bir secret store veya yalnız root/operatör erişimli dosyada tutulur. Değerler shell geçmişine, loga, image layer'ına veya Git'e yazılmaz.
5. Sır sağlayıcısı gerekli değerleri Compose komutlarını çalıştıran sürecin ortamına aktarır. `--env-file` için ayrı bir boş dosya kullanılır. Docker erişimi ve süreç ortamı operatörlerle sınırlandırılır.

## Yerel doğrulama ve açılış

Aynı Compose proje adını kurulum, güncelleme ve kurtarma boyunca kullanın. Örnek komutları depo kökünde ve sırları devralan kabukta çalıştırın. İlk `up` yeni kurulum içindir. Mevcut bir kurulumda güncellemeden önce aşağıdaki geri dönüş adımlarını uygulayın.

```sh
set -eu
umask 077
mkdir -p .cache
test ! -L .cache/compose-empty.env
touch .cache/compose-empty.env
test ! -s .cache/compose-empty.env
: "${JWT_SECRET:?JWT_SECRET süreç ortamında gerekli}"
: "${MASTER_KEY:?MASTER_KEY süreç ortamında gerekli}"
: "${BLIND_INDEX_PEPPER:?BLIND_INDEX_PEPPER süreç ortamında gerekli}"
: "${BOOTSTRAP_TOKEN:?İlk kurulum anahtarı süreç ortamında gerekli}"

docker compose --env-file .cache/compose-empty.env config --quiet
docker compose --env-file .cache/compose-empty.env build
docker compose --env-file .cache/compose-empty.env up -d --wait
docker compose --env-file .cache/compose-empty.env ps
curl -fsS "http://127.0.0.1:${WEB_PORT:-18080}/health"
```

İlk yönetici için kurulum ekranına `BOOTSTRAP_TOKEN` değerini girin. Kurulumdan sonra anahtarı sır sağlayıcısından ve kabuktan kaldırın. Çalışan API konteynerindeki değeri temizlemek için API'yi yeniden oluşturun. Aynı proje ve veri volume'ünü kullanın. Web nginx'in API adresini yeniden çözmesi için web'i yeniden başlatın.

```sh
unset BOOTSTRAP_TOKEN
docker compose --env-file .cache/compose-empty.env up -d --no-deps --force-recreate --wait api
docker compose --env-file .cache/compose-empty.env restart web
curl -fsS "http://127.0.0.1:${WEB_PORT:-18080}/health"
```

Arayüzden tekrar giriş yaparak projenin açıldığını doğrulayın. Kurulum anahtarını kaldırmak için JWT veya veri şifreleme anahtarlarını değiştirmeyin.

## Reverse proxy kapısı

Reverse proxy, HTTPS alan adını seçilen loopback portuna iletir.

- Dış proxy, gelen istemci başlıklarına güvenmeden `Host` ve kendi bağlantı bilgisini kullanır. Mevcut Fastify yapılandırması istemci kimliği için yönlendirme başlıklarına güvenmez. Kimlik doğrulama hız sınırlarının kullanıcıları ortak proxy adresinde nasıl etkilediğini pilotta ölçün.
- HTTP'yi HTTPS'e yönlendirir.
- WebSocket gerekmiyorsa yalnız normal HTTP/1.1 proxy kullanır.
- `/api/` için istek gövdesi ve zaman aşımı sınırlarını uygulamanın beklediği değerlerle uyumlu tutar.
- `/health` için dışarıya yalnız gerekli durum bilgisini açar; yönetim veya yedek uçlarını anonim hale getirmez.
- TLS 1.2+ ve otomatik sertifika yenileme kullanır; özel anahtar izinleri kısıtlıdır.

Gerçek alan adı, sertifika yolu ve firewall ayarları bu belgede örnek olarak bile sabitlenmez.

## İlk pilot kontrol listesi

- [ ] HTTPS sertifikası geçerli ve otomatik yenileme çalışıyor.
- [ ] HTTP istekleri HTTPS'e yönleniyor.
- [ ] Uygulama portu dışarıdan erişilemiyor.
- [ ] `/health` ve ana HTML yükleniyor.
- [ ] Anonim `/api/` çağrısı 401 veya beklenen yetki cevabını veriyor.
- [ ] Sentetik ilk kurulum, giriş, proje okuma ve tek mali işlem başarılı.
- [ ] V2 yedek üretimi sentetik veride başarılı.
- [ ] Geri yükleme öncesi servis durdurma ve `DATABASE_IN_USE` kilidi doğrulanıyor.
- [ ] Geri yükleme sonrası oturum iptali, audit zinciri ve mali toplamlar doğrulanıyor.
- [ ] Gerçek firma verisi taşınmadan önce rollback kopyası ve anahtar yedeği operatör tarafından doğrulanıyor.
- [ ] Dış erişim, backup ve restore loglarında secret veya mali veri bulunmadığı kontrol ediliyor.

## Geri dönüş

Yükseltmeden önce V2 yedeğini, hedef volume adını ve mevcut imaj sürümünü doğrulayın. [Compose ile çevrimdışı kurtarma](README.md#compose-ile-çevrimdışı-kurtarma) adımlarını aynı proje adıyla izleyin. Geri yükleme, servis durdurulduktan ve hedef volume doğrulandıktan sonra yedek parolasını stdin üzerinden alır. `down -v`, volume silme, `docker system prune` ve manuel SQLite yan dosyası silme kullanılmaz.

Bu runbook canlı deployment kanıtı değildir. Pilot ancak operatör DNS, TLS, firewall, secret store ve sentetik HTTP/backup/restore kontrollerini gerçekleştirdikten sonra kabul edilebilir.
