"""Prepare, run and verify actual local virtual-site workflows with Docker Compose."""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
LAB = ROOT / "lab"


def docker():
    candidates = [shutil.which("docker"), r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
                  str(Path(os.getenv("LOCALAPPDATA", "")) / "Programs/DockerDesktop/resources/bin/docker.exe")]
    return next((str(value) for value in candidates if value and Path(value).is_file()), None)


def credentials():
    path = LAB / ".env"
    if not path.exists():
        raise SystemExit("Run python -m scripts.prepare_lab first.")
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if line and not line.startswith("#"))


def compose(*arguments):
    executable = docker()
    if not executable:
        raise SystemExit("Docker is not installed. Install Docker Desktop with the WSL2/Linux container backend; then run doctor.")
    return subprocess.run([executable, "compose", "--env-file", str(LAB / ".env"), "-f", str(LAB / "compose.yml"), *arguments], cwd=ROOT, check=True)


def call(method, path, body=None):
    values = credentials()
    response = requests.request(method, "http://127.0.0.1:8084" + path, json=body,
        headers={"Authorization": "Bearer " + values["LAB_API_TOKEN"]}, timeout=240, allow_redirects=False)
    if not response.ok:
        raise SystemExit(f"Lab API rejected the operation ({response.status_code}): {response.text[:300]}")
    return response.json()


def run_change(site, action):
    candidate = call("POST", f"/sites/{site}/candidates", {"action": action, "reason": "Operator-authorized dedicated virtual-site demo"})
    job_id = candidate["id"]
    call("POST", f"/jobs/{job_id}/approve", {"reviewer": "local-lab-cli"})
    result = call("POST", f"/jobs/{job_id}/execute")
    print(f"{action}: {result['state']} · job {job_id}")
    if result["state"] not in ("verified", "experiment_applied"):
        raise SystemExit("Actual change/verification failed. Evidence was retained; inspect the job before another change.")
    return result


def doctor():
    executable = docker()
    if not executable:
        print("NOT READY: Docker CLI is absent. Configurations exist; containers have not been started.")
        print("Windows installation: https://docs.docker.com/desktop/setup/install/windows-install/")
        return 1
    result = subprocess.run([executable, "info", "--format", "{{json .}}"], capture_output=True, text=True, timeout=20)
    if result.returncode:
        print("NOT READY: Docker Engine is unavailable. Start Docker Desktop in Linux-container mode.")
        return 1
    info = json.loads(result.stdout)
    if info.get("OSType") != "linux":
        print("NOT READY: Switch Docker Desktop to Linux containers.")
        return 1
    print(f"Docker Engine ready · {info.get('ServerVersion')} · {info.get('MemTotal',0)//(1024*1024)} MiB available to Docker")
    subprocess.run([executable, "compose", "version"], check=True)
    if (LAB / ".env").exists():
        compose("--profile", "*", "config", "--quiet")
    return 0


