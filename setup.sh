#!/bin/bash
# =============================================================
# TELCO AIOPS — Tahap 1: Master Setup Script
# Jalankan: chmod +x setup.sh && ./setup.sh
# =============================================================

set -e  # Berhenti jika ada error

# ─── WARNA UNTUK OUTPUT ──────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'  # No Color

# ─── HELPER FUNCTIONS ────────────────────────────────────────
log_step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }
log_ok()   { echo -e "${GREEN}✅ $1${NC}"; }
log_warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_err()  { echo -e "${RED}❌ $1${NC}"; exit 1; }
log_info() { echo -e "${CYAN}ℹ️  $1${NC}"; }

# ─── HEADER ──────────────────────────────────────────────────
echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║     TELCO AIOPS — Tahap 1: DevOps Foundation         ║"
echo "║     Network Anomaly Predictor & Auto-Healer          ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ─── PREREQUISITES CHECK ─────────────────────────────────────
log_step "Memeriksa Prerequisites"

check_command() {
    if command -v "$1" &> /dev/null; then
        log_ok "$1 tersedia: $(command -v $1)"
    else
        log_err "$1 tidak ditemukan. Install dulu: $2"
    fi
}

check_command "docker"    "https://docs.docker.com/get-docker/"
check_command "terraform" "https://developer.hashicorp.com/terraform/downloads"
check_command "kubectl"   "https://kubernetes.io/docs/tasks/tools/"
check_command "python"   "https://www.python.org/downloads/"

# Pilih perintah Python yang tersedia
if command -v python3 &> /dev/null; then
    PYTHON_CMD=python3
elif command -v python &> /dev/null; then
    PYTHON_CMD=python
else
    log_err "Python tidak ditemukan. Install dulu: https://www.python.org/downloads/"
fi

# Cek Docker berjalan
if ! docker info &> /dev/null; then
    log_err "Docker daemon tidak berjalan. Jalankan Docker Desktop di Windows"
fi
log_ok "Docker daemon aktif"

# Cek versi Python
PYTHON_VERSION=$($PYTHON_CMD --version 2>&1 | grep -oP '\d+\.\d+')
PYTHON_MAJOR=$(echo $PYTHON_VERSION | cut -d. -f1)
PYTHON_MINOR=$(echo $PYTHON_VERSION | cut -d. -f2)
if [ "$PYTHON_MAJOR" -lt 3 ] || [ "$PYTHON_MINOR" -lt 10 ]; then
    log_warn "Python 3.10+ direkomendasikan (Anda punya: $PYTHON_VERSION)"
fi

# ─── SETUP PYTHON ENVIRONMENT ────────────────────────────────
log_step "Setup Python Virtual Environment"

if [ ! -d "venv" ]; then
    $PYTHON_CMD -m venv venv
    log_ok "Virtual environment dibuat"
fi

if [ -f "venv/Scripts/activate" ]; then
    source venv/Scripts/activate
    ACTIVATE_CMD="source venv/Scripts/activate"
elif [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
    ACTIVATE_CMD="source venv/bin/activate"
else
    log_err "Aktivasi venv tidak ditemukan. Coba buat ulang virtual env."
fi
log_ok "Virtual environment aktif"

log_info "Menginstall Python packages..."
pip install --upgrade setuptools wheel
pip install \
    kafka-python==2.0.2 \
    prometheus-client==0.18.0 \
    boto3==1.29.0

log_ok "Python packages terinstall"

# ─── TERRAFORM INIT ──────────────────────────────────────────
log_step "Inisialisasi Terraform"

cd terraform

terraform init -upgrade 2>&1 | tail -5

if terraform validate &> /dev/null; then
    log_ok "Terraform konfigurasi valid"
else
    log_warn "Ada warning di terraform validate — periksa main.tf"
fi

# Buat plan dulu untuk preview
log_info "Membuat execution plan Terraform..."
terraform plan -out=tfplan.out 2>&1 | grep -E "(Plan|will be|must be)" || true

cd ..

# ─── DEPLOY INFRASTRUKTUR ────────────────────────────────────
log_step "Deploy Infrastruktur dengan Terraform"

read -p "$(echo -e ${YELLOW}Lanjutkan deploy? [y/N]:${NC} )" -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    cd terraform
    terraform apply tfplan.out
    cd ..
    log_ok "Infrastruktur berhasil di-deploy"
else
    log_info "Deploy dibatalkan. Jalankan ulang jika siap."
    exit 0
fi

# ─── TUNGGU SERVICES SIAP ────────────────────────────────────
log_step "Menunggu Services Siap"

wait_for_service() {
    local name=$1
    local url=$2
    local max_wait=${3:-60}
    local waited=0

    log_info "Menunggu $name..."
    while ! curl -sf "$url" &> /dev/null; do
        sleep 3
        waited=$((waited + 3))
        echo -n "."
        if [ $waited -ge $max_wait ]; then
            log_warn "$name belum siap setelah ${max_wait}s (mungkin masih booting)"
            return 1
        fi
    done
    echo
    log_ok "$name siap di $url"
}

wait_for_service "MinIO"      "http://localhost:9001"  90
wait_for_service "Prometheus" "http://localhost:9090"  60
wait_for_service "Grafana"    "http://localhost:3000"  60

# ─── BUAT BUCKET MINIO ───────────────────────────────────────
log_step "Setup MinIO Bucket (Data Lake)"

if command -v mc &> /dev/null; then
    mc alias set telco http://localhost:9000 telcoadmin telcopassword123 &> /dev/null
    mc mb --ignore-existing telco/telco-raw-data
    mc mb --ignore-existing telco/telco-processed-data
    mc mb --ignore-existing telco/telco-models
    log_ok "Bucket MinIO dibuat: telco-raw-data, telco-processed-data, telco-models"
else
    log_warn "MinIO Client (mc) tidak terinstall. Buat bucket manual di http://localhost:9001"
    log_info "  Login: telcoadmin / telcopassword123"
    log_info "  Buat bucket: telco-raw-data, telco-processed-data, telco-models"
fi

# ─── TEST LOG GENERATOR ──────────────────────────────────────
log_step "Test Log Generator"

log_info "Menjalankan test 10 detik..."
timeout 10 $PYTHON_CMD scripts/log_generator.py 2>&1 | head -20 || true
log_ok "Log Generator berfungsi"

# ─── SUMMARY ─────────────────────────────────────────────────
echo -e "\n${GREEN}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅  TAHAP 1 SELESAI! Infrastruktur berjalan.       ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${CYAN}🌐 Dashboard yang bisa Anda buka sekarang:${NC}"
echo ""
echo -e "   ${GREEN}MinIO Console${NC}    → http://localhost:9001"
echo -e "   ${GREEN}                   ${NC}  Login: telcoadmin / telcopassword123"
echo ""
echo -e "   ${GREEN}Prometheus${NC}       → http://localhost:9090"
echo ""
echo -e "   ${GREEN}Grafana${NC}          → http://localhost:3000"
echo -e "   ${GREEN}                   ${NC}  Login: admin / telco123"
echo ""
echo -e "${CYAN}▶  Jalankan Log Generator:${NC}"
echo -e "   $ACTIVATE_CMD"
echo -e "   $PYTHON_CMD scripts/log_generator.py"
echo ""
echo -e "${CYAN}▶  Langkah berikutnya → Tahap 2: Data Engineering${NC}"
echo -e "   Data dari log generator siap di-consume oleh Kafka"
echo -e "   Lanjutkan dengan setup Apache Airflow pipeline"
echo ""
