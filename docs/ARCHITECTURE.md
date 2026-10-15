# ManageAllTV — Sistem Mimarisi (Taslak v0.1)

> **Durum:** Tartışma taslağı. Mimari ilkeler öneridir; tech stack henüz kesinleşmedi (bkz. §12 ve §13).

## 1. Amaç

Farklı konumlardaki televizyonlara bağlı küçük oynatıcı cihazları (ör. Raspberry Pi) **tek bir merkezden** yönetmek:

- Bilgisayardan (veya telefondan) resim ve video yüklemek,
- Bu içerikleri oynatma listelerine koyup istenen TV'lere / TV gruplarına atamak,
- TV'lerin durumunu (çevrimiçi mi, şu an ne oynatıyor) görmek ve uzaktan komut göndermek,
- Cihazlar ve yönetici **aynı ağda ya da tamamen farklı ağlarda** olsa da sistemin çalışması (ör. evden yönetim).

Benzer hazır çözümler mevcut (Xibo, piSignage, Anthias; ücretli olarak Yodeck, Screenly). Bunları ilham kaynağı olarak inceleyebiliriz. Kendi sistemimizi yazmanın kazancı: tam kontrol, sade ve ihtiyaca özel bir arayüz, ekran başına lisans ücreti olmaması.

## 2. Temel tasarım ilkeleri

### 2.1 Merkezi sunucu, sunucuya kendisi bağlanan cihazlar

En kritik karar: **Bilgisayar TV'lere doğrudan bağlanmaz.** Bunun yerine:

- İnternetten erişilebilen tek bir **merkezi sunucu** vardır.
- Her oynatıcı cihaz açıldığında bu sunucuya **kendisi dışarıya doğru** bağlanır (HTTPS/WSS, port 443).
- Yönetici de aynı sunucudaki web paneline girer.

Sonuç: Cihazların bulunduğu ağlarda modem ayarı, port yönlendirme, sabit IP, DDNS vb. **hiçbir şey gerekmez.** CGNAT arkasındaki ev interneti, kurumsal ağ, mobil hotspot, 4G modem: internete çıkabilen her ağda çalışır. "Aynı ağ / farklı ağ" ayrımı ortadan kalkar.

### 2.2 Çevrimdışı öncelikli oynatma (offline-first)

Cihaz içerikleri **yerel diske indirir ve her zaman yerelden oynatır.** İnternet kesilirse son bilinen oynatma listesini oynamaya devam eder; bağlantı geri gelince kendini senkronize eder. Video hiçbir zaman internetten anlık (stream) oynatılmaz.

### 2.3 "İstenen durum" senkronizasyonu

Sunucu her cihaz için bir **manifest** (istenen durum) üretir: hangi dosyalar, hangi sırayla, hangi saatlerde oynatılacak. Cihaz kendi yerel durumunu bu manifestle karşılaştırır, eksikleri indirir, doğrular, sonra yeni listeye **tek seferde (atomik olarak)** geçer. Kaçırılan bildirim, yarım kalan indirme gibi sorunlar bu sayede kendiliğinden düzelir.

### 2.4 Sıfır dokunuşla kurulum

Yeni cihaz: SD kartı yaz → TV'ye tak → ekranda çıkan **eşleştirme kodunu** panele gir. Cihaz başına SSH ile tek tek ayar yapmak gerekmez.

### 2.5 Ayrı bir bakım kanalı

İçerik yönetimi merkezi sunucu üzerinden yürür. Sorun gidermek için cihazlara SSH ile erişebilmek adına cihazlar ayrıca **Tailscale** (WireGuard tabanlı özel ağ) ile bağlanır. Bu da port açmadan çalışır.

## 3. Genel bakış

```
   ┌────────────────────┐
   │ Sen: tarayıcı      │  (evden, ofisten, telefondan)
   └─────────┬──────────┘
             │ HTTPS
             ▼
   ┌───────────────────────────────────────────────┐
   │          MERKEZİ SUNUCU (bulut VPS)           │
   │ Yönetim paneli · API · WebSocket              │
   │ Medya işleme (ffmpeg) · Depolama · PostgreSQL │
   └───────────────────────────────────────────────┘
             ▲                ▲                ▲
             │ WSS + HTTPS    │                │   ← bağlantıyı cihazlar
             │ (dışa doğru)   │                │     başlatır; port açma yok
   ┌─────────┴─────┐  ┌───────┴───────┐  ┌─────┴─────────┐
   │ Konum A       │  │ Konum B       │  │ Konum C       │
   │ (ev Wi-Fi)    │  │ (4G modem)    │  │ (kurum ağı)   │
   │ Pi + ajan+mpv │  │ Pi + ajan+mpv │  │ Pi + ajan+mpv │
   │     │ HDMI    │  │     │ HDMI    │  │     │ HDMI    │
   │   [ TV ]      │  │   [ TV ]      │  │   [ TV ]      │
   └───────────────┘  └───────────────┘  └───────────────┘
```

