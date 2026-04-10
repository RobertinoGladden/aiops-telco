#!/usr/bin/env python3
"""
================================================================
TELCO AIOPS — Tahap 3: ML Training dengan MLflow
Fungsi: Ambil data dari MinIO → Train model anomaly detection
        → Simpan model ke MLflow + MinIO

Model: Isolation Forest (unsupervised) + Random Forest (supervised)
       Keduanya cocok untuk time-series anomaly detection Telco

Jalankan: python model/train.py
================================================================
"""

# ─── FIX IPv4 Windows ───────────────────────────────────────
import socket
_orig = socket.getaddrinfo
def _ipv4(host, port, *a, **kw):
    r = _orig(host, port, *a, **kw)
    v4 = [x for x in r if x[0] == socket.AF_INET]
    return v4 if v4 else r
socket.getaddrinfo = _ipv4
# ────────────────────────────────────────────────────────────

import io
import logging
import warnings
warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import boto3
from botocore.client import Config
import mlflow
import mlflow.sklearn
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import (
    classification_report, f1_score,
    precision_score, recall_score, roc_auc_score
)
import joblib

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# ─── KONFIGURASI ────────────────────────────────────────────
MINIO_ENDPOINT   = "http://127.0.0.1:9000"
MINIO_ACCESS_KEY = "telcoadmin"
MINIO_SECRET_KEY = "telcopassword123"
BUCKET_PROC      = "telco-processed-data"
BUCKET_MODELS    = "telco-models"

MLFLOW_TRACKING_URI = "http://127.0.0.1:5000"

# Features yang dipakai model
FEATURE_COLS = [
    "latency_ms", "packet_loss_pct", "cpu_usage_pct",
    "throughput_mbps", "signal_strength_dbm", "error_rate",
    "latency_ms_rolling5", "packet_loss_pct_rolling5",
    "cpu_usage_pct_rolling5", "latency_ms_zscore",
    "cpu_usage_pct_zscore", "hour", "dayofweek", "is_critical",
]
LABEL_COL = "is_anomaly"


# ─── LOAD DATA DARI MINIO ───────────────────────────────────
def load_data_from_minio() -> pd.DataFrame:
    """Ambil semua file Parquet dari MinIO dan gabungkan."""
    client = boto3.client(
        "s3",
        endpoint_url=MINIO_ENDPOINT,
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )

    log.info("📥 Mengambil data dari MinIO...")
    response = client.list_objects_v2(
        Bucket=BUCKET_PROC, Prefix="features/"
    )
    files = response.get("Contents", [])

    if not files:
        raise RuntimeError(
            "❌ Tidak ada data di MinIO!\n"
            "   Pastikan kafka_to_minio.py sudah jalan minimal 1 menit."
        )

    dfs = []
    for f in files:
        try:
            obj = client.get_object(Bucket=BUCKET_PROC, Key=f["Key"])
            dfs.append(pd.read_parquet(io.BytesIO(obj["Body"].read())))
        except Exception as e:
            log.warning(f"Skip {f['Key']}: {e}")

    df = pd.concat(dfs, ignore_index=True)
    log.info(f"✅ Data loaded: {len(df):,} baris, {len(df.columns)} kolom")
    log.info(f"   Anomali: {df[LABEL_COL].sum():,} ({df[LABEL_COL].mean()*100:.1f}%)")
    return df


# ─── PREPROCESSING ──────────────────────────────────────────
def preprocess(df: pd.DataFrame):
    """Siapkan features dan label untuk training."""
    # Pilih hanya kolom yang tersedia
    available = [c for c in FEATURE_COLS if c in df.columns]
    missing   = [c for c in FEATURE_COLS if c not in df.columns]
    if missing:
        log.warning(f"Kolom tidak tersedia (skip): {missing}")

    X = df[available].fillna(0)
    y = df[LABEL_COL].astype(int)

    log.info(f"   Features dipakai: {available}")
    log.info(f"   Shape: X={X.shape}, y={y.shape}")

    # Normalisasi
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    return X_scaled, y.values, scaler, available


# ─── TRAIN: ISOLATION FOREST (Unsupervised) ─────────────────
def train_isolation_forest(X_train, X_test, y_test):
    """
    Isolation Forest: deteksi anomali TANPA label.
    Berguna untuk kasus baru yang belum pernah dilihat model.
    """
    log.info("\n🌲 Training Isolation Forest...")

    model = IsolationForest(
        n_estimators=100,
        contamination=0.15,   # Estimasi 15% anomali
        random_state=42,
        n_jobs=-1,
    )
    model.fit(X_train)

    # Prediksi: -1 = anomali, 1 = normal → konversi ke 0/1
    y_pred = (model.predict(X_test) == -1).astype(int)

    f1  = f1_score(y_test, y_pred)
    prec = precision_score(y_test, y_pred)
    rec  = recall_score(y_test, y_pred)

    log.info(f"   F1 Score  : {f1:.4f}")
    log.info(f"   Precision : {prec:.4f}")
    log.info(f"   Recall    : {rec:.4f}")

    return model, {"f1": f1, "precision": prec, "recall": rec}


