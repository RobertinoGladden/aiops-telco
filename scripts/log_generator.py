#!/usr/bin/env python3
"""
================================================================
TELCO AIOPS — Tahap 1: Network Log Generator
Fungsi: Mensimulasikan log dari ribuan perangkat jaringan Telco
        (BTS, router, switch) yang mengirim metrics ke Kafka
================================================================
"""

import json
import time
import random
import math
import logging
from datetime import datetime, timezone
from dataclasses import dataclass, asdict
from typing import Generator
from kafka import KafkaProducer

# ─── KONFIGURASI ────────────────────────────────────────────
KAFKA_BOOTSTRAP_SERVERS = ["127.0.0.1:29092"]
KAFKA_TOPIC = "telco.network.metrics"
SEND_INTERVAL_SECONDS = 1.0  # Kirim data setiap 1 detik

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)


# ─── MODEL DATA PERANGKAT ───────────────────────────────────
@dataclass
class NetworkDevice:
    """Representasi satu perangkat jaringan di jaringan Telco."""
    device_id: str
    device_type: str      # BTS, router, switch
    region: str
    vendor: str
    # State internal (tidak dikirim ke Kafka)
    _anomaly_chance: float = 0.02   # 2% chance anomali normal
    _in_anomaly_mode: bool = False
    _anomaly_counter: int = 0

    def generate_metrics(self) -> dict:
        """
        Generate satu baris metrics. Saat anomali terjadi,
        metrik mulai menyimpang — inilah yang akan dideteksi AI.
        """
        now = datetime.now(timezone.utc)

        # Tentukan apakah perangkat masuk mode anomali
        if not self._in_anomaly_mode:
            if random.random() < self._anomaly_chance:
                self._in_anomaly_mode = True
                self._anomaly_counter = random.randint(20, 60)
                log.warning(f"🚨 ANOMALI dimulai di {self.device_id}")
        else:
            self._anomaly_counter -= 1
            if self._anomaly_counter <= 0:
                self._in_anomaly_mode = False
                log.info(f"✅ Anomali selesai di {self.device_id}")

        # Faktor waktu: traffic lebih tinggi di jam sibuk (08-22)
        hour = now.hour
        traffic_factor = 1.0 + 0.4 * math.sin(
            math.pi * (hour - 8) / 14
        ) if 8 <= hour <= 22 else 0.6

        if self._in_anomaly_mode:
            # Metrik anomali: latency melonjak, packet loss tinggi
            severity = 1 - (self._anomaly_counter / 60)  # Makin parah
            latency_ms = random.gauss(150 + 200 * severity, 30)
            packet_loss_pct = random.gauss(5 + 15 * severity, 2)
            cpu_usage_pct = random.gauss(85 + 10 * severity, 5)
            throughput_mbps = random.gauss(
                50 * traffic_factor * (1 - 0.5 * severity), 10
            )
            signal_strength_dbm = random.gauss(-95 - 10 * severity, 3)
            error_rate = random.gauss(0.05 + 0.2 * severity, 0.01)
        else:
            # Metrik normal: stabil dengan variasi kecil
            latency_ms = random.gauss(20 * traffic_factor, 3)
            packet_loss_pct = random.gauss(0.1, 0.05)
            cpu_usage_pct = random.gauss(40 * traffic_factor, 8)
            throughput_mbps = random.gauss(200 * traffic_factor, 20)
            signal_strength_dbm = random.gauss(-75, 5)
            error_rate = random.gauss(0.001, 0.0005)

        return {
            # Identitas
            "device_id": self.device_id,
            "device_type": self.device_type,
            "region": self.region,
            "vendor": self.vendor,
            "timestamp": now.isoformat(),
            "unix_ts": now.timestamp(),

            # Metrik jaringan (inilah "bahan bakar" ML kita)
            "latency_ms": max(0, round(latency_ms, 2)),
            "packet_loss_pct": max(0, min(100, round(packet_loss_pct, 3))),
            "cpu_usage_pct": max(0, min(100, round(cpu_usage_pct, 1))),
            "throughput_mbps": max(0, round(throughput_mbps, 2)),
            "signal_strength_dbm": round(signal_strength_dbm, 1),
            "error_rate": max(0, round(error_rate, 5)),
            "active_connections": int(random.gauss(
                500 * traffic_factor, 50
            )),

            # Label ground-truth (untuk training ML)
            "is_anomaly": self._in_anomaly_mode,
            "anomaly_severity": round(
                1 - (self._anomaly_counter / 60), 2
            ) if self._in_anomaly_mode else 0.0,
        }