## 4. Bileşenler

### 4.1 Merkezi sunucu

- **API:** cihazlar, konumlar, gruplar, medya, oynatma listeleri, zamanlamalar.
- **WebSocket geçidi:** cihazlarla kalıcı bağlantı; anlık bildirim ve komut iletimi.
- **Medya işleme:** yüklenen videoyu cihazlarda sorunsuz oynayacak standart formata dönüştürme (ffmpeg), küçük resim (thumbnail) üretme, süre/çözünürlük/SHA-256 sağlama toplamı çıkarma.
- **Medya depolama:** orijinal ve dönüştürülmüş dosyalar.
- **Manifest üretimi:** her cihaz için atamalar ve zamanlamalardan istenen durumu hesaplama.
- **İzleme:** son görülme zamanı, oynatılan içerik, disk doluluğu, sıcaklık, ekran görüntüsü.

### 4.2 Yönetim paneli (web)

Tarayıcıdan çalışır; ayrı uygulama kurmaya gerek yok, telefondan da kullanılabilir.

- Medya kütüphanesi: sürükle-bırak yükleme, büyük dosyalarda kaldığı yerden devam
- Oynatma listesi düzenleyici: sıralama, resimlerin ekranda kalma süresi
- Cihaz listesi: çevrimiçi durumu, şu an ne oynuyor, son ekran görüntüsü
- Atama: liste → cihaz / grup / konum
- Zamanlama: gün ve saat aralıkları, öncelik
- Komutlar: yeniden başlat, içeriği yenile, ekran görüntüsü al, TV'yi aç/kapat, ses

### 4.3 Oynatıcı cihaz

Her TV'nin arkasında bir cihaz, üzerinde iki yazılım parçası:

1. **Ajan (agent):** arka planda çalışan servis.
   - Sunucuya bağlanır, kimliğini doğrular, düzenli "hayattayım" (heartbeat) mesajı gönderir.
   - Manifesti alır, dosyaları indirir, SHA-256 ile doğrular, artık kullanılmayanları siler.
   - Zamanlamayı **cihazın kendisinde** değerlendirir; internet yokken de doğru saatte doğru liste oynar.
   - Oynatıcıyı kontrol eder, komutları uygular, ekran görüntüsü gönderir.
2. **Oynatıcı (renderer): mpv.**
   - Masaüstü ortamı olmadan doğrudan ekrana (DRM/KMS) çizer; hafif ve kararlıdır.
   - Hem video hem resim oynatır, donanımsal video çözme kullanır.
   - JSON IPC soketi üzerinden ajan tarafından yönetilir.

İleride web sayfası, hava durumu, çoklu bölgeli ekran düzeni (ör. solda video, sağda duyuru) istenirse ikinci bir oynatıcı modu olarak Chromium kiosk eklenebilir. MVP için mpv yeterli ve çok daha kararlı.

Ajan ve oynatıcı systemd servisi olarak açılışta otomatik başlar, çökerse yeniden başlatılır. Donanım watchdog'u cihaz tamamen kilitlenirse cihazı yeniden başlatır.

## 5. Ağ ve bağlantı

| Trafik | Yön | Protokol | Not |
|---|---|---|---|
| Yönetici → Panel | dışa | HTTPS | Her yerden erişim |
| Cihaz → Sunucu (kontrol) | dışa | WSS (443) | Kalıcı bağlantı, otomatik yeniden bağlanma |
| Cihaz → Depolama (indirme) | dışa | HTTPS (443) | Kaldığı yerden devam (HTTP Range) |
| Bakım (SSH) | Tailscale | WireGuard | Port açmadan |

- WebSocket kopsa bile cihaz periyodik olarak (ör. 5 dakikada bir) manifest sürümünü HTTP ile de sorar; yedek mekanizma.
- Her şey 443 portundan geçtiği için kurumsal güvenlik duvarlarından da genellikle sorunsuz geçer.
- İnternet olmayan konumlar için USB 4G modem veya mobil hotspot yeterlidir.
- Konumun Wi-Fi bilgisi önceden bilinmiyorsa: ağ bulamayan cihaz kendi Wi-Fi erişim noktasını açar ("ManageAllTV-Kurulum"), telefondan bağlanıp yerel Wi-Fi şifresi girilir. Mümkün olan yerde kablolu Ethernet tercih edilmeli.

