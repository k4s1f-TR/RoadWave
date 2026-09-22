# 🎵 Roadwave

**Müziğin ve videoların her an yanında.** Windows üzerinde çalışan, Türkçe arayüzlü yerel medya dönüştürücü ve YouTube indirici.

[English README →](README.md)

---

## Açılış

**`Baslat.cmd` dosyasına çift tıklayın.** Tarayıcıda `http://127.0.0.1:47831` açılır. Başlatma penceresi uygulama çalışırken açık kalmalıdır; kapatmak için arayüzdeki **Uygulamayı kapat** düğmesini veya bu pencerede Ctrl+C kullanın. Aynı başlatıcıya tekrar tıklamak mevcut uygulamayı açar.

Gereksinimler: Windows 10/11, Node.js 22 veya daha yeni sürümü. Motorlar proje içinde tutulur; sistem PATH ayarları değiştirilmez. İlk motor kurulumu internet gerektirir. Yerel dosya dönüştürme çevrimdışı çalışır; YouTube inceleme, indirme ve motor güncelleme internet kullanır.

## Kullanım

1. Dosyaları arayüze sürükleyin veya bilgisayardan seçin. Her dosyanın ses ve kapak bilgisi okunur.
2. İsterseniz kaliteyi ve **Kaydedilecek klasör → Değiştir** seçeneğini ayarlayın. Varsayılan klasör proje içindeki `outputs` klasörüdür.
3. **MP3'e dönüştür** düğmesine basın. Tamamlanan dosyalar otomatik olarak seçili klasöre kaydedilir; ayrıca indirme yapmanız gerekmez.
4. Tamamlanan parçaları ön dinleyebilir, tek tek indirebilir veya çıktı klasörünü açabilirsiniz.
5. Tamamlanan MP3 dosyalarını dilediğiniz cihaz veya medya oynatıcıda dinleyin.

## YouTube indirme

1. Sol menüde **YouTube** bölümüne geçin.
2. Video, Shorts, YouTube Music veya oynatma listesi bağlantısını yapıştırın. Video bağlantısında bir liste de varsa **Yalnızca video** ile **Bağlı oynatma listesi** seçeneklerinden birini seçin. Doğrudan `/playlist` bağlantısı otomatik liste olarak işlenir.
3. **Bağlantıyı incele** düğmesine basın. Liste gelince tümünü veya istediğiniz parçaları seçin. Uzun listeler ekranda 100'er satır gösterilir; bu sayfalama indirme kotası değildir.
4. **MP3** için 128 / 192 / 256 / 320 kbps; **MP4** için 360p–2160p çözünürlük tavanı seçin. Kaynak çözünürlüğü yükseltilmez.
5. **Seçilenleri indir** düğmesine basın. Aynı anda en fazla iki indirme işlenir. İlerleme, hız, kalan süre ve ses/video hazırlama aşaması gösterilir.
6. Dosyalar seçili ana klasörün **YouTube** alt klasörüne kaydedilir. Oynatma listeleri kendi klasöründe, `001 - Başlık [video-id].mp3` gibi sıralı adlarla tutulur. Ana klasör seçimi yerel dönüştürücüyle ortaktır.

MP3, evrensel uyumlu 44,1 kHz/stereo/ID3v2.3 ayarlarını kullanır. Video görseli mevcutsa ve kapak seçeneği açıksa en fazla 600×600 JPEG olarak gömülür. MP4 H.264/AAC ve `faststart` ile hazırlanır; uyumlu akışlar yeniden kodlanmadan kopyalanır, diğer codec'ler dönüştürülür.

Kuyruk ve sonuçlar yeniden açılışta korunur. Kesilen indirmeler **Yeniden dene** ile başlatılır; yt-dlp desteklediği durumda `.part` dosyasından devam eder. Hatalı bir video kalan kuyruğu durdurmaz. Aynı video/ayar zaten kuyrukta veya diskteyse yeniden eklenmez; listeden kaldırdıktan sonra tekrar indirebilirsiniz. Çıktı dosyalarının üzerine yazılmaz.

Liste temizleme çıktı dosyalarını silmez. Tamamlanan indirmelerin geçici dosyaları temizlenir; hatalı veya durdurulmuş işlerin çalışma dosyaları yeniden denemek için tutulur, iş listeden kaldırılınca temizlenir.

İndirme motorunun yanındaki **güncelle** düğmesi resmi yt-dlp sürümünü indirip SHA256 ile doğrular. Motor yoksa aynı düğme kurar. Alternatif: `YouTube-Motorunu-Guncelle.cmd`. Güncelleme sırasında yeni indirmeler başlatılamaz. Node.js, yt-dlp'nin JavaScript işleme gereksinimini karşılar; EJS resmi executable içinde gelir. [yt-dlp belgeleri](https://github.com/yt-dlp/yt-dlp), [EJS kurulumu](https://github.com/yt-dlp/yt-dlp/wiki/EJS).

Uygulamada günlük indirme kotası yoktur; YouTube erişimi/hızı sınırlayabilir. Özel, silinmiş, üyelik/oturum gerektiren veya canlı yayın durumundaki içerikler desteklenmez. Hesap, tarayıcı çerezleri ve DRM çözme akışı kullanılmaz.

