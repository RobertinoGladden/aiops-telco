"""Measure the virtual data path with ping and iperf3; no generated measurements."""
import json
import re
import subprocess
from datetime import datetime, timezone
from uuid import uuid4


def measure():
    ping = subprocess.run(["ping", "-n", "-c", "20", "-i", "0.1", "-W", "1", "10.90.0.10"],
                          capture_output=True, text=True, timeout=30)
    loss = re.search(r"([\d.]+)% packet loss", ping.stdout)
    rtt = re.search(r"= [\d.]+/([\d.]+)/", ping.stdout)
    if not loss:
        raise RuntimeError("Ping produced no parseable measurement")
    traffic = subprocess.run(["iperf3", "-c", "10.90.0.10", "-t", "2", "-J", "--connect-timeout", "3000"],
                             capture_output=True, text=True, timeout=15)
    throughput = None
    if traffic.returncode == 0:
        throughput = json.loads(traffic.stdout)["end"]["sum_received"]["bits_per_second"] / 1_000_000
    return {"event_id": str(uuid4()), "timestamp": datetime.now(timezone.utc).isoformat(),
            "packet_loss_pct": float(loss[1]), "latency_ms": float(rtt[1]) if rtt else None,
            "throughput_mbps": throughput,
            "evidence": {"ping_rc": ping.returncode, "ping_stdout": ping.stdout,
                         "iperf_rc": traffic.returncode, "iperf_stdout": traffic.stdout,
                         "iperf_stderr": traffic.stderr}}


if __name__ == "__main__":
    print(json.dumps(measure()))
