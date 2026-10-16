# ManageAllTV — Sistem Mimarisi (v0.3)

> **Durum:** Faz 1 (MVP) ve Faz 2'nin büyük kısmı kodlandı: sunucu, yönetim paneli, Android oynatıcı,
> kurulum dosyaları ve CI. Sıradaki adım pilot (Faz 0, §17): APK'nın gerçek TV'lerde denenmesi.

## 1. Amaç

Farklı konumlardaki televizyonları **tek bir web panelinden** yönetmek:

- Bilgisayardan (veya telefondan) resim ve video yüklemek,
- Bu içerikleri oynatma listelerine koyup istenen TV'lere / gruplara / konumlara atamak,
- TV'lerin durumunu görmek ve uzaktan komut göndermek,
- TV'ler ve yöneticiler aynı ağda da olsa tamamen farklı ağlarda da olsa çalışmak (ör. evden yönetim).

## 2. Gereksinimler

| Konu | Karar |
|---|---|
| Ölçek | İlk kurulumda **4 TV** ([kurulum envanteri](kurulum-envanteri.md)), ileride ~10 |
| TV'ler | Hepsi **Android TV** olacak (akıllı olmayan TV değiştiriliyor); hepsi farklı marka/model |
| Ağ | Konumlarda yalnız **Wi-Fi**, Ethernet yok |
| Sunucu | Kendi sunucumuz: **sabit IP + alan adı** var |
| Panel kullanıcıları | **Birden fazla kişi** → kullanıcı, rol, yetki gerekli |
| İçerik | Yalnız **resim + video**, **ses var** |
| Çözünürlük | **1080p yeterli** (4K zorunlu değil) |
| Öncelik | **Maliyeti asgari tutmak** (donanım + aylık gider) |

## 3. Temel tasarım ilkeleri

1. **Bağlantıyı TV'ler başlatır.** Sunucuya bağlanan taraf her zaman TV'dir. TV'nin olduğu ağda
   port açma, modem ayarı vb. hiçbir şey gerekmez; internete çıkabilen her Wi-Fi'da çalışır.
   Dışarıya açık tek nokta bizim sunucumuzdur (yalnız HTTPS).
2. **Çevrimdışı öncelikli oynatma.** TV içerikleri kendi hafızasına indirir ve her zaman oradan
   oynatır. İnternet ya da sunucu giderse son listeyi oynamaya devam eder. Video asla internetten
   anlık oynatılmaz; bu, Wi-Fi'ın zayıf olduğu yerlerde de kesintisiz yayın demektir.
3. **İstenen durum (manifest) senkronizasyonu.** Sunucu her TV için "hangi dosyalar, hangi sırayla,
   hangi saatlerde" bilgisini üretir. TV eksikleri indirir, SHA-256 ile doğrular, **hepsi hazır
   olunca** yeni listeye geçer.
4. **Tek oynatıcı yazılımı.** Oynatıcı bir **Android uygulamasıdır**. Android TV'lere doğrudan
   kurulur; eski TV'lere takılan Android TV çubuğuna da **aynı uygulama** kurulur. Bakımı
   yapılacak tek bir oynatıcı vardır.
5. **Kolay kurulum.** Uygulama açılınca ekranda bir eşleştirme kodu gösterir; kod panele girilince
   TV sisteme eklenir.

## 4. Genel bakış

```
   ┌──────────────────────────────┐
   │ Panel kullanıcıları          │  (tarayıcı: evden, ofisten, telefondan)
   └──────────────┬───────────────┘
                  │ HTTPS
                  ▼
   ┌───────────────────────────────────────────────┐
   │   KENDİ SUNUCUNUZ (sabit IP + alan adı)       │
   │ Caddy (HTTPS) · API + WebSocket · Panel       │
   │ PostgreSQL · ffmpeg işleri · Medya diski      │
   └───────────────────────────────────────────────┘
             ▲                ▲                ▲
             │ HTTPS + WSS    │                │   ← bağlantıyı TV'ler
             │ (Wi-Fi, dışa)  │                │     başlatır
   ┌─────────┴─────┐  ┌───────┴───────┐  ┌─────┴─────────┐
   │ Konum A       │  │ Konum B       │  │ Konum C       │
   │ Android TV    │  │ Android TV    │  │ Eski TV       │
   │ + oynatıcı    │  │ + oynatıcı    │  │ + Android     │
   │   uygulaması  │  │   uygulaması  │  │   TV çubuğu   │
   └───────────────┘  └───────────────┘  └───────────────┘
```

## 5. Oynatıcı stratejisi ve donanım

