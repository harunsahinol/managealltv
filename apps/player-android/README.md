# ManageAllTV Oynatıcı (Android)

TV'lerde çalışan oynatıcı uygulaması. Mimari kararlar için [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
(§7 Oynatıcı, §11.3 Senkronizasyon), cihaz API'si için [docs/API.md](../../docs/API.md). Sözleşmenin
kaynağı `packages/protocol` paketidir; Kotlin modelleri ona birebir uyar ve testlerle kontrol edilir.

## Yapı

```
apps/player-android/
├── settings.gradle.kts      # Kök build: :app + includeBuild("player-core")
├── build.gradle.kts         # Eklentiler (AGP, Kotlin) burada sürümlenir, modüllerde uygulanır
├── gradle.properties
├── gradle/libs.versions.toml  # İki build'in ORTAK sürüm kataloğu
├── gradlew, gradlew.bat, gradle/wrapper/   # Gradle 8.14.3
├── player-core/             # Saf Kotlin/JVM modülü — Android SDK gerektirmez
│   ├── settings.gradle.kts  # Tek başına da derlenir (yalnız Maven Central + Gradle Plugin Portal)
│   └── src/{main,test}/kotlin/tv/managealltv/player/core/
└── app/                     # Android TV uygulaması (player-core'u kullanır)
    ├── build.gradle.kts
    └── src/
        ├── main/AndroidManifest.xml
        ├── main/kotlin/tv/managealltv/player/
        │   ├── PlayerService.kt       # Uzun ömürlü her şey: eşleştirme, SyncEngine, DeviceSocket, komutlar
        │   ├── MainActivity.kt        # Tek ekran: eşleştirme, oynatma, "Yayın yok", paneller
        │   ├── BootReceiver.kt, AdminReceiver.kt, AppRestarter.kt, PlayerApp.kt
        │   ├── playback/              # PlaybackController (Media3 + çapraz geçişli resimler)
        │   ├── diagnostics/           # Bağlantı testi (DNS → TCP → TLS → /health)
        │   ├── device/, data/, state/ # Cihaz bilgisi/kontrolü, ayarlar, paylaşılan durum (StateFlow)
        │   └── logic/                 # Android'siz saf mantık (JVM birim testli)
        ├── main/res/                  # Türkçe metinler, düzenler, banner, network_security_config
        ├── debug/res/xml/             # Yalnız debug: http'ye izin veren ağ ayarı
        └── test/kotlin/               # logic/ paketinin JUnit 4 testleri
```

`app`, `player-core`'a `tv.managealltv:player-core` koordinatıyla bağlanır; Gradle bunu
`includeBuild` sayesinde kaynak koddan derler (yayınlama gerekmez).

### player-core paketleri (`tv.managealltv.player.core`)

