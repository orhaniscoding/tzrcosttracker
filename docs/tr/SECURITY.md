# Güvenlik politikası

[English](../../SECURITY.md)

## Açığı özel olarak bildirme

GitHub'a giriş yapın ve TZR Cost Tracker deposunda **Security → Report a vulnerability** yolunu kullanın. Bu form bakımcıya özel bir bildirim açar. [Özel bildirim açın](https://github.com/orhaniscoding/tzrcosttracker/security/advisories/new)

Etkilenen sürümü veya commit'i, kurulum biçimini, sentetik veriyle kısa bir açıklamayı ve hangi erişim ya da veri sınırının etkilendiğini yazın. Beklenen davranışı, gözlenen davranışı ve tahmini etkiyi belirtin. Yalnızca sahibi olduğunuz veya test etmek için açık izin aldığınız sistemleri sınayın.

Bakımcı inceleme yaparken açıkla ilgili ayrıntıları özel tutun. Kimlik bilgilerini, token'ları, özel anahtarları, kişisel veya mali verileri ve canlı sistem ayrıntılarını çıkarın. Veritabanlarını, yedekleri, faturaları ve raporları bildirime eklemeyin. Bildirim formu kullanılamıyorsa özel iletişim kanalı istemek için bir issue açın ve ayrıntıları o kanala bırakın.

## Kapsam ve güvenlik özellikleri

Kaynak adayı tarayıcı istemcisini, Fastify API'yi, yerel SQLite depolamasını ve vault dosyasından çevrimdışı kurtarmayı kapsar. Oturum iptalini, rol denetimini, proje erişimini, mali değişikliklerin bütünlüğünü, girdi sınırlarını, korunan alanları, yedek doğrulamayı veya kurtarmayı etkileyen hataları bildirin. Hassas sunucu işlemleri geçerli kullanıcı ve proje izinlerini uygulamalıdır. Kurtarma işlemi vault dosyasını doğrulamalı ve etkinleştirmeden önce hedef veri dizini kilidini almalıdır.

Sunucu seçili alanları şifreler ve kendi anahtarlarıyla çözebilir. Sunucuyu, anahtarları, veritabanını, yedekleri ve tarayıcı oturumlarını kurulumunuza uygun biçimde koruyun. V2 kurtarma belgelenen veritabanı şemasını ve desteklenen ilişkileri kapsar. Gerçek mali kayıtları aktarmadan önce sentetik veriyle kurtarma provası yapın ve HTTPS kurulumunu doğrulayın. [Mimari](ARCHITECTURE.md) · [İşletim](OPERATIONS.md)

## Desteklenen sürümler

Depo şu anda bir kaynak adayı yayımlar. Sınadığınız kaynak sürümünü belirtin. Güvenlik yanıt süresi ve sürüm destek süresi henüz belirlenmemiştir.
