# Yerel Docker kurulumu

[English](../../deploy/README.md)

TZR Cost Tracker'ı kendi bilgisayarınızda sentetik verilerle deneyin. `docker compose` eklentili Docker Engine veya Docker Desktop ve başlatıcı için Node.js 24 gerekir. Windows'ta Docker Desktop'ı Linux konteyner modunda kullanın. Windows ve WSL2/Linux sınandı. ARM64 doğrulaması QEMU emülasyonuyla yapıldı. Fiziksel macOS ve ARM makineleri henüz doğrulanmadı. [Kurulum kılavuzu](INSTALL.md)

## Başlatıcı ile açma ve kapatma

Depo kökünden çalıştırın. Başlatıcı imajları derler ve Compose'u ön planda çalıştırır.

```sh
node scripts/run-docker.mjs up
```

Başlatıcının gösterdiği yerel adresi açın. Varsayılan adres `http://127.0.0.1:18080` olur. Aşağıdaki komutu ayrı, özel bir terminalde çalıştırın ve gösterilen anahtarı ilk kurulum sihirbazına girin. Komut kurulum anahtarını yazdırdığı için ortak terminal günlüklerinden ve ekran kayıtlarından kaçının.

```sh
node scripts/run-docker.mjs setup-key
```

Başlatıcı kaynak dizininin yolundan üretilen Compose proje adını gösterir. Kurtarma için bu adı kaydedin. Bağımsız anahtarları ve seçilen portu `.cache/costcore-docker/local.env` dosyasında saklar ve sonraki çalıştırmalarda aynı dosyayı kullanır. Dosya eksik ve eşleşen volume mevcutsa başlatıcı yeni anahtar üretmeden durur. Env dosyasını özel tutun ve kurulum kayıtlarıyla birlikte yedekleyin. Windows'ta dosyaya ve üst dizinine erişimi kısıtlayın. Kaynak dizinini taşımak proje adını değiştirebilir. Başka konumdan başlatmadan önce veri volume'ünü kontrol edin.

Adlandırılmış veri volume'ünü koruyarak konteynerleri ve ağı durdurup kaldırın:

```sh
node scripts/run-docker.mjs down
```

## Compose'u elle çalıştırma

API, UID değeri `1000` olan `node` kullanıcısıyla çalışır, Compose ağında `4000` portunu dinler ve SQLite verilerini `/data` altında tutar. nginx web uygulamasını sunar ve `/api/` ile `/health` isteklerini API'ye iletir. Web portu `127.0.0.1:${WEB_PORT:-18080}` adresine bağlanır. Compose kalıcı `cost-core-data` volume'ünü genellikle `<proje>_cost-core-data` olarak adlandırır.

Operatör mevcut bir sır deposundan değer sağlıyorsa elle kurulum yolunu kullanın. `JWT_SECRET`, `MASTER_KEY`, `BLIND_INDEX_PEPPER` ve ilk çalıştırmada `BOOTSTRAP_TOKEN` için en az 32 karakterlik bağımsız, rastgele değerler sağlayın. Aynı volume kullanıldığında ilk üç değeri koruyun. Anahtarları Compose işlem ortamında veya özel env dosyasında tutun. Git'e, derleme argümanlarına, web ayarlarına ve ortak günlüklere yazmayın.

Kurulum, bakım ve kurtarma boyunca aynı `COSTCORE_COMPOSE_PROJECT` değerini kullanın. Operatörün yönettiği kurulumda Compose'un örtük `.env` aramasını önlemek için boş bir env dosyasını açıkça belirtin. Mevcut dosyanın üzerine yazmadan `.cache/compose-empty.env` dosyasını oluşturun. Devam etmeden önce dosyanın normal ve boş olduğunu kontrol edin. Komutları çalıştırmadan önce anahtarları mevcut işlem ortamına aktarın.

