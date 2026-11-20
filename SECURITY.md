# Güvenlik bildirimi

Bu belge, TZR Cost Tracker güvenlik bulgularını bakımcıya özel olarak iletme yolunu açıklar.

## Açık bildirme

Depoda GitHub özel güvenlik bildirimi etkinse **Security → Report a vulnerability** yolunu kullanın.

Özel bildirim bağlantısı yoksa GitHub üzerinde yalnızca özel iletişim kanalı talep eden, hassas ayrıntı içermeyen bir issue açın. Açığın adımlarını, istismar kodunu, kimlik bilgilerini veya mali verileri herkese açık bir issue'ya eklemeyin. Bakımcı güvenli bir kanal sağladıktan sonra ayrıntıları özel olarak paylaşın.

Bildirimde etkilenen sürüm/commit, sentetik verilerle tekrar adımları, beklenen/gerçek davranış ve olası etki yeterlidir. Gerçek veritabanı, yedek, fatura, rapor, token, anahtar veya kişisel bilgi göndermeyin. Yetkiniz olmayan sistemlerde test yapmayın.

## Veri koruma kapsamı

Şifreleme sunucuda seçili hassas alanlara uygulanır; tüm veritabanı ve uçtan uca şifreleme iddiası yoktur. Anahtar ve sunucu güvenliği ayrıca sağlanmalıdır. Farklı hedef/anahtarda tam atomik kurtarma ve internet reverse proxy düzeninin doğrulanması tamamlanmadan gerçek mali veriyle canlı kullanım onaylanmaz.

## Sürüm desteği

Bu kaynak adayı için yanıt süresi veya destek süresi taahhüdü verilmemektedir.
