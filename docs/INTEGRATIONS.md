# Integrasi software lapangan

Semua konektor berjalan dari Integration Hub. Aktifkan flag di `.env`, isi endpoint/kredensial, lalu jalankan `docker compose up -d --force-recreate integration-hub`. Status tersedia di `/connectors`; endpoint inventaris, topologi, ingest, dan insiden memakai `Authorization: Bearer <INTEGRATION_API_TOKEN>`.

| Software | Data yang diambil | Konfigurasi utama | Batas implementasi |
|---|---|---|---|
| NetBox | Perangkat, IP manajemen, site, role, vendor, maintenance | `NETBOX_URL`, `NETBOX_TOKEN` | Inventaris DCIM devices; belum melakukan sinkronisasi tulis |
| Zabbix | Host/interfaces dan last value item yang dipetakan | `ZABBIX_URL`, `ZABBIX_TOKEN` | JSON-RPC dengan Bearer token; sesuaikan item key dengan template perangkat |
| LibreNMS | Device, RTT ping, CPU sensor, rate port pilihan | `LIBRENMS_URL`, `LIBRENMS_TOKEN` | Loss/RF/error tetap null jika sumber tidak menyediakan pengukuran itu |
| GNS3 | Node, status, link dan port endpoint | `GNS3_URL`, `GNS3_PROJECT_ID` | REST API v2 untuk GNS3 2.2; belum API v3 |
| EVE-NG | Node dan interface/network ID | `EVE_NG_URL`, `EVE_NG_LAB_PATH`, username/password | Cookie login API EVE; kompatibilitas versi perlu diuji pada VM milikmu |
| Prometheus / Alertmanager | Kesehatan service/konektor, Kafka lag, backlog | Sudah tersambung dalam Compose | Alert firing/resolved masuk ke lifecycle insiden |
| Workflow backend | Permintaan review saat insiden terbuka/berubah/pulih | `WORKFLOW_ENABLED`, URL/token | HTTP webhook generik; AWX/n8n perlu gateway/workflow penerima |

GNS3/EVE-NG, NetBox, Zabbix, dan LibreNMS memakai instalasi milikmu. Compose ini menjalankan platform AIOps dan Airflow opsional. Router image dan konfigurasi lab disiapkan di GNS3/EVE-NG; keduanya tidak menyediakan pengukuran packet loss/CPU jaringan yang bisa disimpulkan dari status node saja.

## Alur identitas perangkat

Gunakan nama yang sama di NetBox, Zabbix, LibreNMS, dan lab. Hub juga mencocokkan IP manajemen dari monitoring dengan IP utama NetBox. Jika nama berbeda, tambahkan alias di `config/connectors.yml`:

```yaml
aliases:
  "zabbix:10084": core-jkt-01
  "librenms:42": core-jkt-01
  "gns3:YOUR_NODE_UUID": core-jkt-01
  "eve-ng:1": core-jkt-01
```

NetBox menjadi sumber konteks site/vendor/role. Tambahkan custom field boolean `aiops_maintenance` di NetBox untuk menekan pemicu aksi selama maintenance. Data inventory terakhir tetap tersedia ketika konektor gagal, lengkap dengan `observed_at`; periksa umur snapshot sebelum mengandalkan konteksnya.

Insiden dikelompokkan per sumber dan perangkat. Pengelompokan ini menjaga agar hasil normal dari satu sistem monitoring tidak menutup gangguan yang masih aktif di sistem lain. Identitas NetBox yang sama memudahkan perbandingan lintas sumber, tetapi implementasi ini belum menyimpulkan root cause dari topologi.

## Zabbix

`ZABBIX_URL` adalah base URL frontend, misalnya `https://monitor.example/zabbix`, tanpa `/api_jsonrpc.php`. API token perlu izin `host.get` dan `item.get`.

Mapping default mengubah `icmppingsec` dari detik ke milidetik, dan membaca `icmppingloss` sebagai persen. CPU sangat bergantung template: ganti `system.cpu.util` dengan item key yang benar, misalnya item SNMP CPU vendor. Gunakan `scale` dan `offset` jika sumber berupa idle percentage atau bit/s. Nilai berumur lebih dari `max_age_seconds` dan item unsupported dilewati. Per-item clock ikut disimpan untuk audit.

Tidak perlu membuat item fiktif untuk melengkapi input model. Field throughput/signal/error default hanya dibaca bila item tersebut memang ada. Untuk jaringan router, mulai dengan feature set yang benar-benar terukur:

```dotenv
MODEL_NAME=isolation_forest
MODEL_FEATURES=latency_ms,packet_loss_pct,cpu_usage_pct,latency_ms_rolling5,packet_loss_pct_rolling5,cpu_usage_pct_rolling5,latency_ms_zscore,cpu_usage_pct_zscore,hour,dayofweek,is_critical
```

