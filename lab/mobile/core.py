"""Launch actual Open5GS 5GC functions from native YAML in an isolated namespace."""
import json
import os
import signal
import subprocess
import time
from pathlib import Path

import pymongo
import yaml

FUNCTIONS = ("nrf", "scp", "amf", "smf", "upf", "ausf", "udm", "udr", "pcf", "nssf", "bsf")
prefix = Path("/opt/open5gs")
config = prefix / "etc/open5gs"
config.mkdir(parents=True, exist_ok=True)
for function in FUNCTIONS:
    source = config / f"{function}.yaml"
    declared = Path(f"/lab/config/mobile/{function}.yaml")
    data = yaml.safe_load((declared if declared.exists() else source).read_text(encoding="utf-8"))
    # Runtime defaults come from the pinned upstream build; local overrides are explicit native config.
    if "db_uri" in data:
        data["db_uri"] = "mongodb://mobile-mongo/open5gs"
    settings = data[function]
    if function == "nrf":
        settings["serving"] = [{"plmn_id": {"mcc": "001", "mnc": "01"}}]
    if function == "amf":
        settings["ngap"]["server"] = [{"address": "172.28.80.50"}]
        for item in settings["guami"] + settings["tai"] + settings["plmn_support"]:
            item["plmn_id"] = {"mcc": "001", "mnc": "01"}
        settings["plmn_support"][0]["s_nssai"] = [{"sst": 1, "sd": "000001"}]
    if function == "smf":
        settings["session"] = [{"subnet": "10.45.0.0/16", "gateway": "10.45.0.1", "dnn": "internet"}]
    if function == "upf":
        settings["gtpu"]["server"] = [{"address": "172.28.80.50"}]
        settings["session"] = [{"subnet": "10.45.0.0/16", "gateway": "10.45.0.1", "dnn": "internet", "dev": "ogstun"}]
    if function in ("amf", "smf", "upf"):
        settings["metrics"] = {"server": [{"address": "172.28.80.50", "port": {"amf": 9090, "smf": 9091, "upf": 9092}[function]}]}
    data["logger"] = {"file": {"path": f"/lab/logs/{function}.log"}, "level": "info"}
    source.write_text(yaml.safe_dump(data, sort_keys=False))
subprocess.run(["ip", "tuntap", "add", "name", "ogstun", "mode", "tun"], check=True)
subprocess.run(["ip", "addr", "add", "10.45.0.1/16", "dev", "ogstun"], check=True)
subprocess.run(["ip", "link", "set", "ogstun", "up"], check=True)
subprocess.run(["ip", "route", "replace", "10.90.0.0/24", "via", "172.28.80.2"], check=True)
subprocess.run(["iptables", "-t", "nat", "-A", "POSTROUTING", "-s", "10.45.0.0/16", "!", "-o", "ogstun", "-j", "MASQUERADE"], check=True)
Path("/lab/logs").mkdir(parents=True, exist_ok=True)
client = pymongo.MongoClient("mongodb://mobile-mongo/open5gs", serverSelectionTimeoutMS=5000)
deadline = time.monotonic() + 60
while True:
    try:
        client.admin.command("ping")
        break
    except pymongo.errors.PyMongoError:
        if time.monotonic() >= deadline:
            raise
        time.sleep(2)
subscriber = json.loads(Path("/lab/config/mobile/subscriber.json").read_text())
existing = client.open5gs.subscribers.find_one({"imsi": subscriber["imsi"]})
if not existing:
    client.open5gs.subscribers.insert_one(subscriber)
elif existing["security"]["k"] != subscriber["security"]["k"]:
    raise RuntimeError("Existing subscriber has a different lab authentication key")
processes = []
def stop(*_):
    for process in processes:
        process.terminate()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
for function in FUNCTIONS:
    processes.append(subprocess.Popen([str(prefix / f"bin/open5gs-{function}d"), "-c", str(config / f"{function}.yaml")]))
while all(process.poll() is None for process in processes):
    time.sleep(1)
stop()
raise SystemExit("A core function exited; inspect actual logs before session testing")