### 5.1 Android TV'ler: ek donanım yok

Oynatıcı uygulaması (APK) doğrudan TV'ye kurulur. **Donanım maliyeti: 0 TL.** TV'nin kendi
donanımsal video çözücüsü kullanılır, ses TV hoparlöründen çıkar.

### 5.2 Akıllı olmayan TV'ler: değiştirmek ya da çubuk takmak

İlk kurulumdaki akıllı olmayan TV, Google TV / Android TV bir modelle **değiştiriliyor**. Bu yüzden
şu an çubuk gerekmiyor; yeni TV alırken §5.3'teki listeye uyulmalı.

Bir TV değiştirilemezse (ya da bir Android TV'de uygulama güvenilir çalışmazsa, §7.4) yedek çözüm,
TV'nin HDMI girişine takılan bir Android TV / Google TV çubuğu ve üzerinde **aynı uygulama**.

| Seçenek | Karar | Neden |
|---|---|---|
| **Google sertifikalı çubuk** (ör. Xiaomi TV Stick 4K 2. nesil) | ✅ **Önerilen** | Türkiye'de yaklaşık **3.600–3.800 TL** (tarihi belirsiz fiyat kayıtları, satın alırken kontrol edilmeli). Adaptör, kumanda ve HDMI uzatma kutudan çıkar; 5 GHz Wi-Fi; aynı APK çalışır |
| Markasız / sertifikasız ucuz Android kutular | ❌ Kaçınılmalı | Bu sınıf cihazlarda fabrikadan gelen zararlı yazılım vakaları var (BadBox 2.0, FBI uyarısı, Haziran 2025). Cihaz kurum ağında 7/24 açık kalacak |
| Yeni Amazon Fire TV çubukları | ❌ Kaçınılmalı | Fire TV Stick 4K Select ve sonrası Android değil **Vega OS** çalıştırıyor; dışarıdan APK kurulamıyor |
| Raspberry Pi Zero 2 W | ❌ Önerilmez | Kart tek başına yaklaşık 700–1.100 TL (KDV dahil), ama adaptör, SD kart, kasa ve adaptör kablosu ayrıca alınır. Asıl maliyet **ikinci bir oynatıcı yazılımı** (Linux) yazıp bakımını yapmak; birkaç TV için sağlanan tasarrufu karşılamaz. Ayrıca 512 MB RAM ve yalnız 2,4 GHz Wi-Fi |

Not: Eski TV'de **HDMI girişi** olmalı. Yalnız SCART/AV varsa HDMI→AV dönüştürücü gerekir ve
görüntü kalitesi düşer.

### 5.3 Yeni TV alırken

- İşletim sistemi **Google TV veya Android TV** olmalı. Tizen (Samsung), webOS (LG), VIDAA ya da
  Vega OS gibi sistemlere uygulamamız kurulamaz.
- Android sürümü mümkün olduğunca yeni olmalı (en az Android 7.0, §7.1).
- En az **2 GB RAM** ve **16 GB depolama** olmalı; videolar TV'nin hafızasına inecek.
- **Çift bant (5 GHz) Wi-Fi** olmalı.
- Mümkünse menüde otomatik kapanma / enerji tasarrufu zamanlayıcısının kapatılabildiği
  doğrulanmalı (§7.3).

### 5.4 Toplam donanım maliyeti

- Android TV'ler: **0 TL** (değiştirilen TV zaten planlanmış bir alım)
- Çubuk: şu an **gerekmiyor**; yedek çözüm olarak TV başına ~3.600–3.800 TL
- Sunucu, alan adı: **mevcut**
- Aylık gider: **0 TL** (yalnız ücretsiz araçlar kullanılır)

## 6. Ağ ve bağlantı

### 6.1 Sunucuya erişim

- DNS'te `tv.alanadiniz.com` → sunucunun sabit IP'si (A kaydı).
- Sunucuda dışarıya **yalnız 443** (HTTPS) ve sertifika yenileme için **80** açık. Caddy,
  Let's Encrypt sertifikasını otomatik alır ve yeniler.
- Sunucu bir modemin arkasındaysa yalnız **sunucunun bulunduğu yerde** 80/443 yönlendirilir.
  TV'lerin bulunduğu ağlarda hiçbir ayar yapılmaz.
- Port açmak istenmezse alternatif: Cloudflare Tunnel (ücretsiz). Bu durumda tek istek boyutu
  ~100 MB ile sınırlıdır. Yükleme zaten 50 MB'lık parçalarla yapıldığı için (§8.2) iki yol da
  çalışır.

| Trafik | Yön | Protokol |
|---|---|---|
| Panel kullanıcısı → sunucu | dışa | HTTPS |
| TV → sunucu (komut, durum) | dışa | WSS (443), kalıcı bağlantı |
| TV → sunucu (dosya indirme) | dışa | HTTPS (443), kaldığı yerden devam (HTTP Range) |
| Bakım (opsiyonel) | Tailscale | Sunucuya SSH, TV/çubuklara adb |

### 6.2 Wi-Fi'a özgü notlar

- WebSocket kopabilir. Uygulama otomatik yeniden bağlanır ve ayrıca 5 dakikada bir manifest
  sürümünü HTTP ile kontrol eder.
- Bazı kurum/misafir Wi-Fi ağları belirli alan adlarını filtreliyor. Tarayıcı bazen bu
  filtreyi atlattığı için "tarayıcıda açılıyor" doğru bir test **değildir**. Uygulamada bir
  **bağlantı testi ekranı** olacak (DNS → TLS → sunucu); kurulumda bununla doğrulanır.
- 5 GHz Wi-Fi tercih edilir.
- **Sunucunun upload hızı** önemli. Her yeni video her TV'ye bir kez iner (ör. 200 MB × 10 TV =
  2 GB). Sunucu indirmeleri sıraya koyar; aynı anda en fazla N TV indirir, kalanlar bekler.

