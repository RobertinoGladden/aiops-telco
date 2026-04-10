# Telco AIOps — Network Anomaly Predictor & Auto-Healer

Proyek end-to-end yang mensimulasikan infrastruktur AI di jaringan Telekomunikasi nyata. Dari log perangkat mentah hingga jaringan yang bisa memperbaiki dirinya sendiri secara otomatis.

---

## Struktur Proyek

```
telco-aiops/
├── terraform/          ← Tahap 1: Infrastruktur sebagai kode
│   └── main.tf         ← Deploy Kafka, MinIO, Prometheus, Grafana
├── ansible/            ← Tahap 1: Konfigurasi otomatis server
│   ├── setup.yml       ← Playbook utama
│   └── inventory.yml   ← Daftar server
├── kubernetes/         ← Tahap 1: Deploy ke K8s cluster
│   └── log-generator.yaml
├── scripts/            ← Tahap 2: Data sources
│   └── log_generator.py ← Simulator 50 perangkat jaringan
├── monitoring/         ← Tahap 4: Observability
│   └── prometheus.yml
└── setup.sh            ← Script setup otomatis
```

---

## Cara Mulai (Tahap 1)

### Prerequisites
- Docker Desktop / Docker Engine
- Terraform >= 1.5
- Python >= 3.10
- kubectl (untuk deploy ke K8s)

### Langkah 1 — Clone dan setup
```bash
chmod +x setup.sh
./setup.sh
```

### Langkah 2 — Jalankan Log Generator
```bash
source venv/bin/activate
python3 scripts/log_generator.py
```
Anda akan melihat data mengalir dari 50 "perangkat jaringan virtual".

### Langkah 3 — Buka Dashboard
| Service    | URL                      | Login                      |
|------------|--------------------------|----------------------------|
| MinIO      | http://localhost:9001    | telcoadmin / telcopassword123 |
| Prometheus | http://localhost:9090    | -                          |
| Grafana    | http://localhost:3000    | admin / telco123           |

### Langkah 4 — Deploy ke Kubernetes (opsional)
```bash
kubectl apply -f kubernetes/log-generator.yaml
kubectl get pods -n telco-aiops
kubectl logs -f deployment/log-generator -n telco-aiops
```

---

## Konsep yang Dipelajari di Tahap 1

**Infrastructure as Code (Terraform)**
- Setiap server, network, dan service didefinisikan dalam kode
- `terraform plan` = preview perubahan sebelum apply
- `terraform apply` = eksekusi perubahan
- `terraform destroy` = hapus semua dengan satu perintah

**Configuration Management (Ansible)**
- Playbook = resep konfigurasi server
- Idempotent: jalankan 10x, hasilnya sama
- Handler: jalankan action hanya jika ada perubahan

**Container Orchestration (Kubernetes)**
- Deployment = "saya mau X replica dari container ini"
- Service = "cara lain container berkomunikasi"
- ConfigMap = konfigurasi yang bisa diubah tanpa rebuild
- HPA = scale otomatis berdasarkan load

---

## Roadmap Tahap Selanjutnya

**Tahap 2 — Data Engineering**
- Apache Kafka: consume stream dari log_generator.py
- Apache Airflow: pipeline otomatis ke MinIO
- Data cleaning dan feature engineering

**Tahap 3 — MLOps**
- Train model LSTM untuk deteksi anomali time-series
- MLflow untuk tracking eksperimen
- Deploy model sebagai REST API dalam container

**Tahap 4 — AIOps**
- Prometheus scrape prediksi dari model API
- Grafana dashboard real-time
- Closed-loop: model prediksi → Terraform auto-remediate
