"""Chronological evaluation with train-only scaling and optional reviewed labels."""
import io
import logging
import os
from datetime import datetime, timezone
import boto3
import joblib
import mlflow
import mlflow.sklearn
import pandas as pd
from botocore.client import Config
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.metrics import f1_score, precision_score, recall_score, roc_auc_score
from sklearn.preprocessing import StandardScaler
from aiops.config import settings
from aiops.features import FEATURE_COLS

log = logging.getLogger(__name__)


def client():
    return boto3.client("s3", endpoint_url=settings.minio_endpoint, aws_access_key_id=settings.minio_access_key,
        aws_secret_access_key=settings.minio_secret_key, region_name="us-east-1", config=Config(signature_version="s3v4"))


def load_data_from_minio():
    s3 = client()
    files = [item for page in s3.get_paginator("list_objects_v2").paginate(Bucket=settings.processed_bucket, Prefix="features/")
             for item in page.get("Contents", []) if item["Key"].endswith(".parquet")]
    files = sorted(files, key=lambda item: item["LastModified"])[-200:]
    if not files:
        raise RuntimeError("No processed data yet; run the consumer and collect telemetry first")
    frames = [pd.read_parquet(io.BytesIO(s3.get_object(Bucket=settings.processed_bucket, Key=item["Key"])["Body"].read())) for item in files]
    df = pd.concat(frames, ignore_index=True)
    if "event_id" in df:
        df = df.drop_duplicates("event_id")
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df.sort_values("timestamp")


def temporal_split(df, features):
    complete = df.dropna(subset=features).sort_values("timestamp")
    if len(complete) < 100:
        raise ValueError(f"Need at least 100 complete observations; found {len(complete)}")
    split_time = complete.iloc[int(len(complete) * 0.8)]["timestamp"]
    train = complete[complete["timestamp"] < split_time]
    test = complete[complete["timestamp"] >= split_time]
    if train.empty or test.empty:
        raise ValueError("Training requires observations across multiple timestamps")
    scaler = StandardScaler().fit(train[features])
    return train, test, scaler, scaler.transform(train[features]), scaler.transform(test[features])


def save_model_to_minio(model, scaler, features, model_name, metadata):
    buffer = io.BytesIO()
    joblib.dump({"model": model, "scaler": scaler, "features": features, "metadata": metadata}, buffer)
    content = buffer.getvalue()
    s3 = client()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    s3.put_object(Bucket=settings.models_bucket, Key=f"versions/{model_name}/{stamp}.pkl", Body=content)
    s3.put_object(Bucket=settings.models_bucket, Key=f"latest/{model_name}.pkl", Body=content)


def main():
    df = load_data_from_minio()
    features = [name.strip() for name in os.getenv("MODEL_FEATURES", ",".join(FEATURE_COLS)).split(",")]
    if not features or any(name not in FEATURE_COLS for name in features):
        raise ValueError("MODEL_FEATURES contains unsupported feature names")
    train, test, scaler, X_train, X_test = temporal_split(df, features)
    metadata = {"schema_version": "1.0", "feature_window_samples": 5, "zscore_window_samples": 50,
        "trained_at": datetime.now(timezone.utc).isoformat(), "train_rows": len(train), "test_rows": len(test),
        "train_end": str(train["timestamp"].max()), "test_start": str(test["timestamp"].min()),
        "sources": sorted(df["source"].dropna().unique().tolist()), "evaluation": "chronological"}
    mlflow.set_tracking_uri(settings.mlflow_uri)
    mlflow.set_experiment("telco-anomaly-detection-v2")
    models = [("isolation_forest", IsolationForest(n_estimators=100, contamination=0.15, random_state=42))]
    labeled_train = train.get("is_anomaly", pd.Series(index=train.index, dtype=object)).notna()
    labeled_test = test.get("is_anomaly", pd.Series(index=test.index, dtype=object)).notna()
    if labeled_train.sum() >= 20 and labeled_test.sum() >= 10 and train.loc[labeled_train, "is_anomaly"].nunique() == 2 and test.loc[labeled_test, "is_anomaly"].nunique() == 2:
        models.append(("random_forest", RandomForestClassifier(n_estimators=100, max_depth=10, class_weight="balanced", random_state=42)))
    else:
        log.warning("Random Forest skipped: insufficient labels/classes in chronological train/test; use MODEL_NAME=isolation_forest")
    for name, model in models:
        with mlflow.start_run(run_name=name):
            mlflow.log_params({"model_type": type(model).__name__, "features": features, "evaluation": "chronological", "train_samples": len(train)})
            if name == "random_forest":
                model.fit(X_train[labeled_train.values], train.loc[labeled_train, "is_anomaly"].astype(int))
            else:
                model.fit(X_train)
            if labeled_test.sum():
                truth = test.loc[labeled_test, "is_anomaly"].astype(int)
                test_values = X_test[labeled_test.values]
                predicted = model.predict(test_values)
                if name == "isolation_forest":
                    predicted = (predicted == -1).astype(int)
                metrics = {"f1": f1_score(truth, predicted, zero_division=0),
                           "precision": precision_score(truth, predicted, zero_division=0),
                           "recall": recall_score(truth, predicted, zero_division=0)}
                if name == "random_forest" and truth.nunique() == 2:
                    metrics["roc_auc"] = roc_auc_score(truth, model.predict_proba(test_values)[:, 1])
                mlflow.log_metrics(metrics)
                log.info("%s held-out metrics: %s", name, metrics)
            mlflow.sklearn.log_model(model, name=name)
            save_model_to_minio(model, scaler, features, name, metadata)
            log.info("Saved %s with %s measured features", name, len(features))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
