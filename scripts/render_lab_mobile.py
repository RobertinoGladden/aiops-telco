"""Add a separate real Open5GS/UE session profile without physical RF claims."""
import json


def render(services, volumes, write):
    from scripts.render_open5gs import render as render_open5gs
    render_open5gs(write)
    services["mobile-mongo"] = {"image": "mongo:7.0", "profiles": ["mobile"], "mem_limit": "384m",
        "networks": ["management"], "volumes": ["lab-mobile-mongo:/data/db"]}
    services["open5gs"] = {"build": {"context": "..", "dockerfile": "lab/mobile/Dockerfile.open5gs"},
        "image": "strata-open5gs:local", "profiles": ["mobile"], "mem_limit": "768m", "cap_add": ["NET_ADMIN"],
        "devices": ["/dev/net/tun:/dev/net/tun"], "sysctls": {"net.ipv4.ip_forward": "1"},
        "networks": {"management": {"ipv4_address": "172.28.80.50"}},
        "volumes": ["./config:/lab/config:ro", "lab-mobile-logs:/lab/logs"], "depends_on": ["mobile-mongo", "core-primary"]}
    common = {"build": {"context": "..", "dockerfile": "lab/mobile/Dockerfile.ueransim"},
        "image": "strata-ueransim:local", "profiles": ["mobile"], "mem_limit": "128m", "volumes": ["./config/mobile:/lab/config:ro"]}
    services["ueransim-gnb"] = {**common, "command": ["/src/build/nr-gnb", "-c", "/lab/config/gnb.yml"],
        "networks": {"management": {"ipv4_address": "172.28.80.60"}}, "depends_on": ["open5gs"], "restart": "on-failure"}
    services["ueransim-ue"] = {**common, "command": ["/src/build/nr-ue", "-c", "/lab/config/ue.yml"],
        "networks": {"management": {"ipv4_address": "172.28.80.61"}}, "devices": ["/dev/net/tun:/dev/net/tun"],
        "cap_add": ["NET_ADMIN"], "depends_on": ["ueransim-gnb"], "restart": "on-failure"}
    volumes.update({"lab-mobile-mongo": {}, "lab-mobile-logs": {}})
    import yaml
    write("config/mobile/gnb.yml", yaml.safe_dump({"mcc": "001", "mnc": "01", "nci": "0x000000010", "idLength": 32,
        "tac": 1, "linkIp": "172.28.80.60", "ngapIp": "172.28.80.60", "gtpIp": "172.28.80.60",
        "amfConfigs": [{"address": "172.28.80.50", "port": 38412}], "slices": [{"sst": 1, "sd": 1}], "ignoreStreamIds": True}, sort_keys=False))
    # Public test identity/key are deliberately lab fixtures, never operator/SIM credentials.
    key, opc = "465B5CE8B199B49FAA5F0A2EE238A6BC", "E8ED289DEBA952E4283B54E88E6183CA"
    write("config/mobile/ue.yml", yaml.safe_dump({"supi": "imsi-001010000000001", "mcc": "001", "mnc": "01",
        "protectionScheme": 0, "homeNetworkPublicKey": "", "homeNetworkPublicKeyId": 1, "routingIndicator": "0000",
        "key": key, "op": opc, "opType": "OPC", "amf": "8000", "imei": "356938035643803", "imeiSv": "4370816125816151",
        "gnbSearchList": ["172.28.80.60"], "uacAic": {"mps": False, "mcs": False},
        "uacAcc": {"normalClass": 0, **{f"class{index}": False for index in range(11,16)}},
        "sessions": [{"type": "IPv4", "apn": "internet", "slice": {"sst": 1, "sd": 1}}],
        "configured-nssai": [{"sst": 1, "sd": 1}], "default-nssai": [{"sst": 1, "sd": 1}],
        "integrity": {"IA1": True, "IA2": True, "IA3": True}, "ciphering": {"EA1": True, "EA2": True, "EA3": True},
        "integrityMaxRate": {"uplink": "full", "downlink": "full"}}, sort_keys=False))
    ambr = {"downlink": {"value": 1, "unit": 3}, "uplink": {"value": 1, "unit": 3}}
    write("config/mobile/subscriber.json", json.dumps({"imsi": "001010000000001", "security": {"k": key, "opc": opc, "op": None, "amf": "8000", "sqn": 0},
        "ambr": ambr, "slice": [{"sst": 1, "sd": "000001", "default_indicator": True,
          "session": [{"name": "internet", "type": 1, "ambr": ambr, "qos": {"index": 9, "arp": {"priority_level": 8,
            "pre_emption_capability": 1, "pre_emption_vulnerability": 1}}}]}],
        "access_restriction_data": 32, "subscriber_status": 0, "network_access_mode": 0, "subscribed_rau_tau_timer": 12}, indent=2) + "\n")
