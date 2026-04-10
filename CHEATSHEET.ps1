# ================================================================
# TELCO AIOPS — CHEATSHEET LENGKAP
# Semua command untuk menjalankan sistem dari awal hingga akhir
# ================================================================

# ─── URUTAN STARTUP (jalankan sekali saja) ───────────────────

# LANGKAH 1: Masuk ke folder project & aktifkan venv
cd C:\Users\lapt1\Downloads\aiops
.\venv\Scripts\Activate.ps1

# LANGKAH 2: Nyalakan semua Docker container (infrastruktur)
cd terraform
terraform apply -auto-approve
cd ..

# LANGKAH 3: Nyalakan MLflow (jika belum jalan)
cd mlflow
docker-compose up -d
cd ..


# ─── TERMINAL 1: Log Generator (sumber data) ─────────────────
cd C:\Users\lapt1\Downloads\aiops
.\venv\Scripts\Activate.ps1
python scripts/log_generator.py


# ─── TERMINAL 2: Kafka Consumer → MinIO ──────────────────────
cd C:\Users\lapt1\Downloads\aiops
.\venv\Scripts\Activate.ps1
python consumer/kafka_to_minio.py


# ─── TERMINAL 3: Model API Server ────────────────────────────
cd C:\Users\lapt1\Downloads\aiops
.\venv\Scripts\Activate.ps1
python api/model_server.py
# Port default: 8081 (sesuai yang sudah jalan)


# ─── TERMINAL 4: Auto Predictor (BARU — prediksi otomatis) ───
cd C:\Users\lapt1\Downloads\aiops
.\venv\Scripts\Activate.ps1
python predictor/auto_predictor.py


# ─── TRAINING ULANG MODEL (jalankan sesekali) ────────────────
# Jika akurasi model turun (model drift), latih ulang:
cd C:\Users\lapt1\Downloads\aiops
.\venv\Scripts\Activate.ps1
python model/train.py
# Lalu restart model server (Terminal 3)


# ─── DASHBOARD & UI ──────────────────────────────────────────
# Grafana Dashboard  : http://localhost:3000  (admin / telco123)
# MinIO Data Lake    : http://localhost:9001  (telcoadmin / telcopassword123)
# Prometheus Metrics : http://localhost:9090
# MLflow Experiments : http://localhost:5000
# Model API Swagger  : http://localhost:8081/docs
# Model API Metrics  : http://localhost:8081/metrics


# ─── CEK STATUS SISTEM ───────────────────────────────────────
# Cek semua container Docker
docker ps --format "{{.Names}}: {{.Status}}"

# Cek health Model API
Invoke-RestMethod http://localhost:8081/health

# Cek berapa data di MinIO (jumlah file)
python -c "
import boto3; from botocore.client import Config
c = boto3.client('s3', endpoint_url='http://127.0.0.1:9000',
    aws_access_key_id='telcoadmin', aws_secret_access_key='telcopassword123',
    config=Config(signature_version='s3v4'), region_name='us-east-1')
for b in ['telco-raw-data','telco-processed-data','telco-models']:
    r = c.list_objects_v2(Bucket=b)
    print(f'{b}: {r[\"KeyCount\"]} files')
"

# Test prediksi manual (tanpa Swagger)
Invoke-RestMethod -Method POST -Uri http://localhost:8081/predict `
  -ContentType 'application/json' `
  -Body '{
    "device_id": "BTS-JAK-TEST",
    "device_type": "BTS",
    "region": "Jakarta",
    "latency_ms": 250,
    "packet_loss_pct": 8,
    "cpu_usage_pct": 92,
    "throughput_mbps": 45,
    "signal_strength_dbm": -95,
    "error_rate": 0.05
  }' | ConvertTo-Json


# ─── IMPORT DASHBOARD KE GRAFANA ─────────────────────────────
# 1. Buka http://localhost:3000
# 2. Klik Dashboards → Import
# 3. Upload file: grafana/aiops_dashboard.json
# 4. Pilih data source: Prometheus
# 5. Klik Import


# ─── STOP SEMUA (saat selesai) ───────────────────────────────
# Ctrl+C di setiap terminal (Terminal 1-4)
# Lalu stop Docker:
docker stop telco-kafka telco-zookeeper telco-grafana telco-prometheus telco-minio telco-mlflow
# Atau:
cd terraform && terraform destroy -auto-approve


# ─── ARSITEKTUR ALUR DATA ────────────────────────────────────
#
#  [Log Generator] ──Kafka──► [Kafka Consumer] ──► [MinIO Data Lake]
#       │                                                │
#       │                                         (training data)
#       │                                                │
#       └──Kafka──► [Auto Predictor] ──POST──► [Model API Server]
#                        │                          │
#                        │                    (Prometheus metrics)
#                        │                          │
#                   [Remediation]            [Grafana Dashboard]
#                  (auto-healing)            (visualisasi real-time)
#
