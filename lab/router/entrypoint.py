"""Set up real lab VLAN interfaces and launch FRR/SSH or traffic endpoints."""
import json
import os
import shutil
import subprocess
from pathlib import Path


def run(*argv):
    return subprocess.check_output(argv, text=True)


def interface(address):
    for item in json.loads(run("ip", "-j", "address", "show")):
        if any(value.get("local") == address for value in item["addr_info"]):
            return item["ifname"]
    raise RuntimeError("Configured carrier address is absent")


role = os.environ["LAB_ROLE"]
if os.getenv("CARRIER_IP"):
    carrier = interface(os.environ["CARRIER_IP"])
    vlan = int(os.environ["VLAN_ID"])
    if not 1 <= vlan <= 4094:
        raise ValueError("Invalid lab VLAN")
    link = f"{carrier}.{vlan}"
    run("ip", "link", "add", "link", carrier, "name", link, "type", "vlan", "id", str(vlan))
    run("ip", "address", "add", os.environ["SERVICE_IP"], "dev", link)
    run("ip", "link", "set", link, "up")
    if role == "client":
        run("ip", "route", "replace", "10.90.0.0/24", "via", os.environ["SERVICE_GATEWAY"], "dev", link)
if role == "server":
    for prefix in os.environ["SITE_PREFIXES"].split(","):
        run("ip", "route", "replace", prefix, "via", "10.90.0.1", "dev", interface("10.90.0.10"))
    subprocess.Popen(["iperf3", "-s"])
if role == "router":
    if os.getenv("MANAGEMENT_LOOPBACK"):
        run("ip", "address", "add", os.environ["MANAGEMENT_LOOPBACK"], "dev", "lo")
    shutil.copyfile("/lab/frr.conf", "/etc/frr/frr.conf")
    run("chown", "frr:frr", "/etc/frr/frr.conf")
    Path("/etc/frr/daemons").write_text("zebra=yes\nbgpd=yes\nstaticd=yes\nvtysh_enable=yes\n", encoding="utf-8")
    run("/usr/lib/frr/frrinit.sh", "start")
shutil.copyfile("/lab/authorized_keys", "/root/.ssh/authorized_keys")
os.chmod("/root/.ssh/authorized_keys", 0o600)
host_key = Path("/lab/host-keys/id_ed25519")
host_key.parent.mkdir(parents=True, exist_ok=True)
if not host_key.exists():
    run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(host_key))
os.execv("/usr/sbin/sshd", ["sshd", "-D", "-e", "-h", str(host_key)])