```sh
set -eu
umask 077
mkdir -p .cache
test ! -L .cache/compose-empty.env
touch .cache/compose-empty.env
test -f .cache/compose-empty.env && test ! -s .cache/compose-empty.env || exit 1
docker compose --env-file .cache/compose-empty.env -p "${COSTCORE_COMPOSE_PROJECT:?Set the Compose project name}" config --quiet
docker compose --env-file .cache/compose-empty.env -p "$COSTCORE_COMPOSE_PROJECT" up --build -d --wait
curl -fsS "http://127.0.0.1:${WEB_PORT:-18080}/health"
```

```powershell
New-Item -ItemType Directory -Force .cache | Out-Null
$composeEnvPath = '.cache/compose-empty.env'
if (-not (Test-Path -LiteralPath $composeEnvPath)) {
    New-Item -ItemType File -Path $composeEnvPath | Out-Null
}
$composeEnvFile = Get-Item -LiteralPath $composeEnvPath -Force
if ($composeEnvFile.PSIsContainer -or $composeEnvFile.LinkType -or $composeEnvFile.Length -ne 0) {
    throw 'Use an empty regular Compose environment file.'
}
if (-not $env:COSTCORE_COMPOSE_PROJECT) { throw 'Set the Compose project name.' }
docker compose --env-file $composeEnvPath -p $env:COSTCORE_COMPOSE_PROJECT config --quiet
if ($LASTEXITCODE) { throw 'Compose configuration failed.' }
docker compose --env-file $composeEnvPath -p $env:COSTCORE_COMPOSE_PROJECT up --build -d --wait
if ($LASTEXITCODE) { throw 'Compose startup failed.' }
$webPort = if ($env:WEB_PORT) { $env:WEB_PORT } else { '18080' }
Invoke-RestMethod "http://127.0.0.1:$webPort/health"
```

İlk çalıştırmada verilen `BOOTSTRAP_TOKEN` değerini girin. İlk yönetici oluşturulduğunda operatör bu değeri kaldırabilir ve API'yi yeniden oluşturabilir. `JWT_SECRET`, `MASTER_KEY` ve `BLIND_INDEX_PEPPER` aynı kalmalıdır. Tam Compose yapılandırması sırları gösterebildiği için doğrulamada `config --quiet` kullanın. [VPS pilotunda kurulum anahtarını kaldırma](VPS_PILOT_RUNBOOK.md#operatörün-sağladığı-sırlarla-ilk-çalıştırma)

## Compose ile çevrimdışı kurtarma

Kurtarmayı sentetik verilerle prova edin. Eski V1 yedek uçları kaldırıldı. Mevcut V1 dosyalarını olası çevrimdışı dönüşüm için saklayın. V2, desteklenen veritabanı şemasındaki 11 tabloyu kapsar. Ek dosya verisi V2 kapsamı dışındadır. İmaj veya şema değişikliğinden önce V2 yedeğini, parolasını ve önceki kurulumun anahtarları ile imajını doğrulayın. [İşletim kılavuzu](OPERATIONS.md)

Docker ana makinesinde veya aynı Docker bağlamına, kaynak dizinine ve volume'e erişen WSL2 ortamında bir POSIX kabuğu kullanın. Örnekler mevcut bir Compose projesi, hedef veritabanı ve önceden derlenmiş API imajı gerektirir. `COSTCORE_COMPOSE_PROJECT` değerine projenin tam adını, `COSTCORE_COMPOSE_ENV_FILE` değerine o kurulumun env dosyasını verin. Başlatıcıyla oluşturulan kurulum için yazdırılan proje adını ve `.cache/costcore-docker/local.env` dosyasını kullanın. Kabuk ortamında dosyadaki anahtarları değiştirecek değişkenler bulunmamalıdır. Elle yönetilen kurulum için mevcut proje adını ve açıkça seçilmiş boş env dosyasını kullanın, anahtarları Compose işlem ortamından sağlayın. Aynı Docker bağlamı ve Compose dosyasıyla işlem yapın.

