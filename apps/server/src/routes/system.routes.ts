import type { FastifyPluginAsync } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
function tokensMatch(a:string,b:string){const ha=createHash('sha256').update(a).digest();const hb=createHash('sha256').update(b).digest();return timingSafeEqual(ha,hb);}
import { sql } from 'drizzle-orm';
import { CurrencyCodeSchema, z } from '@cost-core/types';
import { SetupAlreadyCompletedError, users, type CostCoreDatabase } from '@cost-core/database';

export const SetupSchema = z.object({
  companyName: z.string().trim().min(1).max(100),
  baseCurrency: CurrencyCodeSchema.default('TRY'),
  admin: z.object({
    username: z.string().trim().min(3).max(50),
    fullName: z.string().trim().min(2).max(100),
    email: z.string().trim().email(),
    password: z.string().min(8).max(128),
    pin: z.string().regex(/^\d{4,6}$/, 'PIN 4-6 haneli sayı olmalıdır'),
  }),
  industryTemplate: z.enum(['construction', 'manufacturing', 'software', 'general', 'blank']).default('general'),
  projectName: z.string().trim().max(100).optional(),
});

export const systemRoutes: FastifyPluginAsync = async (fastify) => {
  const { userRepo, config, setupRepo } = fastify;
  const db = fastify.db as CostCoreDatabase;

  // 1. SİSTEM DURUMU (İlk Kurulum Gerekli mi?)
  // The anonymous bootstrap probe exposes readiness only.
  fastify.get('/status', async (_request, reply) => {
    try {
      const status = db.transaction((tx) => {
        const existingUser = tx.select({ exists: sql<number>`1` }).from(users).limit(1).get();
        const hasUsers = !!existingUser;
        return {
          needsSetup: !hasUsers,
          isFirstRun: !hasUsers,
          hasUsers,
        };
      });
      return reply.send(status);
    } catch {
      return reply.status(500).send({ error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' });
    }
  });

  // 2. SEKTÖR ŞABLONLARI LİSTESİ
  fastify.get('/templates', async (_request, reply) => {
    return reply.send([
      {
        id: 'construction',
        title: '🏗️ İnşaat, Taahhüt & Şantiye',
        description: 'Kaba yapı, ince işler, elektrik-mekanik, taşeron hakedişleri ve şantiye genel giderleri',
        categoryCount: 16,
      },
      {
        id: 'manufacturing',
        title: '🏭 İmalat, Üretim & Fabrika',
        description: 'Hammadde, makine bakım, lojistik, ambalaj, üretim işçiliği ve enerji giderleri',
        categoryCount: 12,
      },
      {
        id: 'software',
        title: '💻 Yazılım, Teknoloji & SaaS',
        description: 'Bulut sunucu (AWS/GCP), SaaS yazılım lisansları, freelance geliştirici ve reklam bütçeleri',
        categoryCount: 10,
      },
      {
        id: 'general',
        title: '🏢 Genel İşletme & Hizmet',
        description: 'Ofis kirası, personel maaşları, muhasebe/hukuk, faturalar ve genel operasyonel maliyetler',
        categoryCount: 10,
      },
      {
        id: 'blank',
        title: '⚪ Sıfırdan Boş Başlangıç',
        description: 'Kendi özel kategori ağacını sıfırdan tamamen kendin oluştur',
        categoryCount: 1,
      },
    ]);
  });

  // 3. İLK KURULUM SİHİRBAZI ÇALIŞTIRMA (ONBOARDING EXECUTE)
  fastify.post('/setup', { preHandler: fastify.rateLimit({ max: 15, timeWindow: 60_000, keyGenerator: request => 'setup:' + request.ip }) }, async (request, reply) => {
    const expected=config.bootstrapToken;const provided=request.headers['x-setup-token'];if(!expected||expected.length<32||typeof provided!=='string'||!tokensMatch(provided,expected)){return reply.status(403).send({error:'Kurulum yetkilendirmesi başarısız.'});}
    // Sadece sistemde henüz kullanıcı yokken çalışabilir (Yetkisiz kuruluma kapalı!)
    const existingUsers = await userRepo.listUsers();
    if (existingUsers.length > 0) {
      return reply.status(403).send({ error: 'Sistem kurulumu zaten daha önce tamamlanmış.' });
    }

    const parse = SetupSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Geçersiz kurulum verisi', details: parse.error.format() });
    }

    const { companyName, baseCurrency, admin, industryTemplate, projectName } = parse.data;
    let result;
    try {
      result = await setupRepo.performSetup({
        companyName: companyName.trim(),
        appTitle: companyName.trim() + ' Maliyet & Finans',
        baseCurrency,
        admin: { username: admin.username, fullName: admin.fullName, email: admin.email, password: admin.password, pin: admin.pin },
        industryTemplate,
        projectName: (projectName && projectName.trim()) || (companyName.trim() + ' Ana Bütçe'),
        templateCategories: getIndustryCategories(industryTemplate),
        masterKey: config.masterKey, ipAddress: request.ip, userAgent: request.headers['user-agent'],
      });
    } catch (err) {
      if (err instanceof SetupAlreadyCompletedError) { return reply.status(403).send({ error: 'Sistem kurulumu zaten daha önce tamamlanmış.' }); }
      return reply.status(500).send({ error: 'Kurulum tamamlanamadı.' });
    }
    const token = fastify.jwt.sign({ id: result.user.id, username: result.user.username, role: result.user.role, sid: result.session.id, exp: result.session.expiresAt });
    return reply.status(201).send({
      success: true,
      message: 'TZRCoster kurulumu başarıyla tamamlandı!',
      token,
      user: result.user,
      project: result.project,
    });
  });
};

function getIndustryCategories(template: string): Array<{ name: string; color: string; budget?: number; subCategories?: string[] }> {
  switch (template) {
    case 'construction':
      return [
        {
          name: 'Kaba Yapı',
          color: '#DC2626',
          subCategories: ['İnşaat Demiri', 'Hazır Beton', 'Kalıp & İskele İşçiliği', 'Tuğla & Gazbeton Duvar'],
        },
        {
          name: 'İnce İşler',
          color: '#EA580C',
          subCategories: ['Alçı & İç Cephe Boya', 'Seramik & Granit Kaplama', 'Alüminyum Doğrama & Cam', 'Zemin Şapı & Yalıtım'],
        },
        {
          name: 'Elektrik & Mekanik Tesisat',
          color: '#D97706',
          subCategories: ['Kuvvetli & Zayıf Akım Tesisatı', 'Sıhhi Tesisat & Borulama', 'Isıtma, Soğutma & Havalandırma', 'Asansör Montajı'],
        },
        {
          name: 'Şantiye Genel Yönetim & Harçlar',
          color: '#2563EB',
          subCategories: ['İş Güvenliği & Sağlık (İSG)', 'Yemek & Personel Barınma', 'Belediye & Ruhsat Harçları', 'Akaryakıt & Nakliye'],
        },
      ];

    case 'manufacturing':
      return [
        {
          name: 'Hammadde & Yarı Mamul',
          color: '#DC2626',
          subCategories: ['Ana Hammadde Alımları', 'Kimyasal Katkılar & Boyalar', 'Yardımcı Malzemeler'],
        },
        {
          name: 'Makine, Ekipman & Bakım',
          color: '#D97706',
          subCategories: ['Yedek Parça Alımları', 'Periyodik Makine Bakımı', 'Arıza & Teknik Servis'],
        },
        {
          name: 'Lojistik, Depo & Sevkiyat',
          color: '#2563EB',
          subCategories: ['Hammadde Nakliyesi', 'Ürün Dağıtım & Kargo', 'Depolama & İstifleme'],
        },
        {
          name: 'Enerji, Tesis & İşletme',
          color: '#059669',
          subCategories: ['Sanayi Elektriği', 'Doğalgaz & Buhar', 'Fabrika Bakım & Güvenlik'],
        },
      ];

    case 'software':
      return [
        {
          name: 'Bulut & Sunucu Altyapısı',
          color: '#2563EB',
          subCategories: ['AWS / Google Cloud / Azure', 'Vercel / Supabase / Veritabanı', 'CDN & Alan Adları'],
        },
        {
          name: 'SaaS Araçları & Yazılım Lisansları',
          color: '#7C3AED',
          subCategories: ['GitHub & CI/CD Araçları', 'Figma & Tasarım Araçları', 'Slack / Notions / Verimlilik'],
        },
        {
          name: 'Dış Kaynak & Danışmanlık',
          color: '#D97706',
          subCategories: ['Freelance Geliştirici Ödemeleri', 'Güvenlik & Penetrasyon Testi', 'Hukuk & Muhasebe'],
        },
        {
          name: 'Büyüme & Pazarlama',
          color: '#059669',
          subCategories: ['Google & Meta Reklamları', 'İçerik & SEO', 'Etkinlik & Sponsorluklar'],
        },
      ];

    case 'blank':
      return [
        {
          name: 'Genel Giderler',
          color: '#2563EB',
          subCategories: ['Muhtelif Harcamalar'],
        },
      ];

    case 'general':
    default:
      return [
        {
          name: 'Personel & Bordro',
          color: '#2563EB',
          subCategories: ['Maaşlar & Avanslar', 'SGK & Stopaj Ödemeleri', 'Yemek & Ulaşım Destekleri'],
        },
        {
          name: 'Ofis & Tesis Giderleri',
          color: '#7C3AED',
          subCategories: ['Ofis Kirası & Aidat', 'Elektrik, Su & Doğalgaz', 'İnternet & Telefon'],
        },
        {
          name: 'Operasyon & Yönetim',
          color: '#059669',
          subCategories: ['Kırtasiye & Sarf Malzeme', 'Kargo & Kurye', 'Mali Müşavir & Hukuk Danışmanlığı'],
        },
        {
          name: 'Pazarlama & Müşteri İlişkileri',
          color: '#D97706',
          subCategories: ['Reklam & Tanıtım', 'Temsil & Ağırlama', 'Web Sitesi & Yazılım'],
        },
      ];
  }
}
