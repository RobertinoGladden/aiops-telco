"""Bounded on-router operations for the dedicated FRR lab only."""
import argparse
import hashlib
import json
import os
import subprocess


def run(*argv):
    return subprocess.check_output(argv, text=True, timeout=20)


def primary_interface():
    expected = os.environ["PRIMARY_IP"]
    for item in json.loads(run("ip", "-j", "address", "show")):
        if any(value.get("local") == expected for value in item["addr_info"]):
            return item["ifname"]
    raise RuntimeError("Primary lab interface is absent")


def inspect():
    config = run("vtysh", "-c", "show running-config")
    return {"configuration": config, "hash": hashlib.sha256(config.encode()).hexdigest(),
            "bgp": json.loads(run("vtysh", "-c", "show bgp ipv4 unicast summary json")),
            "route": json.loads(run("vtysh", "-c", "show ip route 10.90.0.0/24 json")),
            "forwarding": json.loads(run("ip", "-j", "route", "get", "10.90.0.10")),
            "qdisc": json.loads(run("tc", "-j", "qdisc", "show", "dev", primary_interface()))}


def apply(action):
    if action in ("prefer_backup", "restore_primary"):
        preference = "200" if action == "prefer_backup" else "80"
        run("vtysh", "-c", "configure terminal", "-c", "route-map SECONDARY permit 10",
            "-c", f"set local-preference {preference}", "-c", "end", "-c", "clear bgp * soft in", "-c", "write memory")
    elif action in ("impair_primary", "clear_impairment"):
        interface = primary_interface()
        roots = [value for value in json.loads(run("tc", "-j", "qdisc", "show", "dev", interface)) if value.get("root")]
        root = roots[0] if roots else {}
        if root.get("kind", "noqueue") not in ("noqueue", "pfifo_fast", "fq_codel", "netem"):
            raise RuntimeError("Unmanaged root qdisc; refusing to replace it")
        if root.get("kind") == "netem" and root.get("handle") != "7a10:":
            raise RuntimeError("Existing netem is outside this lab experiment")
        if action == "impair_primary":
            run("tc", "qdisc", "replace", "dev", interface, "root", "handle", "7a10:", "netem", "delay", "120ms", "loss", "12%")
        elif root.get("kind") == "netem":
            run("tc", "qdisc", "del", "dev", interface, "root", "handle", "7a10:")
    else:
        raise ValueError("Unknown lab action")


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("action", choices=("inspect", "prefer_backup", "restore_primary", "impair_primary", "clear_impairment"))
args = parser.parse_args()
if os.environ.get("LAB_ROLE") != "router" or not os.environ.get("PRIMARY_IP"):
    raise RuntimeError("Only dedicated access routers accept these operations")
if args.action != "inspect":
    apply(args.action)
print(json.dumps(inspect()))