Devam etmeden önce hedef proje ve volume'ü doğrulayın. Compose mevcut `/data` volume'ünü bağlamalıdır. `/data` dizini UID 1000 kullanıcısına ait olmalı, grup ve diğer kullanıcıların erişimi olmamalıdır. İmaj bu dizini `0700` izinleriyle oluşturur. Mevcut volume veya bind mount uyumsuzsa kurtarma durur. Önceki veritabanını ve yan dosyalarını yerinde bırakın.

```sh
set -eu
: "${COSTCORE_COMPOSE_PROJECT:?Set the existing Compose project name}"
: "${COSTCORE_COMPOSE_ENV_FILE:?Set the existing Compose environment file}"
test -f "$COSTCORE_COMPOSE_ENV_FILE" || exit 1
costcore_compose() {
  docker compose --env-file "$COSTCORE_COMPOSE_ENV_FILE" -f compose.yaml -p "$COSTCORE_COMPOSE_PROJECT" "$@"
}
docker volume inspect "${COSTCORE_COMPOSE_PROJECT}_cost-core-data" --format '{{.Name}}'
costcore_compose stop api
costcore_compose ps --all api
```

API'nin durduğunu ve veritabanını başka bir sürecin kullanmadığını doğrulayın. `RECOVERY_DIR` değerine `backup.vault` bulunan mutlak ana makine dizinini verin. API kullanıcısı bu dosyayı okuyabilmelidir. `RECOVERY_PASSWORD_FILE` değerine parolanın tam UTF-8 baytlarını sonuna satır sonu eklemeden tutan, yalnızca operatörün okuyabildiği dosyanın yolunu verin. Vault dizini salt okunur bağlanır ve parola dosyası ana makinede kalır. Kurtarma komutu parolayı stdin üzerinden alır ve hedef kurulumun `MASTER_KEY`, `BLIND_INDEX_PEPPER` ve geçerli `JWT_SECRET` değerlerini kullanır. Örnek bayt sınırı SQLite yan dosyalarını da kapsar.

```sh
costcore_compose run --rm --no-deps --pull never -T \
  --volume "${RECOVERY_DIR:?Set the absolute recovery directory}:/recovery:ro" \
  api node apps/server/dist/recovery-cli.js restore \
  /data/cost-core.sqlite 268435456 /recovery/backup.vault \
  < "${RECOVERY_PASSWORD_FILE:?Set the path to the private backup password file}"
```

`DATABASE_IN_USE`, başka bir sürecin veri dizini kilidini hâlâ tuttuğunu belirtir. `restored` sonucunda dönen `rollback` yolunu kaydedin. Önceki veritabanının doğrulanmış kopyası commit edilmiş WAL verisini içerir. `markerRemovalSync` değeri `unconfirmed` ise tekrar denemeden önce çıktıyı ve hedefi inceleyin. Kesinti sonrasında işaret tekrar görünebilir. Sonucu doğruladıktan sonra aynı kurulumu başlatın ve nginx'in değişmiş olabilecek API adresini yeniden çözmesi için web'i yeniden başlatın. Yeniden giriş yapın ve projeleri, toplamları ve denetim bütünlüğünü doğrulayın.

Kesintiye uğrayan bir geri yükleme bekleyen kurtarma işareti bırakabilir. API kapalıyken ve aynı Compose bağlamında çalıştırın:

```sh
costcore_compose run --rm --no-deps --pull never -T \
  api node apps/server/dist/recovery-cli.js rollback \
  /data/cost-core.sqlite 268435456 < /dev/null
```

`rolled-back` önceki veritabanının geri yüklendiğini gösterir. `no-pending-recovery` komutun bekleyen bir işaret bulmadığını belirtir. İşaret geçersizse, etkin veritabanı bilinmiyorsa veya SQLite yan dosyası kurtarmayı engelliyorsa dosyaları koruyun ve kurulumu inceleyin. Doğrulama tamamlanana kadar adlandırılmış volume'ü ve kurtarma dosyalarını saklayın. Bu işlem sırasında `down -v` kullanmayın, volume silmeyin ve Docker temizliği çalıştırmayın. [VPS pilot kılavuzu](VPS_PILOT_RUNBOOK.md)