**Sunucu nerede olmalı?** Önerimiz küçük bir bulut VPS. Sunucu evde de barındırılabilir (ev bilgisayarı veya bir Pi + Cloudflare Tunnel / Tailscale), ancak ev interneti veya elektrik kesildiğinde hiçbir TV güncellenemez ve panele erişilemez. Cihazlar önbellekten oynamaya devam ettiği için bu ölümcül değil, ama VPS daha güvenilir.

## 6. Ana akışlar

### 6.1 Yeni cihaz ekleme (eşleştirme)

```
1. Cihaz ilk kez açılır; kayıtlı kimlik (token) yok
2. Cihaz → Sunucu : eşleştirme isteği (donanım bilgisi)
3. Sunucu → Cihaz : { pairingCode: "482-913" }
4. Cihaz kodu TV ekranında büyük harflerle gösterir
5. Yönetici panelde "Cihaz ekle" → kodu, cihaz adını ve konumu girer
6. Sunucu cihazı kaydeder, uzun ömürlü bir cihaz token'ı üretir
7. Cihaz token'ı alır, diske kaydeder ve normal çalışmaya geçer
```

Token panelden iptal edilebilir (cihaz çalınırsa, el değiştirirse vb.).

### 6.2 İçerik yükleme ve yayınlama

1. Yönetici dosyayı panele sürükler; yükleme kesilirse kaldığı yerden devam eder.
2. Sunucu ffmpeg ile dosyayı analiz eder, dönüştürür, thumbnail üretir → medya "hazır".
3. Yönetici medyayı bir listeye ekler, listeyi cihaza/gruba atar, "Yayınla" der.
4. Sunucu etkilenen cihazların manifestini yeniden hesaplar ve sürüm numarasını artırır.
5. Çevrimiçi cihazlara WebSocket üzerinden `manifest_updated` bildirimi gider. Çevrimdışı olanlar bağlandıklarında güncellemeyi alır.

### 6.3 Senkronizasyon (cihaz tarafı)

1. Yeni manifesti al.
2. Yerel önbellekte olmayan dosyaları geçici klasöre indir, SHA-256 ile doğrula.
3. **Bütün dosyalar hazır olunca** oynatma listesini değiştir; yarım liste asla oynatılmaz.
4. Hiçbir geçerli manifestte yer almayan dosyaları sil (disk dolmasın).
5. Senkron durumunu sunucuya bildir → panelde "güncel / indiriliyor %63 / hata".

Örnek manifest:

```json
{
  "version": 42,
  "defaultPlaylist": "pl_lobby",
  "playlists": {
    "pl_lobby": [
      { "media": "m_1", "type": "video", "sha256": "…", "size": 48211933 },
      { "media": "m_2", "type": "image", "sha256": "…", "size": 812044, "durationSec": 10 }
    ],
    "pl_aksam": [ … ]
  },
  "schedule": [
    { "playlist": "pl_aksam", "days": ["mon","tue","wed","thu","fri"], "from": "18:00", "to": "23:00", "priority": 10 }
  ],
  "tvPower": { "on": "08:30", "off": "23:30" }
}
```

### 6.4 Uzaktan komutlar

Sunucu → cihaz: `{ id, type, params }` · Cihaz → sunucu: `{ id, ok, result }`

Örnek komut tipleri: `reboot`, `restart_player`, `screenshot`, `tv_power` (HDMI-CEC ile TV aç/kapat), `set_volume`, `identify` (ekranda cihazın adını göster).

## 7. Veri modeli (taslak)

```
Location     (id, name, address, timezone)
Device       (id, name, location_id, status, last_seen_at, agent_version,
              resolution, orientation, token_hash, manifest_version)
DeviceGroup  (id, name)                 ── çoka-çok ── Device
Media        (id, type[image|video], original_path, variants, duration,
              width, height, sha256, size, thumbnail, status)
Playlist     (id, name)
PlaylistItem (id, playlist_id, media_id, position, duration_sec)
Schedule     (id, playlist_id, target_type[device|group|location], target_id,
              days, start_time, end_time, start_date, end_date, priority)
Command      (id, device_id, type, params, status, created_at, result)
User         (id, email, password_hash, role)
```

