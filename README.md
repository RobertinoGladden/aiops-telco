# 🛰️ Telco AIOps — Network Anomaly Predictor & Auto-Healer

<div align="center">

![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Kafka](https://img.shields.io/badge/Apache_Kafka-231F20?style=for-the-badge&logo=apache-kafka&logoColor=white)
![MinIO](https://img.shields.io/badge/MinIO-C72E49?style=for-the-badge&logo=minio&logoColor=white)
![Prometheus](https://img.shields.io/badge/Prometheus-E6522C?style=for-the-badge&logo=prometheus&logoColor=white)
![Grafana](https://img.shields.io/badge/Grafana-F46800?style=for-the-badge&logo=grafana&logoColor=white)
![MLflow](https://img.shields.io/badge/MLflow-0194E2?style=for-the-badge&logo=mlflow&logoColor=white)
![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=for-the-badge&logo=kubernetes&logoColor=white)
![Terraform](https://img.shields.io/badge/Terraform-7B42BC?style=for-the-badge&logo=terraform&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)

**An end-to-end AIOps project simulating a real-world Telecommunications network AI infrastructure.**  
From raw device logs to a self-healing network — fully automated.

[Features](#-features) • [Architecture](#-system-architecture) • [Getting Started](#-getting-started) • [Dashboards](#-dashboards) • [Tech Stack](#-tech-stack)

</div>
---

![AIOps Demo](C:\Users\lapt1\Downloads\aiops\demo.gif)

---

## 📖 Overview

**Telco AIOps** is a production-grade, end-to-end Artificial Intelligence for IT Operations (AIOps) system built for telecommunications infrastructure. It simulates a real-world environment of **50 network devices** across multiple regions and demonstrates how AI can detect anomalies and automatically trigger self-healing remediation — without human intervention.

This project covers the **full AIOps lifecycle** across 4 stages:

| Stage | Name | Technologies |
|-------|------|--------------|
| Stage 1 | Infrastructure as Code | Terraform, Ansible, Kubernetes |
| Stage 2 | Data Streaming Pipeline | Apache Kafka, MinIO, Python |
| Stage 3 | ML Model & Inference API | Scikit-learn, MLflow, FastAPI |
| Stage 4 | Observability & Auto-Healing | Prometheus, Grafana, Python |

---

## ✨ Features

- 📡 **Real-time Log Simulation** — Generates synthetic network logs from 50 simulated telecom devices (BTS, Core Routers, etc.) across multiple cities
- 🔄 **Streaming Data Pipeline** — Streams logs via Apache Kafka and stores them in MinIO (S3-compatible object storage)
- 🤖 **ML Anomaly Detection** — Trained machine learning model that scores each device for anomaly probability in real-time
- 🚨 **Auto-Remediation Engine** — Automatically executes corrective actions when a critical anomaly is detected (score = 1.0)
- 📊 **Live Observability Dashboard** — Grafana dashboard powered by Prometheus metrics for real-time network health visibility
- 🧪 **Experiment Tracking** — MLflow integration for model versioning, parameter logging, and reproducible experiments
- 🏗️ **IaC-Ready** — Full Terraform and Ansible configuration for reproducible infrastructure provisioning
- ☸️ **Kubernetes Support** — Deployable to a K8s cluster with ready-made manifests

---

## 🏗️ Project Structure

```
telco-aiops/
├── terraform/                  # Stage 1: Infrastructure as Code
│   └── main.tf                 # Provisions Kafka, MinIO, Prometheus, Grafana
├── ansible/                    # Stage 1: Automated server configuration
│   ├── setup.yml               # Main playbook
│   └── inventory.yml           # Server inventory
├── kubernetes/                 # Stage 1: Kubernetes deployment
│   └── log-generator.yaml      # K8s deployment manifest
├── scripts/                    # Stage 2: Data source simulation
│   └── log_generator.py        # Simulates 50 network devices
├── consumer/                   # Stage 2: Stream processing
│   └── kafka_to_minio.py       # Kafka consumer → MinIO storage
├── model/                      # Stage 3: Machine learning
│   └── train.py                # Model training script
├── api/                        # Stage 3: Inference server
│   └── model_server.py         # FastAPI prediction server
├── predictor/                  # Stage 4: Real-time prediction & remediation
├── monitoring/                 # Stage 4: Observability configs
├── grafana/
│   └── aiops_dashboard.json    # Pre-built Grafana dashboard
├── mlflow/                     # MLflow tracking configuration
├── docker-compose.yml          # Full local stack orchestration
├── setup.sh                    # Automated setup script
├── setup_tahap2.ps1            # Stage 2 setup (PowerShell)
├── setup_tahap3.ps1            # Stage 3 setup (PowerShell)
├── CHEATSHEET.ps1              # Quick command reference
└── README.md
```

---

## 🔧 System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       TELCO AIOPS PIPELINE                        │
└──────────────────────────────────────────────────────────────────┘

  [50 Network Devices]
  BTS / Core Routers / etc.
          │  JSON logs (real-time)
          ▼
  ┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
  │log_generator │────▶│  Apache Kafka    │────▶│    MinIO     │
  │  (Python)    │     │  (Stream Broker) │     │  (Storage)   │
  └──────────────┘     └──────────────────┘     └──────────────┘
                                                        │
                                                        ▼
                                              ┌──────────────────┐
                                              │  Model Training  │
                                              │  Scikit-learn +  │
                                              │     MLflow       │
                                              └──────────────────┘
                                                        │
                                                        ▼
  ┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
  │   Grafana    │◀────│   Prometheus     │◀────│   FastAPI    │
  │  Dashboard   │     │   (Metrics)      │     │ Model Server │
  └──────────────┘     └──────────────────┘     └──────────────┘
                                                        │
                                               ┌────────▼────────┐
                                               │ AUTO-REMEDIATION │
                                               │─────────────────│
                                               │⚡ REROUTE_TRAFFIC│
                                               │🔄 SWITCH_BACKUP  │
                                               │📈 SCALE_RESOURCES│
                                               └─────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites

Make sure the following tools are installed on your machine:

| Tool | Version | Purpose |
|------|---------|---------|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Latest | Container runtime |
| [Python](https://www.python.org/downloads/) | 3.10+ | Core language |
| [Git](https://git-scm.com/) | Latest | Version control |
| [kubectl](https://kubernetes.io/docs/tasks/tools/) *(optional)* | Latest | Kubernetes CLI |
| [Terraform](https://developer.hashicorp.com/terraform/downloads) *(optional)* | Latest | Infrastructure as Code |

---

### Stage 1 — Infrastructure Setup

#### Step 1: Clone the Repository

```bash
git clone https://github.com/RobertinoGladden/aiops-telco.git
cd aiops-telco
```

#### Step 2: Spin Up All Services with Docker Compose

```bash
docker compose up -d
```

This will start the following services:

| Service | Description | Port |
|---------|-------------|------|
| Zookeeper | Kafka coordination | 2181 |
| Apache Kafka | Message broker | 9092 |
| MinIO | Object storage | 9000 / 9001 |
| Prometheus | Metrics scraper | 9090 |
| Grafana | Visualization | 3000 |
| MLflow | Experiment tracking | 5000 |

#### Step 3: (Optional) Provision with Terraform

```bash
cd terraform
terraform init
terraform plan
terraform apply
```

#### Step 4: (Optional) Configure with Ansible

```bash
cd ansible
ansible-playbook -i inventory.yml setup.yml
```

---

### Stage 2 — Data Streaming Pipeline

#### Set Up Python Environment

```bash
python -m venv venv

# Windows
venv\Scripts\activate

# Linux / macOS
source venv/bin/activate

pip install -r requirements.txt
```

#### Run the Network Device Simulator

```bash
python scripts/log_generator.py
```

This simulates **50 network devices** sending JSON logs to Kafka topic `network-logs` in real-time.

#### Start the Kafka Consumer

```bash
python consumer/kafka_to_minio.py
```

Consumed messages are stored in MinIO for downstream processing.

---

### Stage 3 — Machine Learning Model

#### Train the Anomaly Detection Model

```bash
python model/train.py
```

Training metrics and artifacts are automatically logged to **MLflow**.

#### Start the Inference API

```bash
python api/model_server.py
```

The API will be available at `http://localhost:8000`

**Available Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/predict` | Predict anomaly score for a single device |
| `POST` | `/predict/batch` | Batch prediction for multiple devices |
| `GET`  | `/health` | Server health check |
| `GET`  | `/docs` | Interactive API docs (Swagger UI) |

---

### Stage 4 — Observability & Auto-Healing

Once the model server and predictor are running, the system will:

1. **Consume** real-time device logs from Kafka
2. **Send** data to the FastAPI model for anomaly scoring
3. **Detect** critical anomalies (score = `1.0`)
4. **Trigger** auto-remediation actions automatically

**Auto-Remediation Actions:**

| Action | Description |
|--------|-------------|
| `⚡ REROUTE_TRAFFIC` | Redirect traffic to an alternative network path |
| `🔄 SWITCH_BACKUP_LINK` | Activate the backup network link |
| `📈 SCALE_RESOURCES` | Scale up device resources to handle increased load |

---

## 🧠 Key Concepts Covered

### Infrastructure as Code (Terraform)
- Every server, network, and service is defined in code — no manual clicks
- `terraform plan` previews all changes before they are applied
- `terraform apply` provisions the entire stack in one command
- `terraform destroy` tears everything down cleanly and completely

### Configuration Management (Ansible)
- Playbooks define the desired state of each server declaratively
- **Idempotent**: run the playbook 10 times, the outcome is always the same
- Handlers trigger actions only when a meaningful change actually occurs

### Container Orchestration (Kubernetes)
- Deployments declaratively define how many replicas to keep running
- Services expose containers to the internal or external network
- `kubectl` is the unified CLI to interact with any K8s cluster

### Machine Learning Operations (MLflow)
- Automatic experiment tracking with no manual logging required
- Model versioning, artifact registry, and metadata storage
- Reproducible training runs with full parameter and metric snapshots

### Event-Driven Architecture (Kafka)
- Decouples producers (log generators) from consumers (ML pipeline)
- Handles high-throughput, real-time data streams reliably at scale
- Multiple consumers can independently process the same event stream

---

## 🛠️ Tech Stack

| Category | Technology | Purpose |
|----------|------------|---------|
| **Language** | Python 3.10+ | Core application logic |
| **Infrastructure** | Terraform | Infrastructure provisioning |
| **Configuration** | Ansible | Server configuration management |
| **Orchestration** | Kubernetes | Container orchestration |
| **Containerization** | Docker + Compose | Local development stack |
| **Streaming** | Apache Kafka | Real-time log streaming |
| **Storage** | MinIO | S3-compatible object storage |
| **ML Framework** | Scikit-learn | Anomaly detection model |
| **Experiment Tracking** | MLflow | Model versioning & tracking |
| **API** | FastAPI + Uvicorn | High-performance inference server |
| **Monitoring** | Prometheus | Metrics collection & alerting |
| **Visualization** | Grafana | Real-time dashboards |

---

## 📁 Key Files Reference

| File | Description |
|------|-------------|
| `docker-compose.yml` | Orchestrates all local services |
| `scripts/log_generator.py` | Simulates 50 network devices |
| `api/model_server.py` | FastAPI anomaly prediction server |
| `model/train.py` | Model training with MLflow tracking |
| `consumer/kafka_to_minio.py` | Kafka → MinIO ingestion pipeline |
| `grafana/aiops_dashboard.json` | Ready-to-import Grafana dashboard |
| `terraform/main.tf` | Full infrastructure definition |
| `ansible/setup.yml` | Server configuration playbook |
| `CHEATSHEET.ps1` | Quick command reference for Windows |

---

## 📄 License

This project was built for learning and portfolio purposes.  
© 2026 [RobertinoGladden](https://github.com/RobertinoGladden)

---

<div align="center">
  <sub>Built to demonstrate real-world Telco AIOps infrastructure</sub>
</div>