# İlk Kurulum Envanteri

İlk kurulumda sisteme bağlanacak TV'ler. Boş alanlar kurulumda (Faz 0 pilotu) doldurulacak.
Kurulum adımları için: [ARCHITECTURE.md §14](ARCHITECTURE.md#14-tv-kurulum-kontrol-listesi).

## TV'ler

| TV | Konum | Yer | Durum | Oynatıcı |
|---|---|---|---|---|
| damen1 | Damen 1 | Yemekhane | **Android TV** (doğrulandı) | Uygulama TV'ye kurulacak |
| damen2 | Damen 2 | Giriş | **Android TV** (doğrulandı) | Uygulama TV'ye kurulacak |
| damen4 | Damen 4 | ? | Akıllı olmayan TV, **değiştiriliyor** | Yeni TV Google TV / Android TV olmalı ([§5.3](ARCHITECTURE.md#53-yeni-tv-alırken)) |
| damen5 | Damen 5 | Yemekhane | **Android TV** (doğrulandı) | Uygulama TV'ye kurulacak |

## Kurulumda toplanacak bilgiler

| TV | Marka / model | Android sürümü | Boş depolama | Wi-Fi ağı | Açılışta kendiliğinden başlıyor mu? | Otomatik kapanma kapatıldı mı? | Sesli oynatma |
|---|---|---|---|---|---|---|---|
| damen1 | | | | | Hayır (TV varsayılanı) | | ✅ |
| damen2 | | | | | Hayır (TV varsayılanı) | | ✅ |
| damen4 (yeni) | | | | | | | |
| damen5 | | | | | Hayır (TV varsayılanı) | | ✅ |

## İlk bulgular (15 Ekim 2026)

- **Ses:** Üç Android TV'de de sorunsuz.
- **Açılışta kendiliğinden başlama:** TV'ler açılınca uygulamayı kendiliğinden açmıyor. Bu
  beklenen bir durum; oynatıcı uygulaması bunu ana ekran (launcher) olarak ve ekranın açıldığını
  yakalayarak çözecek ([ARCHITECTURE.md §7.2](ARCHITECTURE.md#72-kiosk-davranışı)).
- **Otomatik kapanma:** Bir TV kendiliğinden kapanıyor ve menüde bu özelliği kapatma ayarı yok.
  Hangi TV olduğu ve marka/modeli belirlenecek; çözüm seçenekleri
  [ARCHITECTURE.md §7.3](ARCHITECTURE.md#73-tvnin-kendisi-uygulamanın-kontrol-edemediği-şeyler)'te.

## Notlar

- Yemekhane TV'lerinde (damen1, damen5) ses seviyesi önemli. Ses normalizasyonu (ARCHITECTURE.md
  §10.1) ve panelden TV başına ses ayarı bunu karşılar.
- Wi-Fi ağı sütununa TV'nin bağlandığı ağın adı yazılmalı. Bağlantı uygulamanın bağlantı testi
  ekranıyla doğrulanmalı, tarayıcıyla değil (ARCHITECTURE.md §6.2).