# ─── TRAIN: RANDOM FOREST (Supervised) ──────────────────────
def train_random_forest(X_train, X_test, y_train, y_test, feature_names):
    """
    Random Forest: deteksi anomali DENGAN label.
    Lebih akurat tapi butuh data berlabel.
    """
    log.info("\n🌳 Training Random Forest Classifier...")

    model = RandomForestClassifier(
        n_estimators=100,
        max_depth=10,
        class_weight="balanced",   # Handle imbalanced data
        random_state=42,
        n_jobs=-1,
    )
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    y_prob = model.predict_proba(X_test)[:, 1]

    f1   = f1_score(y_test, y_pred)
    prec = precision_score(y_test, y_pred)
    rec  = recall_score(y_test, y_pred)
    auc  = roc_auc_score(y_test, y_prob)

    log.info(f"   F1 Score  : {f1:.4f}")
    log.info(f"   Precision : {prec:.4f}")
    log.info(f"   Recall    : {rec:.4f}")
    log.info(f"   ROC-AUC   : {auc:.4f}")

    # Feature importance — berguna untuk interpretasi model
    importance = pd.Series(
        model.feature_importances_, index=feature_names
    ).sort_values(ascending=False)
    log.info(f"\n   Top 5 features penting:")
    for feat, imp in importance.head(5).items():
        bar = "█" * int(imp * 40)
        log.info(f"   {feat:<35} {bar} {imp:.4f}")

    return model, {
        "f1": f1, "precision": prec, "recall": rec, "roc_auc": auc
    }


# ─── SIMPAN MODEL KE MINIO ──────────────────────────────────
def save_model_to_minio(model, scaler, feature_names, model_name):
    """Simpan model ke MinIO agar bisa diakses API server."""
    client = boto3.client(
        "s3",
        endpoint_url=MINIO_ENDPOINT,
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )

    # Simpan model
    buf = io.BytesIO()
    joblib.dump({"model": model, "scaler": scaler, "features": feature_names}, buf)
    buf.seek(0)
    key = f"latest/{model_name}.pkl"
    client.put_object(Bucket=BUCKET_MODELS, Key=key, Body=buf)
    log.info(f"💾 Model disimpan → {BUCKET_MODELS}/{key}")


# ─── MAIN ───────────────────────────────────────────────────
def main():
    log.info("=" * 60)
    log.info("TELCO AIOPS — Tahap 3: ML Training")
    log.info("=" * 60)

    # 1. Load data
    df = load_data_from_minio()

    # 2. Preprocessing
    X, y, scaler, feature_names = preprocess(df)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    log.info(f"\n📊 Split: train={len(X_train):,}  test={len(X_test):,}")

    # 3. Setup MLflow
    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    
    # Delete existing experiment if it exists to reset artifact location
    try:
        experiment = mlflow.get_experiment_by_name("telco-anomaly-detection")
        if experiment:
            mlflow.delete_experiment(experiment.experiment_id)
            log.info("🗑️  Deleted existing experiment")
    except Exception as e:
        log.warning(f"Could not delete experiment: {e}")
    
    mlflow.set_experiment("telco-anomaly-detection-v2")

    # ── Run 1: Isolation Forest ──────────────────────────────
    with mlflow.start_run(run_name="isolation_forest"):
        mlflow.log_param("model_type",     "IsolationForest")
        mlflow.log_param("n_estimators",   100)
        mlflow.log_param("contamination",  0.15)
        mlflow.log_param("train_samples",  len(X_train))
        mlflow.log_param("features",       feature_names)

        iso_model, iso_metrics = train_isolation_forest(
            X_train, X_test, y_test
        )

        mlflow.log_metrics(iso_metrics)
        mlflow.sklearn.log_model(iso_model, "isolation_forest")

        save_model_to_minio(iso_model, scaler, feature_names, "isolation_forest")
        log.info(f"✅ MLflow run selesai: {mlflow.active_run().info.run_id}")

    # ── Run 2: Random Forest ─────────────────────────────────
    with mlflow.start_run(run_name="random_forest"):
        mlflow.log_param("model_type",     "RandomForestClassifier")
        mlflow.log_param("n_estimators",   100)
        mlflow.log_param("max_depth",      10)
        mlflow.log_param("class_weight",   "balanced")
        mlflow.log_param("train_samples",  len(X_train))
        mlflow.log_param("features",       feature_names)

        rf_model, rf_metrics = train_random_forest(
            X_train, X_test, y_train, y_test, feature_names
        )

        mlflow.log_metrics(rf_metrics)
        mlflow.sklearn.log_model(rf_model, "random_forest")

        save_model_to_minio(rf_model, scaler, feature_names, "random_forest")
        log.info(f"✅ MLflow run selesai: {mlflow.active_run().info.run_id}")

    log.info("\n" + "=" * 60)
    log.info("🎉 Training selesai!")
    log.info(f"   Isolation Forest F1 : {iso_metrics['f1']:.4f}")
    log.info(f"   Random Forest F1    : {rf_metrics['f1']:.4f}")
    log.info(f"   Random Forest AUC   : {rf_metrics['roc_auc']:.4f}")
    log.info("\n▶  Buka MLflow UI : http://localhost:5000")
    log.info("▶  Lanjut jalankan: python api/model_server.py")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
