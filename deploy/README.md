# ManageAllTV — Sunucu kurulumu

Bu klasör, ManageAllTV'yi tek bir Linux sunucuda Docker Compose ile çalıştırmak için gereken her
şeyi içerir. Kurulumdan sonra panel ve TV'lerin bağlandığı adres aynıdır: `https://<alan-adınız>`.

| Servis | Ne yapar | Dışarıya açık mı? |
|---|---|---|
| `web` (Caddy) | HTTPS sertifikasını otomatik alır/yeniler, yönetim panelini sunar, `/api` isteklerini (TV WebSocket bağlantısı dahil) sunucuya iletir | **Evet**: 80 ve 443 |
| `server` (Node.js) | API, TV bağlantıları, video/resim dönüştürme (ffmpeg), zamanlanmış işler | Hayır |
| `postgres` (PostgreSQL 17) | Veritabanı | Hayır |

Kalıcı veriler Docker birimlerinde (volume) durur:

| Birim | İçerik |
|---|---|
| `managealltv_postgres-data` | Veritabanı |
| `managealltv_media` | Dönüştürülmüş medya dosyaları ve küçük resimler (sunucuda `/var/lib/docker/volumes/managealltv_media/_data`) |
| `managealltv_caddy-data` | HTTPS sertifikaları (silmeyin; Let's Encrypt'in deneme sınırları var) |

Dosyalar:

| Dosya | Açıklama |
|---|---|
| `docker-compose.yml` | Üç servisin tanımı |
| `Caddyfile` | HTTPS, panel ve `/api` yönlendirmesi |
| `web.Dockerfile` | Paneli derleyip Caddy imajına koyar |
| `../apps/server/Dockerfile` | Sunucu imajı (Node 22 + ffmpeg, root olmayan kullanıcı) |
| `.env.example` | Ayarların şablonu (`.env` olarak kopyalanır) |
| `backup.sh` | Veritabanı + medya yedeği, eski yedekleri silme, isteğe bağlı sunucu dışı kopya |

## 1. Gereksinimler

- Linux sunucu (Ubuntu 24.04 LTS veya Debian 12 önerilir), sabit bir IP adresi.
- En az 2 çekirdek, 4 GB RAM. Video dönüştürme işlemciyi kullanır; çekirdek sayısı arttıkça hızlanır.
- Medya için yeterli disk (videolar en fazla 1080p ve ~8 Mbit/s: 1 dakikalık video en çok ≈ 60 MB).
  Yedekler için ayrıca yer.
- Docker Engine ve Compose eklentisi. Kurulu değilse:

  ```bash
  curl -fsSL https://get.docker.com | sh
  docker compose version     # "Docker Compose version v2..." yazmalı
  ```

## 2. Kurulum

### 2.1 DNS kaydı

Alan adı sağlayıcınızın panelinde, kullanacağınız ad için sunucunun IP adresini gösteren bir
**A kaydı** oluşturun (ör. `tv.ornek.com → 203.0.113.10`). Kaydın yayıldığını kontrol edin:

```bash
dig +short tv.ornek.com      # sunucunun IP adresini yazmalı
```

### 2.2 Portlar (80 ve 443)

