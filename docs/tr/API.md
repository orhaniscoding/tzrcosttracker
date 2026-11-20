# API referansı

Bu belge, kaynak adayında sunulan HTTP yüzeyini açıklar. API Fastify uygulamasıdır. Docker yığını içinde tarayıcı ve API aynı web kökünü kullanır; API `/api/*` ve `/health` üzerinden erişilir. Docker kullanılmayan geliştirme çalıştırmasında sunucu varsayılan olarak `127.0.0.1:4000` adresinde dinler.

## Kimlik doğrulama ve ortak kurallar

Çoğu API rotası `Authorization: Bearer <jwt>` ister. Belirteç yalnızca veritabanı oturumu etkin, süresi dolmamış ve etkin kullanıcıya bağlıysa kabul edilir. İki aşamalı doğrulama bekleyen geçici belirteç korumalı rotaları çağıramaz. Sunucu, korumalı yazma ve hassas okumalarda kullanıcı rolünü ve proje kapsamını yeniden okur; rol, üyelik veya oturum değiştikten sonra eski JWT kalıcı yetki vermez.

Desteklenen roller `admin`, `manager`, `accountant`, `auditor` ve `viewer` değerleridir.

- `admin`, yeni oturum ve proje kapsamı kontrolleriyle kullanıcı, proje, üyelik, kategori, cari, ayar, denetim doğrulama ve yedek işlemlerini yönetebilir.
- `manager` ve `accountant`, rota ve proje kapsamının izin verdiği mali değişiklikleri yapabilir.
- `auditor` ve `viewer` salt okunurdur. Kendi izin verilen oturum, PIN veya iki aşamalı doğrulama işlemlerini ve yinelenen işlem kontrolünü yine kullanabilirler.
- Proje üyeliği okuma ve yazmaları sınırlar. Yönetici yetkiliyse konsolide erişim görebilir; diğer roller yalnızca kendilerine açılan projeleri ve kayıtları görür.

## Hata ve durum sözleşmesi

Başarılı okumalar genellikle `200`, oluşturma işlemleri `201`, üyelik veya idempotent değişiklikler genellikle `200` döndürür. Yanıt CSV veya vault indirmesi değilse JSON'dur.

| Durum | Anlam |
| --- | --- |
| `400` | Geçersiz JSON, şema, kimlik, tarih filtresi, içe aktarma kaynağı veya başka istek verisi. |
| `401` | Eksik, süresi dolmuş, iptal edilmiş, bozuk veya geçersiz oturum (`SESSION_INVALID`). |
| `403` | Rol veya proje kapsamı işlemi izin vermiyor. Kayıt ve eski içe aktarma rotası da `403` verir. |
| `404` | Kayıt yok veya çağıranın kapsamı dışında. |
| `409` | Yinelenen kimlik, farklı gövdeli idempotency anahtarı, kategori döngüsü, değiştirilemez para birimi, kurtarma sırasında etkin veritabanı veya zaten açık 2FA gibi durum çakışması. |
| `413` | İçe aktarma gövdesi veya kaynağı sınırı aşıyor. |
| `429` | Giriş, PIN veya iki aşamalı doğrulama hız sınırı. `Retry-After` değerine uyun. |
| `500` | Beklenmeyen sunucu veya depolama hatası. Mali mutasyonu körlemesine tekrar etmeyin; idempotency anahtarını ve sonucu inceleyin. |

Hata gövdeleri çoğunlukla `error`, bazıları kararlı `code` ve doğrulama `details` alanını içerir. Hata metinleri şu anda Türkçe ürün arayüzüne göre yerelleştirilmiştir; istemciler mümkün olduğunda duruma ve kararlı kodlara göre dallanmalıdır.

## Herkese açık sistem rotaları

