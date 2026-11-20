# TZR Cost Tracker yerel Docker kurulumu

Bu adımları kendi bilgisayarınızda sentetik verilerle denemek için kullanın. Ürünün durumu ve güvenlik kapsamı ana belgede açıklanır. [TZR Cost Tracker](../README.md)

## Önkoşullar

- Docker Engine/Desktop ve Compose eklentisi (`docker compose`).
- Kaynak kodun yerel kopyası ve bu dizin.
- Windows PowerShell veya POSIX kabuk.

Test edilen ortam: Windows ve WSL altında yerel Linux. ARM64 doğrulaması yalnızca QEMU emülasyonudur; fiziksel ARM donanımı değildir. macOS Docker ana makinesi amaçlanır ancak fiziksel macOS test edilmedi ve desteklenmiş sayılmaz.

## Bileşenler

- **API imajı:** iç port 4000, host üzerinde açılmaz; non-root `node` kullanıcısı (UID 1000); SQLite `/data` altında.
- **Web imajı:** nginx; yalnızca `127.0.0.1:${WEB_PORT:-18080}` adresine bağlanır (varsayılan 18080).
- **`cost-core-data` volume:** `/data` dizinini kalıcı tutar.

## Ortam değişkenleri

Süreç ortamı için zorunlu değerler:

- `JWT_SECRET`: en az 32 karakter, güvenli rastgele.
- `MASTER_KEY`: en az 32 karakter, güvenli rastgele.
- `BLIND_INDEX_PEPPER`: en az 32 karakter, güvenli rastgele.
- `BOOTSTRAP_TOKEN`: en az 32 karakter; ilk yönetici kurulumu için zorunlu, sonrasında isteğe bağlı.
- `WEB_PORT`: isteğe bağlı; varsayılan 18080.

Anahtarları kullanıcı güvenli biçimde sağlar ve saklar. Değerler `VITE_*`, ön yüz, derleme argümanı, git veya günlük çıktısına yazılmaz; gerçek sırlar yazdırılmaz. `--env-file` ile açıkça verilen dosya kullanıldığı için Compose otomatik `.env` dosyasını okumaz; zorunlu sırlar süreç ortamından sağlanır.

## Compose env dosyası

`.cache/compose-empty.env` adında açıkça yeni ve boş bir dosya kullanın; böylece Compose otomatik `.env` dosyasını almak zorunda kalmaz. Dosya zaten varsa içeriğinin boş olduğunu kullanıcı doğrular; mevcut dosya kesilmez.

Aşağıdaki iki örnekten yalnızca kullandığınız kabuğa uygun olanı kullanın.

PowerShell örneği:

```powershell
New-Item -ItemType Directory -Force -Path .cache
New-Item -ItemType File -Path .cache\compose-empty.env
```

POSIX kabuk örneği:

```sh
mkdir -p .cache
touch .cache/compose-empty.env
```


## Çalıştırma komutları

Tüm komutlar depo kökünden ve şu açık env dosyasıyla çalıştırılır:

```sh
docker compose --env-file .cache/compose-empty.env config --quiet
docker compose --env-file .cache/compose-empty.env build
docker compose --env-file .cache/compose-empty.env up -d --force-recreate
docker compose --env-file .cache/compose-empty.env ps
```

`config` her zaman `--quiet` ile kullanılır; sessiz olmayan tam config çıktısı sırları gösterebileceği için çalıştırılmaz.

Sağlık ve arayüz adresleri (`WEB_PORT` farklıysa adreslerde o portu kullanın):

- Sağlık: `http://127.0.0.1:18080/health`
- Arayüz: `http://127.0.0.1:18080/`

İlk yönetici kurulumu `BOOTSTRAP_TOKEN` ile kontrollü yapılır; varsayılan parola veya hesap yoktur.

## Testten sonra durdurma

Test ve tarayıcı kontrolünden sonra servisi durdurmak için:

```sh
docker compose --env-file .cache/compose-empty.env stop
```

`stop` yalnızca konteynerleri durdurur; `cost-core-data` volume içeriği ve verisi korunur.

## Yükseltme ve geri dönüş sınırları

İmaj veya şema yükseltmesinden önce veri ve anahtar yedeğini doğrulayın. V1 yedeği beş tabloyu kısmen geri yükler. V2 yedeği 11 tabloyu kapsar. Aşağıdaki çevrimdışı komutlar Linux üzerinde mevcut bir hedef SQLite veritabanı içindir. Ek dosyaları ve üretim pilotu için ayrı kurtarma doğrulaması gerekir.

Yeni API imajı `/data` dizinini `node` kullanıcısına ait ve `0700` izinli oluşturur. Mevcut bir volume veya bind mount kullanıyorsanız, kurtarmadan önce hizmeti durdurun ve dizinin API kullanıcısına ait olduğunu, grup ve diğer kullanıcılara izin vermediğini doğrulayın. Bu koşul sağlanmazsa kurtarma komutu değişim yapmadan durur.