## Ses ve çıktı standartları

- MP3 / MPEG-1 Layer III, varsayılan 192 kbps CBR, 44,1 kHz, stereo.
- İsteğe bağlı 128, 256 veya 320 kbps.
- Mevcut başlık, sanatçı ve albüm etiketleri korunur. ID3v2.3 ve ek ID3v1 etiketi yazılır; Unicode bilgiler ID3v2 etiketinde saklanır.
- Kaynakta gömülü kapak varsa en fazla 600 × 600 JPEG olarak eklenir. Kapak bozuksa ses kapaksız işlenir ve uyarı gösterilir.
- Sade dosya adları seçeneği, Türkçe karakterleri Latin harflere çevirir; şarkı etiketlerini değiştirmez.
- MP4 indirmelerinde H.264 video ve AAC ses kodekleri kullanılır; hızlı başlatma ve yüksek cihaz uyumluluğu için `faststart` bayrağı uygulanır.

## Dosyalar ve performans

- Günlük kota veya uygulamanın koyduğu dosya boyutu/adedi sınırı yoktur. Disk alanı, RAM ve işlemci gerçek sınırları belirler.
- Yerel kaynak dosyalar internete gönderilmez; tarayıcıdan aynı bilgisayardaki sunucuya akışla kopyalanır. Büyük dosyalar sunucuda bütünüyle RAM'e alınmaz. YouTube bölümünde verilen bağlantılar YouTube'a sorgulanır ve içerik bilgisayarınıza indirilir.
- Tarayıcı dosya seçiminde yerel yol paylaşmadığı için çalışma kopyası gerekir. Dönüşüm sırasında kaynak kopyası, geçici MP3 ve son MP3 için boş alan bulunmalıdır.
- Orijinal dosyalara dokunulmaz. Başarılı dönüşüm sonrası çalışma kopyası temizlenir. Hatalı/durdurulan dosyaların kopyaları yeniden deneme için tutulur; listeden kaldırılınca bu kopyalar temizlenir.
- Aynı adlı MP3 zaten varsa `Şarkı (2).mp3` gibi yeni ad kullanılır. Mevcut dosyaların üzerine yazılmaz.
- Listeden kaldırma ve tamamlananları temizleme işlemleri çıktı MP3'leri silmez.
- Varsayılan iki paralel işlem. Gelişmiş ayarlarda 1 veya 4 seçilebilir; gerçek hız CPU ve disk hızına bağlıdır.
- Kuyruk ve ayarlar `data/state.json` içinde saklanır. Kesilen işlemler sonraki açılışta yeniden denenebilir. Yeni ayarlar daha önce başlatılmış işlerin ayarlarını değiştirmez.
- Sunucu yalnızca `127.0.0.1` üzerinde dinler. Değişiklik isteklerinde oturum belirteci, Host ve Origin denetimi uygulanır.

## Geliştirme ve doğrulama

```powershell
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-engine.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-youtube.ps1
npm test
npm start
```

Testler gerçek FFmpeg ile örnek ses/video üretir ve MP3 codec, bit hızı, kanal, örnekleme, Unicode etiket, kapak boyutu, isim çakışması, durdurma/yeniden deneme, WebM→H.264/AAC MP4, ön dinleme HTTP aralığı ve yerel API erişimini denetler. YouTube kuyruğu testlerinde ağ bölümü kontrollü test yanıtlarıyla değiştirilir; medya işleme gerçektir. Arayüz testleri jsdom ile dosya adının güvenli gösterimi, düğme bağlantıları, ayarlar, canlı ilerleme, liste seçimi, hatalar ve ön dinleme durumlarını sınar. Test dosyaları `test-artifacts` altında ayrılır; kullanıcının dosyaları kullanılmaz.

`FFMPEG_PATH`, `FFPROBE_PATH`, `YTDLP_PATH`, `PORT`, `ROADWAVE_DATA`, `ROADWAVE_OUTPUT` ortam değişkenleri geliştirme/test için yolları değiştirebilir. Birden fazla sunucuyu aynı veri klasörüyle çalıştırmayın. YouTube işleri `data/youtube/state.json`, geçici dosyalar `data/youtube/work` altında tutulır.

## Motor ve lisans

- **FFmpeg / FFprobe**: [FFmpeg](https://ffmpeg.org/) projesi, [Gyan Windows derlemeleri](https://www.gyan.dev/ffmpeg/builds/) — GPLv3. Motor `scripts/install-engine.ps1` ile indirilir ve SHA256 ile doğrulanır. Repoya dahil değildir.
- **yt-dlp**: [yt-dlp](https://github.com/yt-dlp/yt-dlp) projesi — Unlicense. Motor `scripts/install-youtube.ps1` ile indirilir ve SHA256 ile doğrulanır. Repoya dahil değildir.

Projeyi motorlarla birlikte üçüncü kişilere dağıtacaksanız ilgili dağıtım ve kaynak sağlama yükümlülüklerini ayrıca yerine getirin.

## Lisans

Bu proje [Apache License 2.0](LICENSE) ile lisanslanmıştır.
