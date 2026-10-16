# ManageAllTV

Farklı konumlardaki televizyonları tek bir web panelinden yönetmek için dijital tabela (digital signage) sistemi. Resim ve videoları yükle, oynatma listelerine koy, istediğin TV'lere ata. TV'ler aynı ağda da olsa farklı şehirlerde de olsa çalışır.

- **Oynatıcı:** Android uygulaması. Android TV'lere doğrudan, eski TV'lere Android TV çubuğu üzerinden kurulur.
- **Sunucu:** Kendi sunucumuzda TypeScript API + web paneli, Docker Compose ile.
- **Çevrimdışı öncelikli:** TV'ler içeriği indirip yerelden oynatır; internet giderse yayın sürer.

**Durum:** MVP kodlandı; sıradaki adım gerçek TV'lerde pilot.

| Ne | Nerede |
|---|---|
| Mimari ve tech stack | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| API sözleşmesi | [docs/API.md](docs/API.md) |
| Sunucu kurulumu (Docker Compose, HTTPS, yedekleme) | [deploy/README.md](deploy/README.md) |
| Android oynatıcı (APK, TV'ye kurulum, Device Owner) | [apps/player-android/README.md](apps/player-android/README.md) |
| İlk kurulum envanteri | [docs/kurulum-envanteri.md](docs/kurulum-envanteri.md) |

## Depo yapısı

| Yol | Ne |
|---|---|
| `packages/protocol` | TV ↔ sunucu ve panel ↔ sunucu sözleşmesi (Zod), zamanlama kuralları, ortak test örnekleri |
| `apps/server` | Hono API, WebSocket, medya işleme (ffmpeg/sharp), PostgreSQL (Prisma), Better Auth |
| `apps/web` | Yönetim paneli (React + Vite, Türkçe) |
| `apps/player-android` | Android TV oynatıcı (Kotlin, Media3) ve JVM üzerinde test edilen `player-core` |
| `deploy` | docker-compose, Caddy, Dockerfile'lar, yedekleme betiği |

## Geliştirme

```bash
pnpm install
pnpm test        # protokol, sunucu (PostgreSQL gerekir, bkz. apps/server/README.md) ve panel testleri
pnpm dev         # sunucu (:3000) + panel (:5173)
```

APK GitHub Actions'ta derlenir: "Android player" iş akışının `managealltv-player-debug` çıktısı.
