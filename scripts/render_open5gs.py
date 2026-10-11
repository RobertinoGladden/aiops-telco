"""Materialize the isolated lab's native Open5GS v2.7.6 configuration."""
import yaml


def render(write):
    plmn = {"mcc": "001", "mnc": "01"}
    common = {"global": {"max": {"ue": 1024}}}
    sbi = lambda address: {"server": [{"address": address, "port": 7777}],
                           "client": {"scp": [{"uri": "http://127.0.0.200:7777"}]}}
    metrics = lambda port: {"server": [{"address": "172.28.80.50", "port": port}]}
    session = {"subnet": "10.45.0.0/16", "gateway": "10.45.0.1", "dnn": "internet"}
    functions = {
        "amf": {"sbi": sbi("127.0.0.5"), "ngap": {"server": [{"address": "172.28.80.50"}]},
            "metrics": metrics(9090), "guami": [{"plmn_id": plmn, "amf_id": {"region": 2, "set": 1}}],
            "tai": [{"plmn_id": plmn, "tac": 1}],
            "plmn_support": [{"plmn_id": plmn, "s_nssai": [{"sst": 1, "sd": "000001"}]}],
            "security": {"integrity_order": ["NIA2", "NIA1", "NIA0"], "ciphering_order": ["NEA0", "NEA1", "NEA2"]},
            "network_name": {"full": "Strata Isolated Lab", "short": "Strata"}, "amf_name": "strata-amf0",
            "time": {"t3512": {"value": 540}}},
        "smf": {"sbi": sbi("127.0.0.4"),
            "pfcp": {"server": [{"address": "127.0.0.4"}], "client": {"upf": [{"address": "127.0.0.7"}]}},
            "gtpc": {"server": [{"address": "127.0.0.4"}]}, "gtpu": {"server": [{"address": "127.0.0.4"}]},
            "metrics": metrics(9091), "session": [session], "dns": ["8.8.8.8", "8.8.4.4"], "mtu": 1400,
            "freeDiameter": "/opt/open5gs/etc/freeDiameter/smf.conf"},
        "upf": {"pfcp": {"server": [{"address": "127.0.0.7"}]},
            "gtpu": {"server": [{"address": "172.28.80.50"}]},
            "session": [{**session, "dev": "ogstun"}], "metrics": metrics(9092)},
    }
    for name, settings in functions.items():
        config = {"logger": {"file": {"path": f"/lab/logs/{name}.log"}, "level": "info"}, **common, name: settings}
        write(f"config/mobile/{name}.yaml", "# Native Open5GS v2.7.6 isolated lab; not a measured or live-validated deployment.\n"
              "# Public DNS addresses are upstream defaults; the internal Docker network has no Internet egress.\n"
              + yaml.safe_dump(config, sort_keys=False))


if __name__ == "__main__":
    from pathlib import Path
    base = Path(__file__).resolve().parents[1] / "lab"
    def write(relative, body):
        path = base / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8", newline="\n")
    render(write)