Training mengharuskan minimal 100 observasi lengkap untuk feature set yang dipilih. Jika CPU tidak tersedia, hapus CPU serta feature turunannya dari `MODEL_FEATURES`. Data tanpa label dapat melatih Isolation Forest; Random Forest hanya dilatih bila label dan kedua kelas tersedia pada train dan test. Training default mencampur sumber yang memenuhi feature set: pilih dataset domain yang tepat sebelum mengandalkan model untuk keputusan lapangan.

## LibreNMS

`LIBRENMS_URL` adalah base URL, tanpa `/api/v0`. Default token memakai Bearer. Untuk instalasi lama, set `auth_scheme: x-auth-token` di konfigurasi konektornya. Adapter mengambil ID sensor CPU, lalu detail sensor untuk mendapatkan nilai aktual.

Atur database/poller timezone UTC karena `last_polled` dapat berupa timestamp tanpa timezone. RTT memakai `last_ping_timetaken` dalam ms. Throughput dihitung dari `ifInOctets_rate + ifOutOctets_rate`, dikali 8 lalu dibagi 1 juta. Pilih `interfaces` yang mewakili uplink/service; menjumlahkan semua port akses dan trunk dapat menghitung traffic yang sama berkali-kali.

## GNS3 / EVE-NG

Gunakan management network yang dapat dijangkau monitoring. Pada Docker Desktop, layanan di host Windows diakses melalui `host.docker.internal`; VM memakai IP routable dari container. Nama/IP yang sama menyatukan inventaris dan telemetry.

GNS3 memakai `/v2/projects/{id}/nodes` dan `/links`. Basic auth tersedia melalui `GNS3_USERNAME` dan `GNS3_PASSWORD`. EVE-NG memakai `/api/auth/login`, `/api/labs/{path}/nodes`, serta interface per node. Path lab boleh memiliki subfolder dan spasi; diisi sebagai path biasa, misalnya `User1/Lab AIOps.unl`.

## Ingest dari software lain

Exporter SNMP, hasil RESTCONF/NETCONF, atau collector lain dapat memakai kontrak yang sama. Endpoint ingest menerima satu sampai 500 event dan memberi respons 202 setelah event tersimpan dalam outbox SQLite. Respons tersebut mengakui penyimpanan lokal; status pengiriman Kafka terlihat melalui backlog.

```powershell
$headers = @{ Authorization = "Bearer YOUR_INTEGRATION_TOKEN" }
$event = @{
    schema_version = "1.0"
    source = "router-exporter"
    device_id = "core-jkt-01"
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    latency_ms = 245.0
    packet_loss_pct = 12.0
    cpu_usage_pct = 96.0
}
$body = @{ events = @($event) } | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post -Uri http://localhost:8082/ingest/metrics -Headers $headers -ContentType application/json -Body $body
```

`event_id` boleh diberikan jika unik dan stabil di sumber tersebut; jika kosong, dihitung dari isi event. Timestamp wajib menyertakan timezone. NaN, Infinity, persentase di luar rentang, dan event tanpa metrik ditolak. Label `is_anomaly` hanya diterima dari simulator; label training data nyata memerlukan proses kurasi terpisah.

## Workflow operasional

Penerima webhook mendapat `incident_id`, `version`, `state`, evidence, suggested actions, `action_mode=request_review`, dan `execution_status=not_executed`. Gunakan `Idempotency-Key` untuk menghindari eksekusi ulang ketika respons HTTP hilang. HTTP 2xx menandakan permintaan diterima; status itu tidak berarti jaringan sudah pulih.

Di n8n/AWX gateway, petakan identitas NetBox ke inventory target, pilih runbook dari allowlist, lakukan precheck, jalankan perubahan yang telah diotorisasi, lalu verifikasi telemetry sesudahnya. Implementasi AIOps ini menyediakan pengiriman durable dan konfirmasi pemulihan; belum mengeksekusi perintah vendor, belum membawa rollback perangkat, dan belum memiliki konektor AWX native.

Aktifkan pengiriman hanya setelah penerima siap:

```dotenv
WORKFLOW_ENABLED=true
WORKFLOW_WEBHOOK_URL=https://ops.example/hooks/aiops
WORKFLOW_WEBHOOK_TOKEN=YOUR_TOKEN
```

## Referensi kontrak API

- [Zabbix API dan autentikasi](https://www.zabbix.com/documentation/current/en/manual/api), [item.get](https://www.zabbix.com/documentation/current/en/manual/api/reference/item/get)
- [LibreNMS API](https://docs.librenms.org/API/), [device dan health endpoints](https://docs.librenms.org/API/Devices/)
- [NetBox REST API dan token v1/v2](https://netbox.readthedocs.io/en/stable/integrations/rest-api/)
- [GNS3 REST v2 nodes](https://gns3-server.readthedocs.io/en/stable/api/v2/controller/node/projectsprojectidnodes.html)
- [EVE-NG API](https://www.eve-ng.net/index.php/how-to-eve-ng-api/)
- [MLflow tracking server dan artifact proxy](https://mlflow.org/docs/latest/self-hosting/architecture/tracking-server/)