# ─── FLEET SIMULATOR ────────────────────────────────────────
def create_device_fleet(num_devices: int = 50) -> list[NetworkDevice]:
    """Buat armada perangkat yang mensimulasikan jaringan Telco."""
    device_types = ["BTS", "Router", "Switch", "Core-Router"]
    regions = ["Jakarta", "Surabaya", "Bandung", "Medan", "Makassar"]
    vendors = ["Huawei", "Ericsson", "Nokia", "Cisco"]

    devices = []
    for i in range(num_devices):
        dtype = random.choice(device_types)
        device = NetworkDevice(
            device_id=f"{dtype}-{regions[i % len(regions)][:3].upper()}-{i:04d}",
            device_type=dtype,
            region=random.choice(regions),
            vendor=random.choice(vendors),
        )
        # BTS punya anomaly chance lebih tinggi (lebih banyak gangguan)
        if dtype == "BTS":
            device._anomaly_chance = 0.04
        devices.append(device)

    log.info(f"✅ Fleet dibuat: {num_devices} perangkat aktif")
    return devices


# ─── KAFKA PRODUCER ─────────────────────────────────────────
def create_producer() -> KafkaProducer:
    """Buat koneksi ke Kafka dengan retry otomatis."""
    for attempt in range(10):
        try:
            producer = KafkaProducer(
                bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
                value_serializer=lambda v: json.dumps(v).encode("utf-8"),
                key_serializer=lambda k: k.encode("utf-8"),
                # Tunggu acknowledgment dari Kafka
                acks="all",
                # Retry jika gagal
                retries=3,
                linger_ms=100,       # Batch 100ms untuk efisiensi
                batch_size=16384,    # 16KB per batch
            )
            log.info("✅ Terhubung ke Kafka")
            return producer
        except Exception as e:
            log.warning(f"⏳ Mencoba koneksi Kafka (attempt {attempt+1}/10): {e}")
            time.sleep(5)
    raise RuntimeError("❌ Tidak bisa terhubung ke Kafka setelah 10 percobaan")


# ─── MAIN LOOP ──────────────────────────────────────────────
def run_generator():
    """Loop utama: generate dan kirim metrics setiap detik."""
    log.info("🚀 Telco Network Log Generator dimulai")
    log.info(f"   Topic  : {KAFKA_TOPIC}")
    log.info(f"   Server : {KAFKA_BOOTSTRAP_SERVERS}")

    devices = create_device_fleet(num_devices=50)
    producer = create_producer()

    total_sent = 0
    start_time = time.time()

    try:
        while True:
            batch_start = time.time()

            # Generate & kirim metrics dari semua perangkat
            for device in devices:
                metrics = device.generate_metrics()

                producer.send(
                    topic=KAFKA_TOPIC,
                    key=device.device_id,     # Key = device_id untuk partisi
                    value=metrics,
                )
                total_sent += 1

            producer.flush()

            # Log statistik setiap 30 detik
            elapsed = time.time() - start_time
            if int(elapsed) % 30 == 0 and int(elapsed) > 0:
                rate = total_sent / elapsed
                anomaly_devices = sum(
                    1 for d in devices if d._in_anomaly_mode
                )
                log.info(
                    f"📊 Stats: {total_sent} pesan terkirim | "
                    f"{rate:.1f} msg/s | "
                    f"{anomaly_devices} perangkat anomali aktif"
                )

            # Tunggu interval berikutnya
            elapsed_batch = time.time() - batch_start
            sleep_time = max(0, SEND_INTERVAL_SECONDS - elapsed_batch)
            time.sleep(sleep_time)

    except KeyboardInterrupt:
        log.info("🛑 Generator dihentikan oleh user")
    finally:
        producer.close()
        log.info(f"📬 Total pesan terkirim: {total_sent}")


if __name__ == "__main__":
    run_generator()
