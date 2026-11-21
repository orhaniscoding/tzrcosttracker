# VPS pilot kılavuzu

[English](../../deploy/VPS_PILOT_RUNBOOK.md)

Firma verilerini taşımadan önce kullanılacak kurulumu sentetik kayıtlarla sınamak için bu listeyi kullanın. VPS, alan adı, güvenlik duvarı, TLS sertifikası, sır deposu ve kurtarma dosyalarını operatör yönetir.

## Pilot önkoşulları

1. Hedef VPS üzerinde Linux ortamını, Docker Engine'i ve Compose eklentisini doğrulayın. Pilot Linux konteynerleri kullanır.
2. Alan adının A veya AAAA kayıtlarını hedef adrese yönlendirin ve DNS çözümlemesini doğrulayın. HTTPS ve gerekli yönetim bağlantılarına izin verin. Sertifika doğrulaması veya yönlendirme için gerekiyorsa 80 portunu açın.
3. Compose web hizmetini `127.0.0.1:${WEB_PORT:-18080}` adresine bağlayın ve dış HTTPS vekilinden buraya yönlendirin. API Compose ağında kalır. nginx `/api/` ve `/health` isteklerini API'ye iletir. TLS sertifikasını ve anahtarı vekilin korumalı deposunda tutun.
4. `JWT_SECRET`, `MASTER_KEY`, `BLIND_INDEX_PEPPER` ve ilk kurulumda kullanılacak `BOOTSTRAP_TOKEN` değerlerini operatörün sır deposunda tutup Compose sürecine aktarın. Docker erişimini ve süreç incelemesini ihtiyaç duyan operatörlerle sınırlayın. Değerleri Git'e, terminal geçmişine, günlüklere ve imaj katmanlarına yazmayın.
5. Sınanan kaynak sürümünü veya imaj kimliğini, Compose proje adını, volume'ü ve sır referanslarını kaydedin. Bakım ve kurtarmada proje adını ve volume'ü koruyun. Yerel provada başlatıcı kaynak dizinine özgü bir proje adı gösterir ve `.cache/costcore-docker/local.env` dosyasını kullanır. [Yerel Docker kılavuzu](DOCKER.md)

## Operatörün sağladığı sırlarla ilk çalıştırma

Komutları depo kökünden çalıştırın. `COSTCORE_COMPOSE_PROJECT` değerini bu kurulum için seçilen proje adı olarak ayarlayın. Sırları işlem ortamında sağlayın ve Compose'un örtük `.env` aramasını önlemek için boş bir env dosyasını açıkça belirtin. İlk `up` komutunu yeni kurulumda kullanın. Mevcut kurulumu güncellemeden önce aşağıdaki yükseltme adımlarını izleyin.

```sh
set -eu
umask 077
mkdir -p .cache
test ! -L .cache/compose-empty.env
touch .cache/compose-empty.env
test -f .cache/compose-empty.env && test ! -s .cache/compose-empty.env || exit 1
: "${COSTCORE_COMPOSE_PROJECT:?Set the Compose project name}"
: "${JWT_SECRET:?Set JWT_SECRET in the process environment}"
: "${MASTER_KEY:?Set MASTER_KEY in the process environment}"
: "${BLIND_INDEX_PEPPER:?Set BLIND_INDEX_PEPPER in the process environment}"
: "${BOOTSTRAP_TOKEN:?Set BOOTSTRAP_TOKEN for first setup}"
costcore_compose() {
  docker compose --env-file .cache/compose-empty.env -f compose.yaml -p "$COSTCORE_COMPOSE_PROJECT" "$@"
}
costcore_compose config --quiet
costcore_compose build
costcore_compose up -d --wait
costcore_compose ps
curl -fsS "http://127.0.0.1:${WEB_PORT:-18080}/health"
```

Kurulum sihirbazını açın ve ilk yöneticiyi oluşturmak için kurulum anahtarını girin. Kurulumdan sonra `BOOTSTRAP_TOKEN` değerini sır sağlayıcısından kaldırın. Aynı Compose bağlamında değeri kabuktan kaldırın ve çalışan konteynerdeki değeri temizlemek için API'yi yeniden oluşturun. nginx'in API adresini tekrar çözmesi için web hizmetini yeniden başlatın. JWT ve şifreleme anahtarlarını ve veri volume'ünü koruyun.