| Yöntem ve yol | Kimlik | Amaç ve yanıt |
| --- | --- | --- |
| `GET /health` | Yok | Canlılık kontrolü. `{ status: "ok", timestamp }` döndürür. |
| `GET /api/system/status` | Yok | İlk kurulum gerekip gerekmediğini ve kurulum durumunu bildirir. |
| `GET /api/system/templates` | Yok | Web ilk kurulum akışının kullandığı yerleşik kurulum/içe aktarma şablonlarını döndürür. |
| `POST /api/system/setup` | Kurulum anahtarı | Başlatılmamış dağıtımda ilk yöneticiyi oluşturur. `X-Setup-Token` gönderilir; kurulum bitene kadar normal giriş tamamlanmaz. |
| `POST /api/auth/register` | Devre dışı | Herkese açık kendi kendine kayıt bilinçli olarak kapalıdır ve `403` döndürür. Sonraki kullanıcıları yönetici oluşturur. |
| `GET /api/settings/white-label` | Yok | Kabukta gösterilen herkese açık markalama değerlerini okur; sır açmaz. |

Kurulum rotası tek seferlik bootstrap yoludur. `BOOTSTRAP_TOKEN` yalnızca sunucu işlem ortamında tutulmalı, ilk yönetici oluşturulduktan sonra kaldırılmalıdır.

## Kimlik, kullanıcı, oturum ve 2FA

| Yöntem ve yol | Kimlik/rol | Amaç |
| --- | --- | --- |
| `POST /api/auth/login` | Yok | `usernameOrEmail`, `password` ve isteğe bağlı TOTP/kurtarma kodunu alır. TOTP etkinse önce kısa süreli doğrulama yanıtı, sonra ikinci faktör gerekir. |
| `POST /api/auth/2fa/setup` | Giriş yapılmış | Geçerli kullanıcı için TOTP kurulumunu başlatır. Hız sınırlıdır ve etkin oturuma bağlıdır. |
| `POST /api/auth/2fa/enable` | Giriş yapılmış | Kurulum kodunu doğrular, TOTP'yi atomik olarak etkinleştirir ve tek kullanımlık kurtarma kodlarını döndürür. Kodları çevrimdışı saklayın. |
| `GET /api/auth/me` | Giriş yapılmış | Kullanıcı kimliği, rol, etkinlik, PIN ve 2FA durumunu döndürür. |
| `GET /api/auth/users` | Taze admin | Yönetim kullanıcı listesini döndürür. |
| `POST /api/auth/users` | Taze admin | Rol ve parola/PIN politikası ile yönetilen kullanıcı oluşturur. |
| `POST /api/auth/logout` | Giriş yapılmış | Geçerli oturumu iptal eder. |
| `POST /api/auth/logout-all` | Giriş yapılmış | Kullanıcının tüm oturumlarını iptal eder. |
| `POST /api/auth/users/:id/revoke-sessions` | Taze admin | Hedef kullanıcının tüm oturumlarını iptal eder. |
| `POST /api/auth/switch-pin` | Giriş yapılmış | Geçerli kullanıcının hızlı PIN'ini açar veya değiştirir. |
| `POST /api/auth/set-pin` | Giriş yapılmış | Gerekli parola/oturum kontrollerinden sonra kullanıcının PIN'ini ayarlar. |

Parolalar sunucuda doğrulanır. Parola, TOTP sırrı, kurtarma kodu, JWT veya yedek parolası URL'ye, kaynak koda, istemci günlüğüne veya issue'ya yazılmamalıdır.

## Proje ve üyelikler

| Yöntem ve yol | Kimlik/rol | Amaç |
| --- | --- | --- |
| `GET /api/projects` | Giriş yapılmış | Çağıranın görebildiği projeleri ve yetkiliyse konsolide görünümü listeler. |
| `POST /api/projects` | Taze admin | Proje oluşturur. |
| `GET /api/projects/:id/members` | Taze admin | Projeye atanmış kullanıcıları listeler. |
| `PUT /api/projects/:id/members/:userId` | Taze admin | Proje üyeliği ekler veya günceller. |
| `DELETE /api/projects/:id/members/:userId` | Taze admin | Proje üyeliğini kaldırır. |

Üyelik değişiklikleri taze işlem içinde kontrol edilir. Kaldırılan üye imzalı JWT taşısa bile sonraki korumalı isteklerde mevcut üyelik yeniden değerlendirilir.