| Paket | İçerik |
|---|---|
| `protocol` | `packages/protocol` Zod şemalarının kotlinx.serialization karşılıkları (`Manifest`, `DeviceStatus`, `PairPollResponse`, `Command`, `ServerToDevice`, `DeviceToServer`…) ve `ProtocolJson` ayarları |
| `schedule` | `ScheduleEvaluator` — `schedule.ts` ile aynı kurallar (gece yarısını aşan pencere, öncelik, tarih aralığı) |
| `cache` | `MediaCache` — dosyalar SHA-256 adıyla `media/` altında, yarım indirmeler `partial/` altında; indeks ve uygulanan manifest atomik yazılır |
| `sync` | `SyncPlanner` (eksikler, silinecekler, depolama bütçesi), `Downloader` (Range ile devam, boyut + SHA-256 doğrulama, yeniden deneme), `SyncEngine` (indir → doğrula → uygula → sil) |
| `net` | `ApiClient` (eşleştirme, manifest/ETag, durum, komut sonucu), `DeviceSocket` (WebSocket, yeniden bağlanma, 30 sn'de bir durum) |
| `playback` | `PlaybackPlanner` — uygulanan manifest + saat → çalınacak liste ve yerel dosyalar |
| `time`, `util` | Test edilebilir saat (`TimeSource`), günlük (`CoreLog`), atomik dosya yazımı, SHA-256, geri çekilme (backoff) |

### Senkronizasyon kuralları

1. Manifest, uygulanan sürüm ETag olarak gönderilerek çekilir (`304` = değişiklik yok).
2. Eksik dosyalar `partial/<sha256>.part` dosyasına indirilir; kopan indirme `Range` ile kaldığı yerden
   sürer. Boyut ve SHA-256 tutmadan dosya `media/` altına taşınmaz.
3. **Bütün dosyalar doğrulanınca** manifest atomik olarak kaydedilir ve oynatıcı yeni listeye geçer.
4. Ancak bundan sonra yeni manifestin kullanmadığı dosyalar silinir.

Herhangi bir adım başarısız olursa eski manifest ve dosyaları yerinde kalır; ekran yarım bir listeyle
oynamaz. İndirme başlamadan boş alan kontrol edilir (varsayılan 300 MB yedek alan bırakılır), yer
yoksa hata panelde `lastError` olarak görünür.

## Yerelde test

JDK 17 veya üstü yeterlidir; Android SDK gerekmez.

```bash
cd apps/player-android/player-core
../gradlew test
```

Testler `packages/protocol/fixtures/*.json` dosyalarını doğrudan okur: her fixture katı modda
(bilinmeyen alan yasak, her nullable alan zorunlu) çözülür, yeniden kodlanır ve JSON ağacının
birebir aynı çıktığı kontrol edilir. `schedule-cases.json` içindeki her durum Kotlin
değerlendiricisiyle de çalıştırılır. Yeni bir fixture eklenirse ona Kotlin testi yazılana kadar
`every fixture file is covered by a test` testi başarısız olur.

Ağ testleri (indirici, API istemcisi, WebSocket, uçtan uca senkronizasyon) OkHttp MockWebServer ile
yerel olarak çalışır; internet gerekmez.

## Oynatıcı uygulaması (`app`)

Uygulama ince tutulmuştur: test edilebilir mantık `player-core`'dadır. `PlayerService` bir ön plan
servisidir ve uzun ömürlü her şeyin sahibidir (eşleştirme, `SyncEngine`, `DeviceSocket` + 30 sn'lik
durum bildirimi, uzaktan komutlar). `MainActivity` yalnız ekrandır: servisin yayınladığı durumu
(`AppStateStore`, bir `StateFlow`) gösterir ve uygulanan manifesti oynatır. Compose kullanılmaz
(zayıf TV'ler için klasik View'lar).

### Ekranda görülenler

| Ekran | Ne zaman | İçerik |
|---|---|---|
| **Başlatılıyor…** | Uygulama açılırken | — |
| **Eşleştirme** | Cihaz anahtarı yokken | Büyük 6 haneli kod (`482 913`), sunucu adresi, kısa talimat, donanım kimliği. Kodun süresi dolunca yenisi kendiliğinden alınır. Düğmeler: **Bağlantı testi**, **Sunucu adresi** |
| **Oynatma** | Eşleşmiş ve oynatılacak bir şey varken | Videolar Media3 ile, resimler kısa bir çapraz geçişle; liste döngüde oynar |
| **Yayın yok** | Planlanmış liste yoksa / liste boşsa / içerik henüz inmediyse | Nedeni alt satırda (ör. "İçerik indiriliyor: 3/10 dosya, %45") |
| **Cihaz adı** (identify) | Panelde ekranın **Tanımla** komutu | Cihaz adı tam ekran, çok büyük; süre dolunca kapanır |
| **Cihaz bilgisi** paneli | Kumandada **MENU / INFO** ya da **OK'a uzun basma** | Sürüm, sunucu, cihaz kimliği, manifest sürümü, senkron durumu, sunucu bağlantısı, son hata, "üstte gösterme" izni, Device Owner durumu; buradan **Bağlantı testi** açılır |
| **Bağlantı testi** | Eşleştirme ekranından ya da bilgi panelinden | Cihaz saati → ağ (Wi-Fi/doğrulandı mı) → DNS → TCP → TLS (sertifika, geçerlilik) → `GET /health`; her adımın süresi ve Türkçe sonuç |
| **Sunucu adresi** | Eşleştirme ekranından | Kumandayla düzenlenen adres alanı (OK klavyeyi açar). Yalnız https kabul edilir (debug sürümünde http de) |

**GERİ** tuşu açık paneli kapatır ama oynatıcıdan çıkmaz (kiosk). Oynatma sırası: zamanlama her
15 sn'de bir ve yeni manifest uygulandığında yeniden değerlendirilir. Etkin liste değiştiyse hemen
yeni listeye geçilir, değişmediyse çalan öğe bitince yeni listenin sıradaki öğesine geçilir.
Oynatılamayan öğe atlanır ve panelde "son hata" olarak görünür. Cihaz saati açıkça yanlışsa
(2025'ten önce) zamanlama değerlendirilmez, varsayılan liste oynar.

### Uzaktan komutlar

| Komut | Davranış |
|---|---|
| `reload` | Manifest hemen yeniden kontrol edilir, oynatma döngüsü baştan başlar |
| `restart_app` | Sonuç bildirilir, AlarmManager ile yeniden açılış planlanır, süreç kapanır |
| `identify` | Cihaz adı istenen süre tam ekranda gösterilir; ekran kapalıysa ya da oynatıcı önde değilse komut başarısız döner |
| `set_volume` | `STREAM_MUSIC` istenen yüzdeye ayarlanır (TV sabit ses kullanıyorsa başarısız) |
| `reboot` | Yalnız Device Owner modunda; değilse Türkçe gerekçeyle başarısız döner |

Paneldeki TV ses seviyesi uygulama açılışında ve her yeni manifest sürümünde uygulanır.

### Ağ güvenliği

`res/xml/network_security_config.xml` sistem sertifikalarına ek olarak Let's Encrypt'in
**ISRG Root X1** ve **ISRG Root X2** kök sertifikalarını (`res/raw/isrg_root_x*.pem`) taşır; Android
7.0'da Let's Encrypt sertifikalı sunucuya böylece bağlanılır. Release sürümünde şifresiz http
yasaktır; yalnız debug sürümü (`src/debug/res/xml/`) http'ye ve kullanıcı sertifikalarına izin verir.

## APK derleme

### CI (önerilen)

`.github/workflows/android.yml`, `apps/player-android/**` ya da `packages/protocol/fixtures/**`
değiştiğinde (push / PR) ve elle (`workflow_dispatch`) çalışır:

1. Temurin JDK 17 + `gradle/actions/setup-gradle` (önbellek, wrapper doğrulaması),
2. `player-core` testleri,
3. `./gradlew :app:assembleDebug`,
4. debug APK'yı **`managealltv-player-debug`** adlı artefakt olarak yükler.

APK'yı almak için: GitHub → Actions → ilgili çalışma → *Artifacts* → `managealltv-player-debug`.

### Yerelde

Android SDK gerekir (`ANDROID_HOME` ya da `local.properties` içinde `sdk.dir`):

```bash
cd apps/player-android
./gradlew :app:assembleDebug
# Çıktı: app/build/outputs/apk/debug/*.apk

# Varsayılan sunucu adresini APK'ya gömmek için (TV'de kumandayla yazmak gerekmez):
./gradlew :app:assembleDebug -Pmanagealltv.serverUrl=https://tv.firma.com

# Uygulamanın saf mantık testleri (Android SDK ile):
./gradlew :app:testDebugUnitTest
```

`minSdk` 24 (Android 7.0), `targetSdk` 35. `player-core` `java.time` kullandığı için uygulamada
**core library desugaring açıktır**.

**Release imzası** ortam değişkenlerinden okunur; yoksa release APK debug anahtarıyla imzalanır:

```bash
export MTV_KEYSTORE_FILE=/yol/managealltv.jks MTV_KEYSTORE_PASSWORD=… MTV_KEY_ALIAS=… MTV_KEY_PASSWORD=…
./gradlew :app:assembleRelease
```

Bir TV'ye kurulu APK'yı güncellerken **aynı anahtarla** imzalanmış APK kullanılmalıdır (Android farklı
imzalı güncellemeyi reddeder). Debug ve release APK'ları birbirinin üzerine kurulamaz.

## TV'ye kurulum

Her TV için [ARCHITECTURE.md §14](../../docs/ARCHITECTURE.md#14-tv-kurulum-kontrol-listesi)
kontrol listesi uygulanır. adb komutları aynı ağdaki bir bilgisayardan çalıştırılır.

### 1. adb ile bağlanma ve kurulum

TV'de: Ayarlar → Cihaz tercihleri → Hakkında → **Derleme**'ye 7 kez basın (geliştirici seçenekleri
açılır) → Geliştirici seçenekleri → **USB/Ağ hata ayıklaması** açık. TV'nin IP adresi Ağ ayarlarındadır.

```bash
adb connect 192.168.1.50:5555        # TV'de çıkan "izin ver" sorusunu onaylayın
adb install -r managealltv-player.apk
adb shell am start -n tv.managealltv.player/.MainActivity
```

### 2. "Diğer uygulamaların üzerinde göster" izni (Android 10+)

TV bekleme modundan uyandığında oynatıcının kendiliğinden öne gelmesi için gerekir (pilot bulgusu:
TV'ler uygulamayı kendiliğinden açmıyor). TV menüsünde çoğu zaman yoktur, adb ile verilir:

```bash
adb shell appops set tv.managealltv.player SYSTEM_ALERT_WINDOW allow
```

Bilgi panelinde "Diğer uygulamaların üzerinde gösterme izni: Var" görünmelidir.

### 3. Ana ekran (launcher) olarak seçme

Uygulama bir ana ekran (HOME) uygulamasıdır. Device Owner olmayan TV'de **HOME** tuşuna basınca
Android hangi ana ekranın kullanılacağını sorabilir: **ManageAllTV** ve **Her zaman** seçin. Google TV
gibi bazı sistemler bu seçimi sunmaz; o durumda kalıcı ana ekran için Device Owner gerekir.

### 4. Device Owner (yalnız tabela olarak kullanılan TV'ler)

Device Owner modunda uygulama **kalıcı ana ekran** olur (açılışta ve her uyanışta doğrudan oynatıcı
gelir, HOME tuşu da oynatıcıya döner) ve panelden **yeniden başlatma** çalışır.

Ön koşul: TV'de **hiç hesap olmamalı**. Ayarlar → Hesaplar'dan Google hesabını (ve varsa diğer
hesapları) kaldırın; kalan hesapları şöyle görebilirsiniz:

```bash
adb shell dumpsys account | grep -i "Account {"
adb shell dpm set-device-owner tv.managealltv.player/.AdminReceiver
```

Başarılı olunca "Success: Device owner set to package …" yazar; bilgi panelinde "Device Owner modu:
Evet" görünür. Hata "already several accounts on the device" ise hâlâ hesap vardır; "already
provisioned" ise TV'nin kurulum sihirbazı tamamlanmış ve bazı modellerde Device Owner yalnız fabrika
ayarlarından hemen sonra atanabilir.

**Dikkat:** Device Owner'ı kaldırmanın tek güvenilir yolu TV'yi fabrika ayarlarına döndürmektir. Bu
modda TV başka amaçla (YouTube, yayın) kullanılamaz.

### 5. Eşleştirme

Ekrandaki 6 haneli kodu panelde **Ekranlar → TV ekle**'ye girin. Kod 15 dakika geçerlidir; süresi
dolunca TV yenisini kendiliğinden gösterir. Önce **Bağlantı testi** çalıştırılmalıdır (tarayıcıyla
test etmek yanıltıcıdır, ARCHITECTURE §6.2).

## Sorun giderme

| Belirti | Olası neden / çözüm |
|---|---|
| TV uyanınca oynatıcı gelmiyor, TV'nin kendi ana ekranı açılıyor | "Üstte gösterme" izni yok (adım 2) ya da uygulama ana ekran seçilmemiş (adım 3). Kalıcı çözüm Device Owner (adım 4). Bilgi panelinde iki değeri kontrol edin |
| TV birkaç saat sonra kendini kapatıyor | Uygulamanın kontrol edemediği bir sistem ayarı (enerji tasarrufu / boşta bekleme). ARCHITECTURE §7.3 |
| Bağlantı testinde **DNS** hatası | Wi-Fi ağı alan adını engelliyor ya da DNS çalışmıyor; ağ yöneticisine sunucu adresini bildirin |
| **TLS** hatası | Önce testin ilk satırındaki **cihaz saatini** kontrol edin (yanlış saat sertifikayı geçersiz kılar). Saat doğruysa ağ trafiğe müdahale ediyor olabilir (misafir ağı / proxy) |
| "Ağ … bağlı, ancak Android internete erişimi doğrulayamadı" | Giriş sayfalı (captive portal) misafir ağı; TV'yi giriş gerektirmeyen bir ağa bağlayın |
| Eşleştirme ekranında "Kod alınamadı … HTTP 429" | Aynı IP'den çok fazla eşleştirme isteği; uygulama bekleyip kendisi yeniden dener |
| Eşleşmiş TV aniden eşleştirme ekranına döndü | Cihaz panelden silindi ya da anahtarı iptal edildi; yeniden eşleştirin |
| "Yayın yok" | Alt satır nedeni söyler: o saat için liste planlanmamış, liste boş, içerik iniyor ya da indirme hatası. İndirme hatası "Son hata" olarak panelde de görünür |
| "Yetersiz depolama alanı" | TV'de yer yok; içerik en az 300 MB boş alan bırakacak şekilde indirilir. Kullanılmayan uygulamaları kaldırın ya da listeyi küçültün |
| Video oynamıyor, resimler oynuyor | TV bu video biçimini çözemiyor olabilir; panelde cihazın çözücü listesine bakın (eşleştirmede bildirilir) |

Günlükler: `adb logcat | grep MTV-` (player-core ve uygulamanın tüm satırları `MTV-` ile başlar).
