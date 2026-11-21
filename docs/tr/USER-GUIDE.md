# Kullanıcı kılavuzu

[English version](../USER-GUIDE.md)

TZR Cost Tracker, ekibin proje bazında gelir, gider, kasa hareketi ve ödeme kaydetmesine yardımcı olur. İlk denemede sentetik kayıtlar kullanın. Dil seçicisinden Türkçe veya İngilizceyi seçin. Tercih tarayıcıda saklanır. Bu kılavuz gerektiğinde ilgili kontrollerin Türkçe adlarını gösterir. [Kurulum kılavuzu](INSTALL.md)

## İlk giriş

1. Kurulum kılavuzundaki adresi açın. İlk çalıştırma sihirbazı `Kurulum anahtarı`, firma adı, temel para birimi, sektör şablonu ve yönetici hesabını ister. Kurulum anahtarı, operatörün verdiği `BOOTSTRAP_TOKEN` değeridir. Hesap parolanızı ayrı belirleyin.
2. Bir başlangıç şablonu veya boş kurulum seçin, ilk projeye ad verin ve yönetici formunu tamamlayın. Kayıt girmeden önce oluşan proje ve kategorileri inceleyin.
3. Kullanıcı adı veya e-posta ve parolanızla giriş yapın. TOTP etkin hesapta doğrulayıcı kodu veya kullanılmamış kurtarma kodu da istenir. Etkinleştirmek için iki aşamalı doğrulama penceresini açın ve kurulumu tamamlamadan önce kurtarma kodlarını özel bir yerde saklayın.

Her kişi için ayrı hesap kullanın. Yönetici **Kullanıcılar & Yetkiler → Yeni Kullanıcı Tanımla** üzerinden kullanıcı ekler ve proje üyeliği panelinden erişim verir. Yöneticiler ayarları ve kullanıcıları yönetir. Müdür ve muhasebeciler atanmış projelerinde izin verilen mali değişiklikleri yapabilir. Denetçi ve izleyiciler kendi kapsamlarında okuyabilir. Denetim ve yedek ekranları yönetici gerektirir.

## Projeyi düzenleme

1. Üstteki proje seçiciden belirli bir projeyi açın. Yönetici aynı yerden proje oluşturabilir. Konsolide seçenekte hesabın görebildiği projeler birlikte gösterilir. Kayıt girmeden veya rakamları karşılaştırmadan önce projeyi seçin.
2. **Kategori & Kalemler** altında kategori ağacını inceleyin. Rolünüz izin veriyorsa kategori veya alt kategori ekleyin. Belirli maliyet kalemi gereken kayıtlar için en alt düzeyde bir alt kategori oluşturun.
3. **Kasa & Finansman → Likidite & Cüzdanlar Hub'ı** üzerinden kasa veya banka hesabı açın. Doğru proje, para birimi ve açılış bakiyesini seçin. **Kasa & Nakit Girişleri** bölümünde kaydedilen katkı ayrı bir harekettir ve bakiyeye eklenir. Her açılış tutarını bir kez girin.

## Ödemeyi kaydetme ve kontrol etme

Sentetik bir örnek için açılış bakiyesi `1.000 TRY` olan kasa hesabına sahip bir proje seçin. Uygun kategoriyi belirleyin. **Maliyet & Harcamalar → Yeni Harcama Ekle** sayfasını açın. `125,25 TRY` gideri girin, şirket hesabını ve eşleşen para birimini seçin, ödenmiş olarak işaretleyip kaydedin. Başka hareket yoksa beklenen hesap bakiyesi `874,75 TRY` olur. Kaydı **Harcama Tablosu** ekranında bulun ve sonucu **Kasa & Finansman → Bilanço & Vade Radarı** bölümünde karşılaştırın.

