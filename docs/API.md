# API rehberi

Yerel Docker kurulumunda API, arayüzle aynı kök adresi kullanır. Varsayılan adres `http://127.0.0.1:18080` şeklindedir. Kimlik doğrulaması isteyen uçlara `Authorization: Bearer <token>` başlığı gönderin. Oturum belirtecini güvenli bir istemci ortamında saklayın.

| İşlem | Yöntem ve yol |
| --- | --- |
| Sunucu durumu | `GET /health` |
| Kurulum durumu | `GET /api/system/status` |
| İlk yönetici kurulumu | `POST /api/system/setup` ve `X-Setup-Token` başlığı |
| Oturum açma | `POST /api/auth/login` ile `usernameOrEmail` ve `password` |
| Oturum sahibini okuma | `GET /api/auth/me` |
| Erişilebilen projeler | `GET /api/projects` |
| Proje üyeleri | `GET /api/projects/:id/members` |
| Kasalar ve hesaplar | `GET /api/accounts`, `POST /api/accounts` |
| Kategoriler | `GET /api/categories` |
| İşlemler | `GET /api/transactions`, `POST /api/transactions` |
| Raporlar | `GET /api/reports/summary`, `GET /api/reports/balance` |
| CSV aktarımı | `GET /api/reports/export/csv` |
| Denetim zinciri | `GET /api/audit/verify` |
| V2 yedek dışa aktarımı | `POST /api/backup/export-v2` ile `backupPassword` |

Hesap, proje, rapor ve işlem uçları yetki ve proje kapsamı uygular. Denetim zinciri ve V2 yedek dışa aktarımı yönetici oturumu ister. TOTP etkin hesaplarda oturum açma ek bir doğrulama adımı gerektirir.

Yeni mali işlem oluştururken UUID v4 biçiminde `Idempotency-Key` gönderebilirsiniz. Yanıt alınamazsa aynı kullanıcıyla, aynı anahtar ve aynı gövdeyi kullanarak yeniden gönderin. Aynı anahtar farklı içerikle kullanıldığında API `409` döndürür. V2 geri yükleme çevrimdışı bir operatör işlemidir. [Geri yükleme kılavuzu](../deploy/README.md#compose-ile-çevrimdışı-kurtarma).

İstek alanları ve doğrulama kuralları [ortak şemalarda](../packages/types/src/index.ts) ve [sunucu rotalarında](../apps/server/src/routes/) bulunur.