def verify_pipeline(site, event_id):
    # This runs inside the app container so Kafka/MinIO addresses stay private.
    compose("--profile", "data", "exec", "-T", "consumer", "python", "-m", "scripts.verify_lab_pipeline", "--site", site, "--event-id", event_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "doctor", "up", "status", "down", "seed-netbox", "probe", "demo", "verify", "verify-mobile"))
    parser.add_argument("--profile", action="append", choices=("data", "inventory", "monitoring", "mobile"), default=[])
    parser.add_argument("--site", choices=("JKT-001", "BDG-001", "SBY-001"), default="JKT-001")
    parser.add_argument("--approve", action="store_true", help="Authorize the explicit isolated impairment/failover/cleanup sequence")
    args = parser.parse_args()
    if args.command == "prepare":
        from scripts.prepare_lab import main as prepare
        prepare()
    elif args.command == "doctor":
        sys.exit(doctor())
    elif args.command == "up":
        values = credentials()
        if "data" in args.profile and any(profile in args.profile for profile in ("inventory", "mobile")):
            raise SystemExit("For the 8 GB target, demonstrate data, inventory and mobile in separate runs. Stop the lab before switching profiles; volumes preserve evidence.")
        values["LAB_PIPELINE_ENABLED"] = str("data" in args.profile).lower()
        values["LAB_NETBOX_ENABLED"] = str("inventory" in args.profile).lower()
        (LAB / ".env").write_text("\n".join(f"{key}={value}" for key, value in values.items()) + "\n", encoding="utf-8")
        flags = [item for profile in args.profile for item in ("--profile", profile)]
        compose(*flags, "up", "-d", "--build", "--wait", "--wait-timeout", "300")
        print("Lab API: http://127.0.0.1:8084/docs · real Hub (data profile): http://127.0.0.1:18082")
    elif args.command == "status":
        compose("--profile", "*", "ps")
    elif args.command == "down":
        compose("--profile", "*", "down")  # Retain all evidence, database and SSH-host-key volumes.
    elif args.command == "seed-netbox":
        compose("--profile", "inventory", "exec", "-T", "netbox", "/opt/netbox/venv/bin/python", "/opt/netbox/netbox/manage.py",
                "shell", "--command", "exec(open('/lab/seed_netbox.py').read())")
    elif args.command == "verify-mobile":
        compose("--profile", "mobile", "exec", "-T", "ueransim-ue", "python3", "-c",
            "import json,subprocess; a=json.loads(subprocess.check_output(['ip','-j','-4','addr','show','uesimtun0'])); "
            "ip=a[0]['addr_info'][0]['local']; assert ip.startswith('10.45.'), 'No core-allocated UE address'; "
            "print('Actual UE session address:',ip); subprocess.run(['ping','-I','uesimtun0','-c','5','10.45.0.1'],check=True); "
            "subprocess.run(['iperf3','-B',ip,'-c','10.90.0.10','-t','3','-J'],check=True)")
    elif args.command in ("probe", "verify"):
        result = call("POST", f"/sites/{args.site}/probe")
        print(json.dumps({key: result[key] for key in ("event_id", "device_id", "timestamp", "latency_ms", "packet_loss_pct", "throughput_mbps")}, indent=2))
        if args.command == "verify":
            if result["packet_loss_pct"] > 5 or not result["throughput_mbps"] or result["latency_ms"] is None:
                raise SystemExit("Measured path checks failed; no successful verification was recorded.")
            if credentials().get("LAB_PIPELINE_ENABLED") == "true":
                verify_pipeline(args.site, result["event_id"])
    elif args.command == "demo":
        if not args.approve:
            raise SystemExit("This demo changes a dedicated lab router. Review docs/EXECUTABLE_LAB.md, then pass --approve to run the documented sequence.")
        before = call("POST", f"/sites/{args.site}/probe")
        if before["packet_loss_pct"] > 5 or not before["throughput_mbps"] or before["latency_ms"] is None:
            raise SystemExit("Baseline path is unhealthy; repair the lab before injecting an impairment.")
        output = ROOT / "data/lab-runs"
        output.mkdir(parents=True, exist_ok=True)
        report = {"source": "actual-virtual-site-lab", "site": args.site, "baseline": before, "jobs": []}
        try:
            report["jobs"].append(run_change(args.site, "impair_primary"))
            report["jobs"].append(run_change(args.site, "prefer_backup"))
        finally:
            # Clear the impairment before returning the traffic to the original path.
            report["cleanup_errors"] = []
            for action in ("clear_impairment", "restore_primary"):
                try:
                    report["jobs"].append(run_change(args.site, action))
                except (Exception, SystemExit) as error:
                    report["cleanup_errors"].append({"action": action, "error_type": type(error).__name__})
            path = output / f"{args.site}-{int(time.time())}.json"
            path.write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(f"Actual measurements and job evidence: {path}")
        if report["cleanup_errors"]:
            raise SystemExit("Lab cleanup needs review. Both cleanup actions were attempted; inspect the retained report and jobs.")
        if credentials().get("LAB_PIPELINE_ENABLED") == "true":
            verify_pipeline(args.site, report["baseline"]["event_id"])


if __name__ == "__main__":
    main()