Dışarıdan yalnız **80/TCP** (sertifika alma ve HTTPS'e yönlendirme) ve **443/TCP** (her şey) açık
olmalı; isterseniz HTTP/3 için **443/UDP** da. Sunucu bir modemin/güvenlik duvarının arkasındaysa bu
portları sunucuya yönlendirin. TV'lerin bulunduğu ağlarda hiçbir ayar gerekmez.

`ufw` kullanıyorsanız:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

> Docker'ın yayımladığı portlar `ufw` kurallarını atlar. Bu yüzden `docker-compose.yml` yalnız
> Caddy'nin 80/443 portlarını yayımlar; veritabanı ve Node sunucusu hiçbir porttan erişilebilir değildir.
> Bu dosyaya başka `ports:` satırı eklemeyin.

### 2.3 Kodu indirin ve ayarları doldurun

```bash
sudo git clone <depo-adresi> /opt/managealltv
cd /opt/managealltv/deploy
sudo cp .env.example .env
sudo chmod 600 .env
sudo nano .env
```

Doldurulması zorunlu üç ayar:

| Ayar | Değer |
|---|---|
| `DOMAIN` | 2.1'deki alan adı, ör. `tv.ornek.com` (başında `https://` olmadan) |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` çıktısı (yalnız harf ve rakam) |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 48` çıktısı (en az 32 karakter) |

Diğer ayarların açıklamaları `.env.example` içindedir.

### 2.4 Başlatın

```bash
cd /opt/managealltv/deploy
sudo docker compose up -d --build
```

İlk derleme birkaç dakika sürer. Durumu ve günlükleri kontrol edin:

```bash
sudo docker compose ps                 # üç servis "Up", server "(healthy)" olmalı
sudo docker compose logs -f server     # "Server listening" satırını görünce Ctrl+C
curl https://tv.ornek.com/health       # {"status":"ok"}
```

Sunucu her başlangıçta veritabanı geçişlerini (migration) kendisi uygular. Caddy sertifikayı ilk
istekte birkaç saniye içinde alır; alamıyorsa bkz. [Sorun giderme](#7-sorun-giderme).

### 2.5 İlk yönetici

Panelde kayıt ekranı yoktur; hesaplar davetle açılır. İlk yönetici için tek kullanımlık bir davet
bağlantısı üretin:

```bash
sudo docker compose exec server admin-invite --email ad.soyad@ornek.com --name 'Ad Soyad'
```

Komutun yazdığı bağlantıyı (`https://tv.ornek.com/invite/...`, 72 saat geçerli) tarayıcıda açın ve
en az 12 karakterlik bir parola belirleyin. Ardından panelden **iki adımlı doğrulamayı** açmanız
önerilir. Diğer kullanıcıları panelden davet edin.

Aktif bir yönetici varken komut çalışmaz. Tüm yöneticiler erişimini kaybettiyse `--force` ekleyin.

## 3. Yedekleme

`backup.sh` şunları yapar:

1. Veritabanının tam yedeği (`pg_dump`, sıkıştırılmış): `BACKUP_DIR/db/managealltv-<tarih>.dump`
2. Medya dosyaları ve küçük resimler: `BACKUP_DIR/media/` altına **rsync** ile eşitleme. O gece
   silinmiş dosyalar `BACKUP_DIR/media-deleted/<tarih>/` altına taşınır; böylece saklanan eski
   veritabanı yedekleri de eksiksiz geri yüklenebilir. Sunucuda rsync yoksa medyanın tamamı her
   gece `BACKUP_DIR/media-tar/` altına tar olarak kopyalanır (çok yer kaplar; rsync kurun).
3. `BACKUP_KEEP_DAYS` günden eski veritabanı yedeklerini ve silinmiş medya kopyalarını siler.
4. `BACKUP_RSYNC_TARGET` doluysa tüm yedek klasörünü SSH üzerinden başka bir makineye kopyalar.
   Sunucunun diski bozulursa yedekler de gider: **sunucu dışı kopyayı mutlaka ayarlayın**
   (NAS, başka bir sunucu). Hedef makineye parolasız SSH anahtarıyla erişim gerekir.

Kurulum ve ilk deneme:

```bash
sudo apt install -y rsync
sudo /opt/managealltv/deploy/backup.sh
```

Her gece 03:30'da çalışması için root'un cron tablosuna ekleyin (`sudo crontab -e`):

```cron
30 3 * * * /opt/managealltv/deploy/backup.sh >> /var/log/managealltv-backup.log 2>&1
```

Ara sıra günlüğe bakın (`sudo tail /var/log/managealltv-backup.log`) ve yılda bir kez geri yüklemeyi
deneyin: denenmemiş yedek, yedek sayılmaz.

## 4. Geri yükleme

Aşağıdaki örneklerde yedek klasörü `/var/backups/managealltv`'dir. Yedek klasörünü yalnız root
okuyabildiği için (`<` yönlendirmeleri ve `*` kalıpları dahil) bu bölümdeki komutları bir root
kabuğunda çalıştırın. Önce sunucuyu durdurun (veritabanı çalışmaya devam eder):

```bash
sudo -i
cd /opt/managealltv/deploy
docker compose stop server
```

Veritabanını yedekten yeniden oluşturun (mevcut veritabanı **silinir**):

```bash
docker compose exec -T postgres dropdb -U managealltv managealltv
docker compose exec -T postgres createdb -U managealltv managealltv
docker compose exec -T postgres pg_restore -U managealltv -d managealltv --no-owner \
  < /var/backups/managealltv/db/managealltv-20261016-033000.dump
```

Medyayı geri koyun — rsync yedeğinden:

```bash
rsync -a /var/backups/managealltv/media/ /var/lib/docker/volumes/managealltv_media/_data/
# Daha eski bir veritabanı yedeği yüklediyseniz o tarihten sonra silinen dosyaları da geri koyun:
rsync -a /var/backups/managealltv/media-deleted/*/ /var/lib/docker/volumes/managealltv_media/_data/
```

ya da tar yedeğinden:

```bash
docker compose run --rm --no-deps -T server tar -C /data/media -xf - \
  < /var/backups/managealltv/media-tar/media-20261016-033000.tar
```

Sunucuyu başlatın ve root kabuğundan çıkın:

```bash
docker compose start server
exit
```

Yeni bir sunucuya taşınırken: Bölüm 2'yi uygulayın, **eski `.env` dosyasını** (özellikle
`BETTER_AUTH_SECRET` ve `POSTGRES_PASSWORD`) kullanın, `docker compose up -d --build` ile bir kez
başlatın, sonra yukarıdaki geri yükleme adımlarını izleyin ve DNS kaydını yeni IP'ye çevirin.

## 5. Güncelleme

```bash
cd /opt/managealltv
sudo deploy/backup.sh                       # önce yedek
sudo git pull
cd deploy
sudo docker compose up -d --build
sudo docker image prune -f                  # eski imajların yerini boşaltır
```

Veritabanı geçişleri sunucu açılırken otomatik uygulanır. Güncelleme sırasında TV'ler birkaç
saniyeliğine sunucuya ulaşamaz; önbelleklerinden oynatmaya devam eder ve kendiliğinden yeniden
bağlanır. Bir video dönüştürülürken sunucu yeniden başlarsa iş açılıştan sonra yeniden başlatılır.

## 6. Sık kullanılan komutlar

Hepsi `/opt/managealltv/deploy` içinde, `sudo` ile:

| İş | Komut |
|---|---|
| Durum | `docker compose ps` |
| Sunucu günlükleri | `docker compose logs -f --tail 100 server` |
| Caddy (HTTPS) günlükleri | `docker compose logs -f --tail 100 web` |
| Yeniden başlatma | `docker compose restart server` |
| `Caddyfile` değişikliği sonrası | `docker compose restart web` |
| `.env` değişikliği sonrası | `docker compose up -d` |
| Hepsini durdurma | `docker compose down` (veriler birimlerde kalır; `-v` **eklemeyin**) |
| Disk kullanımı | `docker system df` ve `du -sh /var/lib/docker/volumes/managealltv_media` |
| Yönetici daveti | `docker compose exec server admin-invite --email ... --name '...'` |

## 7. Sorun giderme

- **Sertifika alınamıyor / tarayıcı güvenlik uyarısı:** `docker compose logs web` çıktısına bakın.
  Neredeyse her zaman DNS kaydı (`dig +short <alan-adı>` sunucunun IP'sini vermeli) ya da 80/443
  portlarının dışarıdan kapalı olmasıdır. Düzelttikten sonra `docker compose restart web`.
- **502 Bad Gateway:** sunucu açılıyordur ya da hata vermiştir: `docker compose logs server`.
- **`server` sürekli yeniden başlıyor:** günlükte `Invalid environment configuration` yazıyorsa
  `.env` içindeki ayarlardan biri eksik/hatalıdır (ör. `BETTER_AUTH_SECRET` 32 karakterden kısa).
- **Yüklenen video "Başarısız" görünüyor:** paneldeki hata mesajına bakın; dosya bozuk ya da
  desteklenmeyen bir biçimde olabilir. Ayrıntı `docker compose logs server` içindedir.
- **Disk doldu:** kullanılmayan medyayı panelden silin, `docker image prune -f` çalıştırın. Yarım
  kalan yüklemeler 24 saat sonra kendiliğinden silinir.
- **Sunucu Cloudflare Tunnel arkasında:** tek istek ~100 MB ile sınırlıdır; panel dosyaları 50 MB'lık
  parçalarla yüklediği için sorun olmaz. Bu durumda 80/443 portlarını açmanız gerekmez, ama
  `Caddyfile`'ı tünelin beklediği şekilde (ör. yalnız HTTP) uyarlamanız gerekir.
