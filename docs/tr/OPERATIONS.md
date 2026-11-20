# İşletim kılavuzu

[English](../OPERATIONS.md)

Bu kılavuz mevcut bir kurulumun işletimini anlatır. Uygulamayı mali kayıtlarla kullanmadan önce yedekleme, kurtarma ve yükseltmeyi sentetik verilerle prova edin. [Kurulum](INSTALL.md) · [VPS pilotu](../../deploy/VPS_PILOT_RUNBOOK.md)

## Veri ve sırlar

- Docker Compose API'yi UID değeri `1000` olan `node` kullanıcısıyla çalıştırır. `cost-core-data` adlı volume, `/data/cost-core.sqlite` dosyasını tutar. Compose gerçek volume adına proje adını önek olarak ekler. Projeyi, volume'ü, kaynak sürümünü, ayar kaynağını ve çalıştırdığınız imajı kaydedin.
- Docker dışındaki kurulumda `DB_PATH` SQLite dosyasını gösterir. Yerel depolamada özel bir dizin ayırın ve API ile kurtarma komutunu aynı kullanıcıyla çalıştırın. API veri dizininde kilit tutar. Her veri dizininde tek API süreci çalıştırın ve SQLite yan dosyalarını onun yönetimine bırakın.
- `MASTER_KEY` ve `BLIND_INDEX_PEPPER` değerlerini kurulum kayıtlarıyla birlikte güvenli saklayın. Bunlar alanları koruduğu ve mevcut kör indeks eşleşmelerini sürdürdüğü için yeniden başlatmada ve olağan yükseltmede korunmalıdır. `JWT_SECRET` değerini de güvenli saklayın ve olağan yeniden başlatmada koruyun. JWT anahtarının değiştirilmesi imzalı oturumları geçersiz kılar. İlk kurulumdan sonra tek kullanımlık `BOOTSTRAP_TOKEN` değerini kaldırın ve diğer sırları koruyun.
- Anahtar, vault, parola, geri alma kopyası, rapor ve veritabanını sürüm denetiminden ve işletim günlüklerinden uzak tutun. V2 yedek parolasını vault dosyasından ayrı saklayın. Operatörün yönettiği bir sır deposunu tercih edin. Uygulama işlem ortamındaki değerleri okur.

## Sağlık ve erişim kontrolleri

Canlılık kontrolü için `/health` kullanın. Varsayılan Compose eşlemesinde kök adres `http://127.0.0.1:18080` olur. Compose dışındaki yerel API'de yapılandırılan API portuna doğrudan istek gönderin. Ana sayfanın yüklendiğini ve oturumsuz `/api/auth/me` isteğinin `401` döndürdüğünü doğrulayın. Ardından sentetik hesapla giriş yapıp bir proje açın ve rapor toplamlarını örnek kayıtlarla karşılaştırın.

API başlamazsa veri yolunu, dizin sahibini, yapılandırma ve kilit hatalarını, ayrıca yayınlanan portu inceleyin. Etkin kilit başka bir uygulama örneğini, çevrimdışı işlemi veya yanlış veri yolunu gösterebilir. Mevcut süreci inceleyin ve durana kadar bekleyin. Bekleyen kurtarma işareti varsa aşağıdaki geri alma adımlarını uygulayın.

## Yedek dışa aktarımı

1. Yönetici olarak giriş yapın ve **Denetim & Güvenlik → Şifreli Yedek (.tzrvault)** ekranını açın.
2. V2 dışa aktarımını seçin ve bağımsız, güçlü bir yedek parolası belirleyin. V2 parolası UTF-8 olarak 12 ile 256 bayt arasında olmalıdır. `.tzrvault` dosyasını indirin, beklenen kurulumdan geldiğini doğrulayın ve dosyayı parolasından ayrı, güvenli konumlarda saklayın.
3. Kaynak sürümünü, zamanı, V2 sürümünü, yaklaşık kayıt sayılarını ve dosyanın konumunu kaydedin. Yedeğe güvenmeden önce kurtarma provasıyla doğrulayın.

V2 desteklenen veritabanı şemasını kapsar ve yinelenen etkiyi önleyen mali işlem kayıtlarını içerir. Kurtarma mevcut oturumları geçersiz kılar. Ek dosya verileri desteklenen V2 sözleşmesi dışındadır. Ek referansı dışa aktarımı `BACKUP_V2_ATTACHMENTS_UNAVAILABLE` ile durdurabilir ve desteklenmeyen ilişkiler vault işlemini engelleyebilir. Tarayıcıdaki eski V1 içe aktarımı yalnızca beş tabloyu geri yükler ve tam veritabanı kurtarmasına uygun değildir. Yedek ekranında otomatik yedekleme ayarları bulunur. Yedek zamanlamasını ve doğrulamasını operatörün yönettiği bir süreçte yapın.

## Çevrimdışı geri yükleme ve geri alma

Doğrulanmış yöntem, derlenmiş kurtarma komutunu Linux'ta veya mevcut API imajında kullanır. Provayı atılabilir bir hedefte yapın. Üretim verisi için yedeğe güvenmeden önce mevcut sentetik hedef veritabanı olan ayrı bir kuruluma geri yükleyin ve aşağıdaki kabul kontrollerini tamamlayın.

