# =============================================================
# TELCO AIOPS — Tahap 1: Infrastructure as Code (Terraform)
# Fungsi: Mendefinisikan seluruh infrastruktur sebagai kode
# =============================================================

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}

provider "docker" {
  host = "npipe:////.//pipe/docker_engine"
}

# ─── NETWORK ────────────────────────────────────────────────
# Semua container berkomunikasi dalam satu network terisolasi
resource "docker_network" "telco_net" {
  name   = "telco-aiops-network"
  driver = "bridge"

  ipam_config {
    subnet  = "172.28.0.0/16"
    gateway = "172.28.0.1"
  }
}

# ─── ZOOKEEPER (Dependency Kafka) ───────────────────────────
resource "docker_container" "zookeeper" {
  name  = "telco-zookeeper"
  image = docker_image.zookeeper.image_id

  networks_advanced {
    name         = docker_network.telco_net.name
    ipv4_address = "172.28.0.10"
  }

  env = [
    "ZOOKEEPER_CLIENT_PORT=2181",
    "ZOOKEEPER_TICK_TIME=2000"
  ]

  ports {
    internal = 2181
    external = 2181
  }

  restart = "unless-stopped"
}

# ─── KAFKA (Message Broker) ─────────────────────────────────
resource "docker_container" "kafka" {
  name  = "telco-kafka"
  image = docker_image.kafka.image_id

  networks_advanced {
    name         = docker_network.telco_net.name
    ipv4_address = "172.28.0.11"
  }

  env = [
    "KAFKA_BROKER_ID=1",
    "KAFKA_ZOOKEEPER_CONNECT=172.28.0.10:2181",
    "KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://172.28.0.11:9092,PLAINTEXT_HOST://localhost:29092",
    "KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT",
    "KAFKA_INTER_BROKER_LISTENER_NAME=PLAINTEXT",
    "KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1",
    "KAFKA_AUTO_CREATE_TOPICS_ENABLE=true"
  ]

  ports {
    internal = 9092
    external = 9092
  }
  ports {
    internal = 29092
    external = 29092
  }

  depends_on = [docker_container.zookeeper]
  restart    = "unless-stopped"
}

# ─── MINIO (Data Lake lokal, kompatibel S3) ─────────────────
resource "docker_container" "minio" {
  name  = "telco-minio"
  image = docker_image.minio.image_id

  networks_advanced {
    name         = docker_network.telco_net.name
    ipv4_address = "172.28.0.12"
  }

  env = [
    "MINIO_ROOT_USER=telcoadmin",
    "MINIO_ROOT_PASSWORD=telcopassword123"
  ]

  command = ["server", "/data", "--console-address", ":9001"]

  ports {
    internal = 9000
    external = 9000
  }
  ports {
    internal = 9001
    external = 9001
  }

  volumes {
    host_path      = "/tmp/telco-minio-data"
    container_path = "/data"
  }

  restart = "unless-stopped"
}

# ─── PROMETHEUS (Monitoring & Metrics) ──────────────────────
resource "docker_container" "prometheus" {
  name  = "telco-prometheus"
  image = docker_image.prometheus.image_id

  networks_advanced {
    name         = docker_network.telco_net.name
    ipv4_address = "172.28.0.20"
  }

  ports {
    internal = 9090
    external = 9090
  }

  volumes {
    host_path      = abspath("${path.module}/../monitoring/prometheus.yml")
    container_path = "/etc/prometheus/prometheus.yml"
    read_only      = true
  }

  restart = "unless-stopped"
}

# ─── GRAFANA (Dashboard Visualisasi) ────────────────────────
resource "docker_container" "grafana" {
  name  = "telco-grafana"
  image = docker_image.grafana.image_id

  networks_advanced {
    name         = docker_network.telco_net.name
    ipv4_address = "172.28.0.21"
  }

  env = [
    "GF_SECURITY_ADMIN_USER=admin",
    "GF_SECURITY_ADMIN_PASSWORD=telco123",
    "GF_USERS_ALLOW_SIGN_UP=false"
  ]

  ports {
    internal = 3000
    external = 3000
  }

  depends_on = [docker_container.prometheus]
  restart    = "unless-stopped"
}

# ─── IMAGES ─────────────────────────────────────────────────
resource "docker_image" "zookeeper" {
  name         = "confluentinc/cp-zookeeper:7.5.0"
  keep_locally = true
}

resource "docker_image" "kafka" {
  name         = "confluentinc/cp-kafka:7.5.0"
  keep_locally = true
}

resource "docker_image" "minio" {
  name         = "minio/minio:latest"
  keep_locally = true
}

resource "docker_image" "prometheus" {
  name         = "prom/prometheus:latest"
  keep_locally = true
}

resource "docker_image" "grafana" {
  name         = "grafana/grafana:latest"
  keep_locally = true
}

# ─── OUTPUTS ────────────────────────────────────────────────
output "services" {
  value = {
    kafka      = "localhost:29092"
    minio_api  = "http://localhost:9000"
    minio_ui   = "http://localhost:9001"
    prometheus = "http://localhost:9090"
    grafana    = "http://localhost:3000"
  }
  description = "Endpoint semua service yang berjalan"
}
