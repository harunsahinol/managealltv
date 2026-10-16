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

## APK derleme

Android SDK gerekir (`ANDROID_HOME` ya da `local.properties` içinde `sdk.dir`):

```bash
cd apps/player-android
./gradlew :app:assembleDebug
# Çıktı: app/build/outputs/apk/debug/*.apk
```

`minSdk` 24 (Android 7.0). `player-core` `java.time` kullandığı için uygulamada **core library
desugaring açık olmalıdır** (`desugar-jdk-libs` katalogda tanımlı).

## CI

`.github/workflows/android.yml`, `apps/player-android/**` ya da `packages/protocol/fixtures/**`
değiştiğinde (push / PR) ve elle (`workflow_dispatch`) çalışır:

1. Temurin JDK 17 + `gradle/actions/setup-gradle` (önbellek, wrapper doğrulaması),
2. `player-core` testleri,
3. `./gradlew :app:assembleDebug`,
4. debug APK'yı **`managealltv-player-debug`** adlı artefakt olarak yükler.

APK'yı almak için: GitHub → Actions → ilgili çalışma → *Artifacts* → `managealltv-player-debug`.
İndirilen zip içindeki APK, TV'ye `adb install -r <apk>` ile kurulur.