## Cariler, hesaplar, kategoriler ve özel alanlar

| Yöntem ve yol | Kimlik/rol | Amaç |
| --- | --- | --- |
| `GET /api/parties` | Giriş yapılmış | Kapsamdaki cari tarafları listeler. |
| `POST /api/parties` | Taze admin | Tedarikçi, taşeron, ortak, kişi veya müşteri oluşturur. |
| `DELETE /api/parties/:id` | Taze admin | Alan kuralları izin veriyorsa cari siler. |
| `GET /api/accounts` | Giriş yapılmış | Kapsamdaki kasa, banka, POS, kredi kartı ve diğer hesapları listeler. |
| `POST /api/accounts` | Taze yazma rolü | Hesap oluşturur. Finansal kayıt kullandıktan sonra hesap para birimi değiştirilemez. |
| `POST /api/accounts/transfer` | Taze yazma rolü | Uygun hesaplar arasında tek mali işlemle para aktarır. |
| `GET /api/accounts/liquidity/summary` | Giriş yapılmış | Kapsamlı likidite özetini döndürür. |
| `GET /api/accounts/:id` | Giriş yapılmış | Kapsamda olan tek hesabı okur. |
| `PUT /api/accounts/:id` | Taze yazma rolü; bazı değişiklikler admin | İzin verilen hesap üstverisini günceller. Para birimi ve mevcut kayıtlarda kullanılan alanlar değiştirilemez. |
| `DELETE /api/accounts/:id` | Taze yazma rolü | Korunan mali bağımlılık yoksa hesabı siler. |
| `GET /api/categories` | Giriş yapılmış | Kapsamdaki kategori ağacını listeler. |
| `GET /api/categories/:id` | Giriş yapılmış | Kapsamdaki tek kategoriyi okur. |
| `POST /api/categories` | Taze admin | Kategori oluşturur. Döngü `409` ile reddedilir. |
| `PUT /api/categories/:id` | Taze admin | Kategoriyi günceller. |
| `DELETE /api/categories/:id` | Taze admin | Referans kuralları izin veriyorsa kategoriyi siler. |
| `GET /api/custom-fields` | Giriş yapılmış | Özel alan tanımlarını listeler. |
| `POST /api/custom-fields` | Taze admin | Özel alan tanımı ekler. |
| `GET /api/settings/white-label` | Yok | Herkese açık markalama varsayılanlarını okur. |
| `PUT /api/settings/white-label` | Taze admin | İzin verilen markalama alanlarını günceller; anahtar veya hesap verisini değiştirmez. |

## İşlemler ve mali etkiler

| Yöntem ve yol | Kimlik/rol | Amaç |
| --- | --- | --- |
| `POST /api/transactions/check-duplicate` | Giriş yapılmış | Oluşturmadan önce olası yinelenen mali girdiyi kontrol eder. Değişiklik yapmaz. |
| `GET /api/transactions` | Giriş yapılmış | Kapsamdaki işlemleri ve desteklenen filtreleri listeler. |
| `POST /api/transactions` | Taze yazma rolü | Gider, gelir veya transfer oluşturur. Tekrar güvenliği için UUID v4 `Idempotency-Key` gönderin. |
| `GET /api/transactions/trash` | Giriş yapılmış | Kapsamdaki silinmiş işlemleri listeler. |
| `GET /api/transactions/:id` | Giriş yapılmış | Kapsamdaki tek işlemi okur. |
| `PUT /api/transactions/:id` | Taze yazma rolü | Değiştirilebilir alanları günceller; kimlik, denetim ve mali değişmezleri korur. |
| `DELETE /api/transactions/:id` | Taze yazma rolü | İşlemi soft-delete eder ve mali/denetim değişikliğini kaydeder. |
| `DELETE /api/transactions/:id/permanent` | Taze admin | Alan kuralları izin veriyorsa çöp kaydını kalıcı siler. |
| `POST /api/transactions/:id/restore` | Taze yazma rolü | Geçerliyse silinmiş işlemi ve bağlı etkileri geri getirir. |
| `POST /api/transactions/:id/mark-paid` | Taze yazma rolü | Uygun işlemi ödenmiş işaretler ve korumalı ödeme etkisini uygular. |