Zamanlama kuralı: bir cihaz için o anda geçerli zamanlamalar arasından **en yüksek öncelikli** olanın listesi oynar; hiçbiri geçerli değilse cihazın varsayılan listesi oynar. "Acil duyuru" en yüksek öncelikli, geçici bir zamanlama olarak modellenebilir.

## 8. Güvenlik

- Tüm trafik TLS ile şifreli (HTTPS/WSS).
- Cihaz kimliği: eşleştirmede verilen token; sunucuda yalnızca hash'i saklanır, panelden iptal edilebilir.
- Medya indirme linkleri kısa ömürlü imzalı URL'ler.
- Panel: güçlü parola (argon2 ile hash), oturum yönetimi; ileride 2FA ve roller (yönetici / içerik editörü).
- Cihazlar: varsayılan kullanıcı/parola yok, parola ile SSH kapalı, erişim yalnızca Tailscale üzerinden anahtar ile.
- Cihaza fiziksel erişimi olan biri token'ı ele geçirebilir; bu yüzden token yalnızca o cihazın kendi manifestine erişim verir ve iptal edilebilir.

## 9. Donanım

| Seçenek | Artı | Eksi |
|---|---|---|
| **Raspberry Pi 4 (2–4 GB)** | Uygun fiyatlı, yaygın; H.264 1080p ve HEVC 4K donanımsal çözme | 4K H.264 oynatamaz |
| **Raspberry Pi 5 (2–4 GB)** | Daha hızlı işlemci; HEVC 4K donanımsal çözme | **H.264 donanım çözücüsü yok** (1080p yazılımla oynar), daha fazla güç ve ısı |
| Intel N100 sınıfı mini PC | Çok güçlü, x86, her codec'te 4K, Chromium rahat çalışır | Daha pahalı ve büyük |
| Android TV kutusu / Fire TV | Ucuz, iyi video çözme | Ayrı Android uygulaması gerekir, sistem kontrolü kısıtlı |

**Öneri:** Raspberry Pi 4 veya 5 (2 GB+). Ajan genel bir Linux uygulaması olacağı için aynı yazılım mini PC'lerde de çalışır. İhtiyaç olursa Android oynatıcı ileride ayrı bir istemci olarak eklenebilir.

**Video formatı:** Pi 4 ve Pi 5'in donanım çözücüleri farklı olduğundan sunucu her videoyu ikisinin de donanımsal çözebildiği ortak bir formata dönüştürmeli. Aday: H.265/HEVC, ekrana göre 1080p veya 4K. Kullanıcı hangi formatta yüklerse yüklesin cihazlarda sorunsuz oynar. Kesin profil gerçek cihazlarda test edilerek belirlenecek. Not: HEVC'ye dönüştürme küçük bir VPS'te yavaş olabilir; içerik önceden hazırlandığı için bu bekleme kabul edilebilir.

Cihaz başına ek malzeme:

- Resmî güç adaptörü (yetersiz güç = rastgele donma ve SD kart bozulması)
- Yüksek dayanıklı (High Endurance) microSD veya USB SSD
- Soğutmalı kasa
- micro-HDMI → HDMI kablo
- Mümkünse Ethernet kablosu

## 10. Dayanıklılık: dikkat edilecekler

- **Elektrik kesintisi / SD kart bozulması:** TV'ler sık sık fişten çekilir. Sistem bölümü **salt-okunur** (overlay filesystem) yapılır; yazılabilen tek alan medya önbelleği ve ajan ayarlarıdır.
- **Saat:** Pi'lerde pil takılı değilse kapalıyken saati tutan bir saat yok. Zamanlamalar doğru saate dayandığı için açılışta NTP senkronizasyonu beklenir; saat bilinmiyorsa varsayılan liste oynatılır.
- **Çökme / donma:** systemd otomatik yeniden başlatma + donanım watchdog.
- **Disk dolması:** indirme öncesi boş alan kontrolü, kullanılmayan dosyaların silinmesi.
- **TV kapanması / kaynak değişmesi:** HDMI-CEC ile TV'yi açma ve "aktif kaynak" olma.
- **Ajan güncellemesi (OTA):** ajan yeni sürümü sunucudan indirip kendini günceller; yeni sürüm başlamazsa eski sürüme döner.
- **Ekranın kararması:** ekran koruyucu ve güç yönetimi kapatılır; TV'yi kapatma zamanlaması panelden yönetilir.