1. Hedef veri dizinini, mevcut hedef SQLite dosyasını, uygulama sürümünü, yedeği ve yedek parolasını doğrulayın. Compose dağıtımında hedef kurulumla aynı proje adını, Compose dosyasını ve güvenli işlem ortamını kullanın. Hedef dizin kurtarma komutunun sahiplik ve gizlilik kontrollerini karşılamalıdır. API imajı `/data` dizinini `0700` izinleriyle oluşturur.
2. API'yi ve hedef dizini kullanan diğer süreçleri durdurun. Hedef veritabanını ve SQLite yan dosyalarını yerinde bırakın. Komut veri dizini kilidini alır, vault dosyasını doğrular ve yeni veritabanını hazırlar. `DATABASE_IN_USE` hedefin hâlâ kullanımda olduğunu belirtir.
3. Hedefin `MASTER_KEY`, `BLIND_INDEX_PEPPER` ve geçerli `JWT_SECRET` değerlerini işlem ortamında sağlayın. V2 korunan alanları ve kör indeksleri hedef için yeniden oluşturabildiğinden, hedef anahtarları kaynak anahtarlarından farklı olabilir. Parolayı sonuna satır sonu eklemeden, tam UTF-8 baytları olarak stdin üzerinden verin. Parolayı komut argümanından ve çıktıdan uzak tutun.
4. Derlenmiş yerel Linux kurulumunda aşağıdaki örneği kaynak kökünden çalıştırın. Mutlak yolları ve veritabanı bayt sınırını kendi kurulumunuza göre değiştirin.

   ```sh
   node apps/server/dist/recovery-cli.js restore /data/cost-core.sqlite 268435456 /recovery/backup.vault < /recovery/password
   ```

   Docker'da API kapalıyken komutu önceden derlenmiş API imajında çalıştırın. Tek kullanımlık konteynere özgün hedef volume'ü ve vault dosyası olan ayrı, salt okunur bir dizini bağlayın. Operatörün parola dosyasını ana makinede tutun ve içeriğini stdin üzerinden verin. Docker kılavuzundaki Compose komut dizisini kullanın. [Compose kurtarma adımları](../../deploy/README.md)

5. `status: restored` sonucunu denetleyin, bildirilen geri alma yolunu kaydedin ve servisi açmadan önce `markerRemovalSync: confirmed` değerini doğrulayın. Sonuç `unconfirmed` ise yeni bir geri yüklemeye başlamadan önce çıktı ve disk durumunu inceleyin. Komut, önceki veritabanının commit edilmiş WAL verisini de içeren doğrulanmış kopyasını korur.
6. Aynı API'yi hedef anahtarlarla başlatın ve yeniden giriş yapın. Eski oturumların reddedildiğini, beklenen proje ve toplamların geldiğini ve **Mühür Doğrulama (SHA-256)** kontrolünün geçtiğini doğrulayın. Aynı anahtar ve gövdeyle anahtarlı API oluşturma isteğini yeniden göndererek bakiyenin değişmediğini sınayın. Operatör geri yüklemeyi kabul edene kadar geri alma kopyasını saklayın.

Başarısız veya kesilen etkinleştirme bir kurtarma işareti bırakırsa API'yi kapalı tutup aynı veritabanı için geri alma komutunu uygulayın. Aynı çalıştırma bağlamını, hedef volume'ü ve sınırları kullanın. Aşağıdaki örnek yerel Linux kabuğu içindir.

```sh
node apps/server/dist/recovery-cli.js rollback /data/cost-core.sqlite 268435456
```

`rolled-back` önceki veritabanının geri yüklendiğini gösterir. `no-pending-recovery`, komutun kullanabileceği bekleyen kurtarma işareti olmadığını bildirir. İşaret geçersizse, etkin veritabanı bilinmiyorsa veya yan dosyalar kurtarmayı engelliyorsa mevcut dosyaları koruyun ve durumu inceleyin. Sonucu doğruladıktan sonra servisi başlatın. Doğrulama bitene kadar volume ve kurtarma dosyalarını koruyun.

## Yükseltme

1. Mevcut kaynak sürümünü veya imajı, Compose projesini, volume'ü ve sır referanslarını kaydedin. V2 yedeği alın ve kurtarma provası yapın. Belgelenen kurtarma veya çevrimdışı yedek süreciyle güvenli bir yükseltme öncesi kopyayı saklayın.
2. Yeni sürümün tam olarak kullanılacak halini ayrı bir sentetik kurulumda sınayın. Başlangıç şema geçişlerini, proje erişimini, raporları, denetim zincirini ve çevrimdışı kurtarmayı kontrol edin.
3. Mevcut API'yi durdurun, kaynağı veya imajları güncelleyin, aynı veri dizini ve anahtarlarla başlatın. Sağlığı, yetkilendirmeyi, bakiyeleri, dışa aktarmayı ve denetim bütünlüğünü doğrulayın.
4. Doğrulama başarısız olursa yeni API'yi durdurun. Yalnız kodu geri almak daha yeni bir veritabanı şeması bırakabilir. Şema geri dönüşü gerekiyorsa doğrulanmış yükseltme öncesi veritabanını ve ona uyan önceki uygulama sürümünü birlikte kullanın. Kullanıma açmadan önce aynı kabul sinyallerini yeniden kontrol edin.