### 6.3 Eski Android'de HTTPS

Android 7.1.1'den eski sürümler Let's Encrypt'in kök sertifikasını (ISRG Root X1) tanımıyor.
Uygulama bu kök sertifikayı kendi içinde taşır (`network_security_config`). Hedef taban
Android 7.0 olduğu için (§7.1) bu yöntem tüm desteklenen cihazlarda çalışır.

## 7. Oynatıcı uygulaması (Android)

### 7.1 Teknoloji

- **Kotlin**, en düşük sürüm **Android 7.0 (API 24)**. Daha eski bir TV çıkarsa önce pilotta
  test edilir, olmazsa o TV'ye çubuk takılır.
- Video: **Media3 / ExoPlayer** (Google'ın resmi oynatıcısı, donanımsal çözme).
- Resim: video katmanının üstünde basit bir görüntü katmanı; süre dolunca geçiş efektiyle sıradakine.
- Ağ: OkHttp (HTTP + WebSocket), kotlinx.serialization.

**Neden native Kotlin** (React Native / Flutter yerine): TV'lerin çoğunda 1–2 GB RAM var ve
native uygulama en hafif seçenek. Açılışta başlama, ekranı açık tutma, cihaz yönetimi gibi kiosk
özellikleri zaten native kod gerektiriyor. Ayrıca Android TV dışındaki ortamlara (iOS, web)
ihtiyacımız yok.

### 7.2 Kiosk davranışı

| İhtiyaç | Çözüm |
|---|---|
| TV açılınca uygulamanın kendiliğinden başlaması | **Pilot bulgusu: TV'ler bunu kendiliğinden yapmıyor.** Kumandayla açmak çoğu zaman yeniden başlatma değil, bekleme modundan uyanmadır; yalnız açılış sinyalini (`BOOT_COMPLETED`) dinlemek yetmez. Üç katmanlı çözüm: **(1)** Uygulama **ana ekran (launcher)** olur; TV hem açılışta hem uyanınca doğrudan uygulamaya gelir. Google TV'de bu yalnız Device Owner moduyla yapılabilir (aşağıda). **(2)** Arka planda çalışan bir servis ekranın açıldığını yakalayıp uygulamayı öne getirir (Android 10+ için "Diğer uygulamaların üzerinde göster" izni gerekir; TV menüsünde yoksa adb ile verilir). **(3)** TV'nin kendi "açılış uygulaması" ayarı varsa (bazı modellerde profesyonel/otel modunda) o da kullanılır |
| Ekranın kararmaması | Uygulama ekranı açık tutar; TV'nin ekran koruyucusu kapatılır |
| Çökme sonrası yeniden başlama | Ön plan servisi + zamanlayıcı ile kontrol |
| Uzaktan güncelleme | Uygulama yeni APK'yı sunucudan indirir. **Device Owner modunda** onaysız kurulur. Device Owner olmayan TV'de kurulum onayı gerekebilir; o durumda Tailscale üzerinden adb ile güncellenir |
| Ekran görüntüsü | Uygulama kendi ekranının görüntüsünü alır (izin istemez); pilotta doğrulanacak |
| Depolama | TV'lerde boş alan az olabilir. Uygulama boş alanı ölçer, bütçe dahilinde indirir, kullanılmayanı siler |

**Device Owner (cihaz sahibi) modu:** Android'in tek amaçlı cihazlar için resmi yöntemi. TV başına
bir kez, aynı Wi-Fi'daki bir bilgisayardan adb ile kurulur.
- **Sağladıkları:** uygulamayı kalıcı ana ekran yapma, onaysız güncelleme, uzaktan yeniden başlatma.
- **Ön koşul:** TV'de hiç hesap olmaması. TV'deki Google hesabı kaldırılır; tabela olarak
  kullanılan TV'de Play Store'a ihtiyaç yok.
- **Bedeli:** TV başka amaçla (yayın izleme, YouTube) kullanılamaz. Yalnız tabela olarak kullanılan
  TV'lere uygundur.

### 7.3 TV'nin kendisi (uygulamanın kontrol edemediği şeyler)

- **Otomatik kapanma:** Birçok TV, kumandaya dokunulmazsa birkaç saat sonra (AB / Energy Star
  enerji kuralları gereği) kendini kapatır. Ayar genelde "Güç ve enerji" menüsünde "Boşta TV
  bekleme", "Otomatik kapanma" ya da "Hareketsizlik zamanlayıcısı" adıyla durur ve kurulumda
  **kapatılmalıdır**.
  - **Pilot bulgusu:** bir TV'de bu ayar menüde yok. Bazı modellerde ayar kilitli ya da yalnız
    profesyonel/otel modunda açılıyor; model bazında araştırılmalı.
  - Uygulama bu zamanlayıcıyı kapatamaz, çünkü bu bir sistem ayarı.
  - Son çare: zamanlayıcıyı birkaç saatte bir kumanda tuşuyla sıfırlayan küçük bir kızılötesi
    (IR) verici ya da TV'nin değiştirilmesi.
- **TV'yi açıp kapatmak:** Normal bir uygulama TV'yi bekleme modundan açamaz. Açılış ve kapanış
  için TV'nin **kendi zamanlayıcısı** kullanılır, ya da TV sürekli açık bırakılır.
- **Açılış kaynağı:** Eski TV'lerde açılışta çubuğun takılı olduğu HDMI girişi seçili olmalı.

### 7.4 Farklı marka/model TV'ler

Hepsi farklı olduğu için:
- Uygulama eşleştirmede TV'nin **modelini, Android sürümünü, boş alanını ve oynatabildiği video
  formatlarını** panele bildirir.
- Her TV için bir **kurulum kontrol listesi** uygulanır (§14).
- Uygulama kendiliğinden başlamıyor ya da TV tarafından kapatılıyor gibi bir sorun aşılamazsa,
  **o TV'ye de çubuk takılır**. Yedek plan budur.

## 8. Sunucu

### 8.1 Bileşenler

- **API + WebSocket:** cihazlar, konumlar, gruplar, medya, listeler, zamanlamalar, komutlar.
- **Medya işleme (iş kuyruğu):** dönüştürme, küçük resim üretme, SHA-256 hesaplama.
- **Manifest üretimi:** atamalar ve zamanlamalardan her TV'nin istenen durumunu hesaplama.
- **Dosya servisi:** kaldığı yerden devam eden indirme; her istekte cihaz yetkisi kontrol edilir.
- **İzleme:** son görülme, oynatılan içerik, senkron durumu, ekran görüntüsü. TV 10 dakikadan
  uzun süre çevrimdışı kalırsa panelde uyarı gösterilir.

### 8.2 Tech stack

| Katman | Seçim | Gerekçe |
|---|---|---|
| Dil | **TypeScript** (Node.js LTS) | Panel de TypeScript; tek dil, hızlı geliştirme |
| API | **Hono** + `@hono/zod-validator` | Hafif; istekler protokol paketindeki Zod şemalarıyla doğrulanır |
| WebSocket | `@hono/node-ws` | TV'lere anlık bildirim ve komut |
| Veritabanı | **PostgreSQL** + Prisma | İlişkisel modelimize uygun, güvenilir |
| İş kuyruğu | **pg-boss** | Kuyruk PostgreSQL üzerinde; ayrı Redis gerekmez |
| Kimlik doğrulama | **Better Auth** | E-posta + parola, iki adımlı doğrulama (TOTP), oturum yönetimi hazır |
| Medya işleme | **ffmpeg / ffprobe** (video), **sharp** (resim) | Dönüştürme, ses normalizasyonu, thumbnail |
| Dosya yükleme | **tus** (`@tus/server` + panelde Uppy) | Büyük videolarda kaldığı yerden devam; 50 MB parçalar |
| Medya depolama | **Sunucu diski** (`/srv/managealltv/media`) | En basit ve ücretsiz. MinIO'nun ücretsiz sürümü 2025'te geliştirmeyi bıraktı; ek depolama sunucusuna gerek yok |
| Panel | **React + Vite**, TanStack Query/Router, Tailwind, shadcn/ui | Hızlı geliştirme, modern arayüz |
| Ters vekil + HTTPS | **Caddy** | Otomatik Let's Encrypt; dosyaları Range desteğiyle sunar, yetki kontrolünü backend'e sorar (`forward_auth`) |
| Dağıtım | **Docker Compose** | Tek komutla kurulum ve güncelleme |
| Yedekleme | Gece `pg_dump` + medya klasörünün başka bir diske/makineye kopyası | Ücretsiz |
| İzleme (opsiyonel) | Uptime Kuma | Sunucu erişilemezse bildirim |
| Bakım erişimi (opsiyonel) | **Tailscale** (ücretsiz plan) | Sunucuya SSH, TV'lere adb; port açmadan |
| Oynatıcı | **Kotlin** + Media3 + OkHttp | §7.1 |

### 8.3 Protokolün paylaşılması

Cihaz ile sunucu arasındaki mesajlar **tek yerde**, `packages/protocol` içinde Zod şemaları
olarak tanımlanır:

- Sunucu ve panel bu şemaları doğrudan kullanır (TypeScript).
- Android tarafındaki Kotlin veri sınıfları elle yazılır; uyumu **ortak test örnekleri** güvenceye
  alır: `packages/protocol/fixtures/*.json` hem Zod şemalarıyla (TypeScript testleri) hem de Kotlin
  modelleriyle katı modda (bilinmeyen alan yok sayılmadan) çözülüp yeniden kodlanır. Bir alan adı ya da
  biçim kayarsa iki taraftan birinin testi kırılır.
- Zamanlama kuralları da aynı yöntemle korunur: `schedule-cases.json` içindeki test vakalarını hem
  TypeScript hem Kotlin uygulaması çalıştırır.

### 8.4 Repo yapısı

```
managealltv/
├── apps/
│   ├── server/           # Hono API + WebSocket + medya işleri (TypeScript)
│   ├── web/              # Yönetim paneli (React + Vite)
│   └── player-android/   # Oynatıcı uygulaması (Kotlin, Gradle)
├── packages/
│   └── protocol/         # Zod şemaları + ortak test örnekleri (fixtures)
├── deploy/               # docker-compose.yml, Caddyfile, yedekleme script'leri
└── docs/
```

TypeScript tarafı pnpm workspaces ile yönetilir. Android projesi kendi Gradle yapısıyla
`apps/player-android` altında durur.

## 9. Rust sorusu: Rust ile daha az kaynak harcar mıyız?

**Bu sistemde Rust'ın pratik bir kazancı yok.**

- **Oynatıcı tarafı:** Oynatıcı artık Android uygulaması. Asıl iş olan video çözmeyi TV'nin
  donanımsal çözücüsü yapıyor. Uygulamanın kendi kodu, Android'in ve oynatıcının yanında çok
  küçük kalıyor. Rust'ı Android'e taşımak (JNI/NDK) karmaşıklık ekler, kaynak tasarrufu sağlamaz.
- **Sunucu tarafı:** 10 TV için sunucu yükü ihmal edilebilir düzeyde. Burada önemli olan
  geliştirme hızı ve hazır bileşenler (kimlik doğrulama, 2FA, kuyruk, yükleme). Bunlar
  TypeScript ekosisteminde daha olgun.
- **Rust nerede anlamlı olurdu:** Pi Zero 2 W gibi 512 MB RAM'li bir Linux cihaza kendi ajanımızı
  yazsaydık. Orada bellek kullanımı Rust'ta birkaç MB, Node.js'te onlarca MB olurdu ve bu fark
  hissedilirdi. Pi yerine Android çubuk seçtiğimiz için bu senaryo ortadan kalktı.

## 10. Medya işleme

### 10.1 Video

Hedef format, her Android TV ve çubuğun donanımla rahat oynatabildiği ortak profil:

| Ayar | Değer |
|---|---|
| Codec | H.264 High profile, level 4.1, 8-bit `yuv420p` |
| Çözünürlük | En fazla 1920×1080 (büyük olan küçültülür, küçük olan büyütülmez) |
| Kare hızı | En fazla 30 fps |
| Bit hızı | CRF ~22, üst sınır ~8 Mbit/s |
| Anahtar kare | 2 saniyede bir |
| Ses | AAC-LC, 48 kHz, stereo, **ses yüksekliği normalizasyonu** (EBU R128 `loudnorm`). Böylece tüm videolar aynı ses seviyesinde çalar |
| Kapsayıcı | MP4 + `faststart` |

- Video zaten uyumluysa **yeniden kodlanmaz**. Görüntü olduğu gibi kopyalanır, yalnız ses
  normalize edilir. Bu hızlıdır ve kalite kaybı olmaz.
- Uyumsuzsa tam dönüştürme yapılır (`libx264 -preset faster`). GPU gerekmez.

### 10.2 Resim

EXIF'e göre döndürme, 1920×1080'e sığdırma (büyütmeden), JPEG kalite ~85, meta veriler (GPS vb.)
silinir. Panel için küçük resimler üretilir.

## 11. Ana akışlar

### 11.1 Yeni TV ekleme (eşleştirme)

```
1. Uygulama ilk açılış: kayıtlı kimlik yok
2. Uygulama → Sunucu : eşleştirme isteği + cihaz bilgisi (model, Android sürümü, boş alan, codec'ler)
3. Sunucu → Uygulama : { pairingCode: "482-913" }
4. Kod TV ekranında büyük harflerle gösterilir
5. Yetkili kullanıcı panelde "TV ekle" → kod + TV adı + konum
6. Sunucu cihazı kaydeder, uzun ömürlü cihaz anahtarı (token) üretir
7. Uygulama anahtarı alır, saklar, normal çalışmaya geçer
```

Anahtar panelden iptal edilebilir. Sunucuda yalnız anahtarın hash'i saklanır.

### 11.2 İçerik yükleme ve yayınlama

1. Kullanıcı dosyayı panele sürükler. Parçalı yükleme kesilirse kaldığı yerden devam eder.
2. Sunucu ffmpeg/sharp ile işler, SHA-256 hesaplar → medya "hazır".
3. Kullanıcı medyayı listeye ekler, listeyi TV'ye / gruba / konuma atar ve **Yayınla** der.
4. Sunucu etkilenen TV'lerin manifestini günceller, çevrimiçi olanlara WebSocket ile bildirir.
   Çevrimdışı olanlar bağlandıklarında alır.

### 11.3 Senkronizasyon (TV tarafı)

1. Yeni manifesti al.
2. Eksik dosyaları geçici klasöre indir (kaldığı yerden devam), SHA-256 ile doğrula.
3. **Bütün dosyalar hazır olunca** listeyi değiştir.
4. Kullanılmayan dosyaları sil.
5. Durumu bildir → panelde "güncel / indiriliyor %63 / hata".

Örnek manifest:

```json
{
  "version": 42,
  "defaultPlaylist": "pl_lobi",
  "playlists": {
    "pl_lobi": [
      { "media": "m_1", "type": "video", "sha256": "…", "size": 48211933 },
      { "media": "m_2", "type": "image", "sha256": "…", "size": 812044, "durationSec": 10 }
    ],
    "pl_aksam": [ … ]
  },
  "schedule": [
    { "playlist": "pl_aksam", "days": ["mon","tue","wed","thu","fri"], "from": "18:00", "to": "23:00", "priority": 10 }
  ],
  "volume": 70
}
```

Zamanlama TV'nin kendisinde değerlendirilir. Bu sayede internet yokken de doğru saatte doğru
liste oynar.

### 11.4 Uzaktan komutlar

Sunucu → TV: `{ id, type, params }`, TV → sunucu: `{ id, ok, result }`.

Komutlar: `reload` (manifesti yeniden çek), `restart_app`, `screenshot`, `set_volume`,
`identify` (ekranda TV adını göster), `reboot` (yalnız Device Owner modunda), `update_app`.

## 12. Kullanıcılar ve yetkiler

### 12.1 Roller

| İşlem | Yönetici | Editör | İzleyici |
|---|:---:|:---:|:---:|
| Kullanıcı ekleme / rol verme | ✅ | – | – |
| TV eşleştirme, silme, konum/grup düzenleme | ✅ | – | – |
| Medya yükleme | ✅ | ✅ | – |
| Medya silme | ✅ | kendi yüklediği | – |
| Liste oluşturma / düzenleme | ✅ | ✅ | – |
| Yayınlama, atama, zamanlama | ✅ | ✅ (yetkili konumlarında) | – |
| Komutlar (yeniden başlat, ses, ekran görüntüsü) | ✅ | ✅ (yetkili konumlarında) | – |
| Durum ve ekran görüntülerini görme | ✅ | ✅ | ✅ |
| İşlem kaydını (audit log) görme | ✅ | – | – |

- **Konum kısıtı:** Editör ve İzleyici belirli konumlarla sınırlanabilir; Yönetici her şeyi görür.
- **İleride (opsiyonel):** Editörün yayını Yönetici onayıyla canlıya çıkar.

### 12.2 Kimlik doğrulama

- E-posta + parola (Better Auth'un varsayılanı scrypt ile hash), oturum HttpOnly + Secure çerezde.
- **İki adımlı doğrulama (TOTP)**, Yönetici için zorunlu.
- **E-posta sunucusu gerekmez:** Yönetici kullanıcıyı ekler, sistem tek kullanımlık bir **davet
  bağlantısı** üretir, Yönetici bunu iletir. Parola sıfırlama da aynı yöntemle yapılır.
- Giriş denemelerinde hız sınırı; durum değiştiren isteklerde CSRF koruması.
- **Cihaz anahtarları kullanıcı oturumlarından tamamen ayrıdır.** Bir cihaz anahtarı yalnız o
  cihazın manifestine ve dosyalarına erişebilir.

### 12.3 İşlem kaydı

Her değişiklik kaydedilir: kim, ne zaman, hangi işlem, hangi kayıt, önceki/sonraki değer, IP.

## 13. Veri modeli (taslak)

```
User          (id, name, email, password_hash, role[admin|editor|viewer], totp, status)
UserLocation  (user_id, location_id)              ← konum kısıtı
Invite        (id, email, role, token_hash, expires_at, used_at)
Location      (id, name, address, timezone)
Device        (id, name, location_id, status, last_seen_at, token_hash,
               model, android_version, app_version, free_storage, codecs,
               resolution, manifest_version, volume)
DeviceGroup   (id, name)                          ── çoka-çok ── Device
Media         (id, type[image|video], original_name, file_path, duration,
               width, height, sha256, size, thumbnail, status, uploaded_by)
Playlist      (id, name, created_by)
PlaylistItem  (id, playlist_id, media_id, position, duration_sec)
Schedule      (id, playlist_id, target_type[device|group|location], target_id,
               days, start_time, end_time, start_date, end_date, priority)
Command       (id, device_id, type, params, status, created_by, created_at, result)
AuditLog      (id, user_id, action, entity, entity_id, before, after, ip, created_at)
```

Zamanlama kuralı: o anda geçerli zamanlamalardan **en yüksek öncelikli** olanın listesi oynar;
hiçbiri geçerli değilse varsayılan liste oynar.

## 14. TV kurulum kontrol listesi

Her TV için bir kez yapılır:

1. TV'nin modelini ve Android sürümünü not et (Ayarlar → Hakkında).
2. "Bilinmeyen kaynaklardan yükleme" iznini aç, APK'yı kur.
3. Android 10+ ise "Diğer uygulamaların üzerinde göster" iznini ver (menüde yoksa adb ile).
4. **Otomatik kapanma / enerji tasarrufu zamanlayıcısını kapat**, ekran koruyucuyu kapat.
5. Gerekirse TV'nin kendi açılma/kapanma zamanlayıcısını ayarla.
6. Eski TV + çubuk: TV'nin açılış kaynağını çubuğun takılı olduğu HDMI'a ayarla.
7. Uygulamanın **bağlantı testi** ekranını çalıştır (tarayıcıyla test etme).
8. Eşleştirme kodunu panele gir; test videosunun sesli oynadığını doğrula.
9. **Fişi çekip tak:** Uygulama kendiliğinden açılıyor ve oynatmaya devam ediyor mu?
10. Sonuçları panelde TV kaydına not düş.

## 15. Güvenlik

- Dışarıya açık yalnız 80/443; veritabanı ve iç servisler dışarıya kapalı.
- Sunucuda otomatik güvenlik güncellemeleri. SSH yalnız anahtarla, tercihen yalnız Tailscale
  üzerinden.
- Giriş ve eşleştirme uçlarında hız sınırı (kaba kuvvet denemelerine karşı).
- Dosya indirme her istekte cihaz/kullanıcı yetkisiyle kontrol edilir.
- Çubuklar Google sertifikalı modellerden seçilir (§5.2).

## 16. Dayanıklılık

- **Sunucu giderse:** TV'ler önbellekten oynamaya devam eder; yalnız yeni içerik dağıtılamaz.
- **Elektrik kesintisi:** TV açılınca uygulama kendiliğinden başlar ve önbellekten oynatır.
- **Saat:** Zamanlamalar TV saatine dayanır; Android saati internetten senkronlar. Saat
  bilinmiyorsa varsayılan liste oynar.
- **Disk dolması:** İndirmeden önce boş alan kontrolü, kullanılmayan dosyaların silinmesi.
- **Yedek:** Her gece veritabanı + medya, sunucu dışında bir yere.

## 17. Yol haritası

**Faz 0 — Pilot (önce bu)**
- Minimal bir test APK'sı: açılışta kendiliğinden başlar, sesli test videosu döndürür, cihaz
  bilgisini gösterir.
- [Kurulum envanterindeki](kurulum-envanteri.md) TV'lerde denenir. Kendiliğinden başlama,
  otomatik kapanma, oynatma ve güncelleme davranışı envanter tablosuna yazılır.
- Sonuç: en düşük Android sürümü kararı ve hangi TV'nin çubuğa ihtiyacı olduğu.

**Faz 1 — MVP**
- Sunucu + panel: giriş, kullanıcılar ve roller, medya yükleme, oynatma listesi, TV'ye atama.
- Uygulama: eşleştirme, manifest senkronu, çevrimdışı oynatma, heartbeat, bağlantı testi ekranı.
- Panelde TV'lerin çevrimiçi/çevrimdışı durumu.

**Faz 2 — Filo yönetimi**
- Konumlar, gruplar, zamanlama.
- Video dönüştürme + ses normalizasyonu, thumbnail.
- Uzaktan komutlar, ekran görüntüsü, uzaktan uygulama güncellemesi.
- 2FA, işlem kaydı, konum bazlı yetki.

**Faz 3 — Gelişmiş**
- Acil duyuru (tüm TV'lerde öncelikli içerik).
- Oynatma raporları (hangi içerik nerede, ne zaman oynadı).
- Yayın onay akışı.

## 18. Riskler

| Risk | Önlem |
|---|---|
| TV'ler uygulamayı açılışta kendiliğinden başlatmıyor (**pilotta doğrulandı**) | Uygulamanın ana ekran olması (Device Owner) + ekran açılınca öne gelme; aşılamazsa o TV'ye çubuk |
| Bir TV'nin otomatik kapanması menüden kapatılamıyor (**pilotta görüldü**) | Model bazında profesyonel/otel modu araştırması; son çare IR verici ya da TV değişimi (§7.3) |
| TV'lerde onaysız uygulama güncellemesi mümkün olmayabilir | Device Owner; olmayan TV'de Tailscale + adb ya da yerinde onay |
| Sunucunun upload hızı yetersiz | İndirme sırası, kaldığı yerden devam, makul video bit hızı |
| Konumdaki Wi-Fi alan adı filtreliyor | Uygulamadaki bağlantı testi; gerekirse ağ yöneticisinden izin |
| TV'de depolama az | Boş alan ölçümü ve önbellek bütçesi |
| Tek sunucu | TV'ler çevrimdışı çalışmaya devam eder; düzenli yedek |

## 19. Kaynaklar

- Xiaomi TV Stick 4K Türkiye fiyatları: [Cimri](https://www.cimri.com/medya-oynatici-player/en-ucuz-xiaomi-4k-tv-stick-medya-oynatici-fiyatlari,1678862953), [MediaMarkt](https://www.mediamarkt.com.tr/tr/product/_xiaomi-mi-tv-stick-4k-2gen-media-oynatici-1255133.html)
- Raspberry Pi Zero 2 W Türkiye fiyatları: [Samm Market](https://market.samm.com/raspberry-pi-zero-2-w-en), [Direnç.net](https://www.direnc.net/raspberry-pi-zero-2-w)
- Fire TV ve Vega OS (dışarıdan APK kurulamıyor): [AFTVnews](https://www.aftvnews.com/tag/sideload/), [Android Authority](https://www.androidauthority.com/fire-tv-stick-hd-sideloading-warning-3658819/)
- BadBox 2.0 / FBI uyarısı: [BleepingComputer](https://www.bleepingcomputer.com/news/security/fbi-badbox-20-android-malware-infects-millions-of-consumer-devices/), [TechRadar](https://www.techradar.com/pro/security/fbi-warns-dangerous-badbox-2-0-malware-has-hit-over-a-million-devices-heres-how-to-stay-safe)
- MinIO topluluk sürümünün durumu: [Linuxiac](https://linuxiac.com/minio-ends-active-development/), [ayedo](https://ayedo.de/en/posts/minio-im-maintenance-mode/)
- Media3 sürüm notları: [Android Developers](https://developer.android.com/jetpack/androidx/releases/media3)