- Ödemeyi işletme yapıyorsa şirket hesabını seçin. Vadeli gideri ödeme gerçekleşene kadar beklemede tutun ve uygun kayıtta ödeme işlemini kullanın.
- Bir kişi işletme giderini kendi cebinden ödediğinde **Oto-Kasa (Ortak Kendi Cebinden)** seçeneğini ve ödeyen kişinin adını girin. Bağlı katkı **Şahıs / Ortak Bilançosu** bölümünde görülür. Ayrı bir geri ödeme kaydetmeden önce işlemin iki tarafını da inceleyin.
- Uygun hesaplar arasında mevcut parayı taşımak için cüzdan transferini, gerçek bir katkıyı kaydetmek için kasa girişi ekranını kullanın. Mevcut kayıtlar hesabı kullandıktan sonra para birimi veya açılış bakiyesi değiştirilemeyebilir.
- Silinmiş kayıtları incelemek ve uygun kaydı geri getirmek için **Çöp Kutusu & Geri Alma** bölümünü kullanın. Silme ve geri alma bakiyeyi ve bağlı kayıtları etkileyebilir. Her iki işlemden sonra mali sonucu karşılaştırın.

## Rapor, içe aktarma ve dışa aktarma

Grafikler, tarih aralıklı rapor, günlük kasa mizanı ve 12 aylık rapor için **Raporlar & Analiz** bölümünü açın. Etkin projeyi, dönemi ve karşılaştırdığınız para birimlerini kontrol edin. Açılış bakiyeleri, ödemeler, bekleyen giderler ve katkılar mutabakatın ayrı parçalarıdır. Yetkili olduğunuz kapsamın CSV çıktısını indirin ve mali veri olarak koruyun.

Desteklenen bir çalışma kitabını içe aktarırken küçük, sentetik bir dosyayla sayfa ve sütun eşlemesini önizleyin. Bilinen bir satırda tarih, ondalık ayıracı, para birimi, tutarın işareti, kategori ve hedef projeyi doğrulayın. Bildirilen başarıları ve hataları inceleyin, ilerlemeden önce aktarılan toplamları karşılaştırın. İçe aktarmayı yönetici yapar. Toplu girişlerde satır veya dosya sınırı olabilir.

Yönetici denetim zincirini **Denetim & Güvenlik → Mühür Doğrulama (SHA-256)** bölümünde doğrulayabilir ve **Şifreli Yedek (.tzrvault)** ekranından V2 `.tzrvault` dosyası indirebilir. Kurtarmayı operatör, API kapalıyken yapar. [İşletim kılavuzu](OPERATIONS.md)

## Sorun giderme

| Belirti | Kontrol |
| --- | --- |
| İlk kurulum anahtarı reddediyor | Bu kurulum için operatörün verdiği tam anahtarı kullanın. Web adresini ve yöneticinin daha önce oluşturulup oluşturulmadığını doğrulayın. |
| Proje veya menü görünmüyor | Giriş yapılan hesabı, rolü, atanmış proje üyeliğini ve seçili projeyi kontrol edin. Erişimi yöneticiyle doğrulayın. |
| Ödeme girerken hesap görünmüyor | Hesabın projesini, etkinliğini, para birimini ve formdaki ödeme kaynağını kontrol edin. |
| Bakiye bekleneni karşılamıyor | Projeyi, rapor tarihlerini, para birimini, açılış bakiyesini, ödeme durumunu ve bağlı Oto-Kasa veya transfer kayıtlarını kontrol edin. |
| Kayıt isteği zaman aşımına uğradı | Tekrar göndermeden önce listeyi yenileyin ve denetim kaydını veya hesap etkisini kontrol edin. `Idempotency-Key` gönderen API istemcisi aynı gövdeyi aynı anahtarla tekrar edebilir. |
| Kurtarma sonrası giriş başarısız veya ekran kilitli | Kurtarmadan sonra yeniden giriş yapın. Ekran kilidini geçerli hesap bilgileri veya tanımlı PIN ile açın. İptal edilen oturum veya kayıp kurtarma kodu için yöneticinize danışın. |
| V2 mevcut veriyi dışa aktarmıyor | Parolanın bayt sınırını karşıladığını doğrulayın. Yedeğe güvenmeden önce operatörden desteklenmeyen ekleri veya uyumsuz ilişkileri incelemesini isteyin. |