Kurtarma için hedef uygulamanın `MASTER_KEY`, `BLIND_INDEX_PEPPER` ve mevcut yapılandırma doğrulamasını karşılayan `JWT_SECRET` değerlerini güvenli süreç ortamından sağlayın. Yedek dosyasının yolu, mevcut hedefin yolu ve SQLite veritabanı ile günlükleri için bayt sınırı ayrı argümanlardır. Yedek parolası stdin üzerinden EOF'a kadar, baytları değiştirilmeden okunur. Parolayı komut satırında veya kabuk geçmişinde tutmayın. Parolayı tam baytlarıyla üreten güvenli giriş veya özel dosya kullanın.

Derlenmiş sunucu paketinin bulunduğu Linux ortamında örnek çağrı:

```sh
node apps/server/dist/recovery-cli.js restore /data/cost-core.sqlite 268435456 /recovery/backup.vault < /recovery/password
```

Komut, hedef dosyaya yazmadan önce yedeği doğrular ve eski veritabanının WAL dahil doğrulanmış bir kopyasını tutar. Sonuçtaki `rollback` alanı bu kopyanın yolunu verir. `markerRemovalSync` alanı `unconfirmed` ise yeni veritabanı yerinde doğrulanmıştır ancak güç kaybından sonra kurtarma işareti tekrar görünebilir. Yeni bir geri yüklemeye başlamadan önce çıktı ve dosya durumunu inceleyin.

Bir kesintiden sonra sunucu bekleyen kurtarma işareti bildirirse, sunucu kapalıyken ve aynı veri dizinini kullanarak eski doğrulanmış kopyayı geri yerleştirin:

```sh
node apps/server/dist/recovery-cli.js rollback /data/cost-core.sqlite 268435456
```

Başarılı geri dönme `rolled-back` döndürür. `no-pending-recovery` durumunda önceki işlem kullanılabilir bir işaret bırakmamıştır. Geçersiz işaret, bilinmeyen veritabanı özeti veya etkin SQLite yan dosyası durumunda işlemi durdurup mevcut dosyaları inceleyin. İşareti veya yan dosyaları elle silmeyin. Geri döndükten sonra servisi başlatıp oturum ve mali toplamları doğrulayın.

### Compose ile çevrimdışı kurtarma

Her komutta hedef kurulumun Compose proje adını, yapılandırma dosyalarını ve güvenli süreç ortamını kullanın. Önce API'yi durdurun. API'nin durduğunu ve başka sürecin aynı veritabanını kullanmadığını doğrulayın. Devam etmeden önce projenin mevcut `cost-core-data` volume'ünü ve içindeki hedef SQLite dosyasını doğrulayın. Bu komutlar önceden derlenmiş API imajını kullanır.

```sh
docker compose --env-file .cache/compose-empty.env stop api
docker compose --env-file .cache/compose-empty.env ps --all api
```

Aşağıdaki örnek POSIX kabuğu içindir. `RECOVERY_DIR` Docker ana makinesinde `backup.vault` dosyasının bulunduğu mutlak dizindir. UID 1000 dosyayı okuyabilmelidir. `RECOVERY_PASSWORD_FILE` ana makinedeki, yalnız operatörün okuyabildiği parola dosyasıdır. Dosya parolanın tam UTF-8 baytlarını içermelidir. Parola dosyası konteynere bağlanmaz.

```sh
docker compose --env-file .cache/compose-empty.env run --rm --no-deps --pull never -T \
  --volume "${RECOVERY_DIR:?Kurtarma dizinini belirtin}:/recovery:ro" \
  api node apps/server/dist/recovery-cli.js restore \
  /data/cost-core.sqlite 268435456 /recovery/backup.vault \
  < "${RECOVERY_PASSWORD_FILE:?Parola dosyasını belirtin}"
```

Compose, tek seferlik konteynere API'nin mevcut `/data` volume'ünü bağlar. Komut mevcut API kullanıcısıyla çalışır. Sonuçta `restored` ve `markerRemovalSync: confirmed` görünürse API'yi yeniden başlatın. Yeni oturum açıp proje kayıtlarını, denetim zincirini ve mali toplamları kontrol edin. Doğrulanmış önceki veritabanı kopyasının yolunu kurtarma kaydına alın.

Kesinti bir kurtarma işareti bıraktıysa, API duruyorken aynı Compose projesinde şu komutu kullanın.

```sh
docker compose --env-file .cache/compose-empty.env run --rm --no-deps --pull never -T \
  api node apps/server/dist/recovery-cli.js rollback \
  /data/cost-core.sqlite 268435456 < /dev/null
```

`down -v`, `prune` veya volume silme kullanılmaz. VPS, DNS, güvenlik duvarı, TLS ve barındırma tarifi bu kılavuzda yer almaz.

Windows Docker Desktop/WSL2 Linux konteyner modunu kullanmalıdır; macOS fiziksel olarak doğrulanmadı, ARM64 QEMU emülasyonu fiziksel donanım sayılmaz.