## 11. Yol haritası

**Faz 1: MVP**

- Sunucu + panel: giriş, medya yükleme (resim/video), oynatma listesi, cihaza atama
- Cihaz: eşleştirme, manifest senkronu, çevrimdışı oynatma (mpv), heartbeat
- Panelde çevrimiçi/çevrimdışı durumu

**Faz 2: Filo yönetimi**

- Konumlar / gruplar, zamanlama (gün/saat)
- Video dönüştürme ve thumbnail
- Uzaktan komutlar (yeniden başlat, ekran görüntüsü, CEC ile TV aç/kapat)
- Hazır cihaz imajı (SD kartı yaz → tak → çalışsın), ajan OTA güncelleme

**Faz 3: Gelişmiş**

- Çoklu bölgeli ekran düzenleri, web sayfası/URL içerik (Chromium modu)
- Acil duyuru, oynatma raporları (hangi içerik ne zaman, nerede oynadı)
- Çok kullanıcılı roller, işlem kaydı

## 12. Tech stack önerisi (taslak, sonraki adımda kesinleşecek)

| Katman | Öneri | Gerekçe |
|---|---|---|
| Dil | **TypeScript** (her yerde) | Sunucu, panel ve cihaz ajanı aynı dil; mesaj protokolünün tipleri tek pakette paylaşılır |
| Monorepo | pnpm workspaces | `apps/server`, `apps/web`, `apps/agent`, `packages/protocol` |
| Backend | Node.js + Fastify + WebSocket | Hafif, hızlı, WebSocket desteği iyi |
| Mesaj doğrulama | Zod | Protokol mesajları hem sunucuda hem cihazda aynı şemayla doğrulanır |
| Veritabanı | PostgreSQL + Drizzle ORM | Güvenilir; ilişkisel veri modelimize uygun |
| İş kuyruğu | pg-boss (PostgreSQL üzerinde) | ffmpeg işleri için ayrı Redis gerekmez |
| Medya işleme | ffmpeg / ffprobe | Dönüştürme, thumbnail, metadata |
| Medya depolama | Başta sunucu diski → büyüyünce S3 uyumlu depolama (ör. Cloudflare R2) | R2'de indirme (çıkış) trafiği ücretsiz; çok sayıda TV'ye video dağıtırken önemli |
| Dosya yükleme | tus protokolü (Uppy) | Büyük videolarda kaldığı yerden devam |
| Panel | React + Vite + TanStack Query + Tailwind + shadcn/ui | Hızlı geliştirme, modern arayüz |
| Sunucu dağıtımı | Docker Compose + Caddy (otomatik HTTPS), küçük bir VPS | Tek komutla kurulum, düşük maliyet |
| Cihaz işletim sistemi | Raspberry Pi OS Lite (64-bit) | Masaüstü yok, resmî destek |
| Oynatıcı | mpv (DRM/KMS + donanımsal çözme), JSON IPC | Hafif, kararlı, resim + video |
| Ajan | Node.js (TypeScript), systemd servisi | Ortak protokol paketini kullanır |
| TV kontrolü | HDMI-CEC (`cec-ctl`) | TV aç/kapat, aktif kaynak |
| Bakım erişimi | Tailscale | Port açmadan SSH |
| Cihaz imajı | pi-gen ile özel imaj (Faz 2) | Tak-çalıştır kurulum |

Alternatifler: Python (FastAPI) sunucu + Python ajan; ya da ajanı Go ile tek dosyalık bir program olarak yazmak (kurulumu ve güncellemesi kolay). TypeScript'i, üç parçanın aynı dili ve aynı protokol tanımlarını paylaşması için öneriyoruz.

## 13. Açık sorular

1. Kaç TV / kaç konum hedefleniyor? (5 mi, 50 mi, daha fazlası mı?)
2. Sunucu için aylık küçük ücretli bir bulut VPS uygun mu, yoksa evde mi barınsın?
3. Hangi dillerde/çerçevelerde rahatsın? (TypeScript önerisi buna göre değişebilir.)
4. 4K içerik ve dikey (portre) ekran ihtiyacı var mı? Videoların sesi çalınacak mı?
5. Elde hangi donanım var (Pi 4 / Pi 5 / başka)?
6. Sadece resim + video mu, yoksa ileride web sayfası / çoklu bölgeli ekran / canlı yayın da olacak mı?
7. Paneli yalnızca sen mi kullanacaksın, yoksa farklı yetkilere sahip başka kullanıcılar da olacak mı?