Tekrar denenen oluşturmada aynı kullanıcı, aynı gövde ve aynı `Idempotency-Key` kullanılmalıdır. Anahtar farklı içerikle tekrar kullanılırsa çakışma döner. Zaman aşımı, borç oluşmadığının kanıtı değildir; tekrar etmeden önce işlem ve denetim durumunu okuyun.

## Rapor ve denetim

| Yöntem ve yol | Kimlik/rol | Amaç |
| --- | --- | --- |
| `GET /api/reports/balance` | Giriş yapılmış | Kapsamdaki bakiye verisini döndürür; doğrulanmış tarih ve proje filtrelerini destekler. |
| `GET /api/reports/summary` | Giriş yapılmış | Kapsamdaki mali özet verisini döndürür. |
| `GET /api/reports/export/csv` | Giriş yapılmış | Kapsamlı CSV raporu akıtır. Yanıtı mali veri olarak koruyun. |
| `GET /api/audit` | Taze admin | Denetim olaylarını listeler. |
| `GET /api/audit/verify` | Taze admin | Denetim zincirinin bozulup bozulmadığını doğrular. |

Rapor filtreleri rota doğrulamasının kabul ettiği ISO tarih ve zamanlarını kullanır. Geçersiz aralık, bilinmeyen proje veya kapsam dışı proje sessizce genişletilmez; reddedilir.

## İçe aktarma

| Yöntem ve yol | Kimlik/rol | Amaç |
| --- | --- | --- |
| `POST /api/import/analyze` | Taze admin | Sınırlandırılmış çalışma kitabını/kaynağı okur, sayfa sınırlarını doğrular ve önizleme/eşleme döndürür. |
| `POST /api/import/execute` | Taze admin | Doğrulanmış eşlemeyi sınırlandırılmış girdiden uygular. |
| `POST /api/import/karaelmas` | Giriş yapılmış | Eski yol devre dışıdır; `403` döndürür ve dosya yükleme yolunu gösterir. |

İçe aktarma istekleri boyut ve çalışma kitabı sınırlarına tabidir. Önce sentetik dosyayla önizlemeyi, sonra kaynakla karşılaştırmayı yapın. Her dış elektronik tablo hizmetiyle uyumluluk iddiası yoktur.

## Yedek ve çevrimdışı kurtarma

| Yöntem ve yol | Kimlik/rol | Amaç |
| --- | --- | --- |
| `POST /api/backup/export` | Giriş yapılmış; yedek izni | Eski kısmi yedek biçimini dışa aktarır. Desteklenen tam veritabanı dışa aktarımı için V2'yi kullanın. |
| `POST /api/backup/import` | Giriş yapılmış; yedek izni | Eski biçimi doğrulama kurallarıyla içe aktarır. |
| `POST /api/backup/export-v2` | Taze admin | Parola korumalı V2 vault oluşturur. Parola gövdede gönderilir; HTTPS kullanın ve günlüğe yazmayın. |

V2 geri yükleme bilinçli olarak çevrimdışıdır. Derlenmiş `recovery-cli.js` komutunu mutlak veritabanı yolu, bayt sınırı ve mutlak vault yolu ile çalıştırın; yedek parolasını stdin üzerinden verin. Önce API'yi durdurun, volume ve SQLite yan dosyalarını doğrulayın, komutun bildirdiği geri alma kopyasını saklayın. [İşletim kılavuzuna](OPERATIONS.md) ve [kurulum kılavuzuna](INSTALL.md) bakın.

## Kaynak gerçekliği

İstek ve yanıt şekilleri `packages/types/src/index.ts` ortak Zod şemalarında ve `apps/server/src/routes/` altındaki rota uygulamalarında tanımlıdır. Bu belge oluşturulmuş bir OpenAPI şeması değil, sabit yüzey ve güvenlik anlamlarının bakım kılavuzudur.

[English version](../API.md)