```sh
unset BOOTSTRAP_TOKEN
costcore_compose up -d --no-deps --force-recreate --wait api
costcore_compose restart web
curl -fsS "http://127.0.0.1:${WEB_PORT:-18080}/health"
```

Yeniden giriş yapın ve beklenen projenin açıldığını doğrulayın.

## HTTPS ters vekili

- HTTPS adresini seçilen loopback portuna yönlendirin. Uygulama portunu dış arayüze açmayın.
- `Host` ve yönlendirme bilgilerini vekilin bağlantı ve yapılandırmasından üretin. Fastify, isteği yapan kişinin kimliğine güvenmek için yönlendirme başlıklarını kullanmaz. Aynı vekil adresindeki kullanıcıların giriş hız sınırını nasıl paylaştığını sınayın.
- TLS 1.2 veya üzerini, sertifika yenilemesini ve kısıtlı özel anahtar izinlerini kullanın. HTTP'nin HTTPS'e yönlendiğini doğrulayın.
- `/api/` gövde boyutu ve zaman aşımı sınırlarını, içe aktarma ve yedekleme dahil uygulamayla uyumlu tutun. Uygulamayı sunmak için gereken HTTP vekil ayarlarını kullanın.
- Yalnız gerekli canlılık bilgisini açın. Korumalı rotalar vekil üzerinden de beklenen kimlik doğrulama ve yetki kontrollerini uygulamalıdır.

## Pilot kabul listesi

- [ ] DNS hedef VPS'e ulaşır. HTTPS doğrulanır ve yenileme yapılandırılmıştır. HTTP, HTTPS'e yönlenir.
- [ ] Uygulama portuna dış arayüzden erişilemez. HTTPS adresi ana HTML sayfasını ve `/health` yanıtını sunar.
- [ ] Oturumsuz `/api/auth/me` isteği `401` döndürür.
- [ ] Sentetik ilk kurulum, giriş, proje okuma ve sonucu bilinen bir mali işlem başarılıdır.
- [ ] Operatör bir V2 yedeği dışa aktarır ve parolasını ayrı saklar.
- [ ] Kullanımdaki atılabilir hedefe kurtarma isteği `DATABASE_IN_USE` döndürür. Hedef anahtarlarla çevrimdışı geri yükleme başarılıdır ve doğrulanmış geri alma kopyası üretir.
- [ ] Operatör geri yükleme sonrasında yeniden giriş yapar, eski oturumların reddedildiğini doğrular, denetim zincirini kontrol eder ve örnek toplamları karşılaştırır. Aynı anahtarlı oluşturma isteğinin tekrarı hesap bakiyesini değiştirmez.
- [ ] Erişim, yedek ve kurtarma günlüklerinde sır veya mali veri yoktur. Operatör gerçek veriyle kullanım kabulünden önce geri alma kopyasını ve anahtar yedeğini doğrular.

## Yükseltme ve kurtarma

Yükseltmeden önce mevcut imaj ve volume'ü kaydedin, V2 yedeğini ve parolasını doğrulayın. Kullanılacak yeni sürümü ayrı bir sentetik kurulumda sınayın. Geri yüklemeden önce API'yi durdurup hedef volume'ü doğrulayın. Parolayı stdin üzerinden sağlayın ve mevcut volume ile tüm SQLite yan dosyalarını koruyun. [Compose ile çevrimdışı kurtarma](DOCKER.md#compose-ile-çevrimdışı-kurtarma) · [İşletim kılavuzu](OPERATIONS.md)

Kesintiden sonra kurtarma komutunu aynı hedef için çalıştırın ve yeniden başlatmadan önce sonucu doğrulayın. Geri alma sonrasında girişi, denetim zincirini ve toplamları tekrar kontrol edin. Şema değiştiyse doğrulanmış önceki veritabanını ona uyan eski uygulama sürümüyle kullanın.
