"""Render the executable virtual-site lab; keep generated credentials out of Git."""
import json
import ipaddress
import os
import secrets
import shutil
import subprocess
from pathlib import Path

import yaml
from scripts.check_portfolio import validate

ROOT = Path(__file__).resolve().parents[1]
LAB = ROOT / "lab"


def write(relative, value):
    path = LAB / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8", newline="\n")


def site_config(site, index):
    management = str(ipaddress.ip_network(site["management"]).network_address + 1)
    return "\n".join([
        "frr defaults traditional", f"hostname {site['id']}", "service integrated-vtysh-config", "!",
        "ip prefix-list LOCAL seq 10 permit " + site["service"],
        f"ip prefix-list LOCAL seq 20 permit {management}/32",
        "ip prefix-list CORE seq 10 permit 10.90.0.0/24",
        "route-map PRIMARY permit 10", " match ip address prefix-list CORE", " set local-preference 100",
        "route-map SECONDARY permit 10", " match ip address prefix-list CORE", " set local-preference 80",
        "route-map EXPORT permit 10", " match ip address prefix-list LOCAL", f"router bgp {site['asn']}",
        f" bgp router-id {management}",
        f" neighbor 10.250.0.1 remote-as 65100", f" neighbor 10.251.0.1 remote-as 65200",
        " address-family ipv4 unicast", f"  network {site['service']}", f"  network {management}/32",
        "  neighbor 10.250.0.1 route-map PRIMARY in", "  neighbor 10.251.0.1 route-map SECONDARY in",
        "  neighbor 10.250.0.1 route-map EXPORT out", "  neighbor 10.251.0.1 route-map EXPORT out",
        " exit-address-family", "!", "line vty", "",])


def core_config(sites, secondary):
    subnet, asn = (251, 65200) if secondary else (250, 65100)
    lines = ["frr defaults traditional", f"hostname core-{'backup' if secondary else 'primary'}",
             "service integrated-vtysh-config", "ip prefix-list EXPORT seq 10 permit 10.90.0.0/24",
             *[f"ip prefix-list SITES seq {10*index} permit {site['service']}" for index, site in enumerate(sites, 1)],
             *[f"ip prefix-list SITES seq {100+10*index} permit {ipaddress.ip_network(site['management']).network_address+1}/32" for index, site in enumerate(sites, 1)],
             "route-map IMPORT permit 10", " match ip address prefix-list SITES",
             "route-map EXPORT permit 10", " match ip address prefix-list EXPORT", f"router bgp {asn}",
             f" bgp router-id 10.90.0.{2 if secondary else 1}"]
    for index, site in enumerate(sites, 1):
        lines += [f" neighbor 10.{subnet}.0.{10 + index} remote-as {site['asn']}"]
    lines += [" address-family ipv4 unicast", "  network 10.90.0.0/24"]
    for index, site in enumerate(sites, 1):
        lines += [f"  neighbor 10.{subnet}.0.{10 + index} route-map IMPORT in",
                  f"  neighbor 10.{subnet}.0.{10 + index} route-map EXPORT out"]
    return "\n".join(lines + [" exit-address-family", "!", "line vty", ""])


def render(catalog):
    sites = catalog["sites"]
    services, networks, volumes = {}, {}, {}
    for name, subnet in {"management": "172.28.80.0/24", "primary": "10.250.0.0/24",
                         "backup": "10.251.0.0/24", "service": "10.90.0.0/24"}.items():
        networks[name] = {"internal": True, "ipam": {"config": [{"subnet": subnet, "gateway": str(ipaddress.ip_network(subnet).broadcast_address - 1)}]}}
    def address(value):
        return {"ipv4_address": value}
    def node(name, role, ip, links, environment=None, config=None):
        spec = {"build": {"context": "..", "dockerfile": "lab/router/Dockerfile"}, "image": "strata-lab-router:local",
                "hostname": name, "cap_add": ["NET_ADMIN", "NET_RAW"], "mem_limit": "96m",
                "environment": {"LAB_ROLE": role, **(environment or {})},
                "volumes": ["./runtime/ssh/id_ed25519.pub:/lab/authorized_keys:ro", f"lab-host-keys-{name}:/lab/host-keys"],
                "networks": {"management": address(ip), **links},
                "healthcheck": {"test": ["CMD", "python3", "-c", "import socket; socket.create_connection(('127.0.0.1',22),2).close()"],
                                "interval": "10s", "timeout": "3s", "retries": 12}}
        if config:
            spec["volumes"].append(f"./config/frr/{config}:/lab/frr.conf:ro")
            spec["sysctls"] = {"net.ipv4.ip_forward": "1", "net.ipv4.conf.all.rp_filter": "0", "net.ipv4.conf.default.rp_filter": "0"}
        services[name] = spec
        volumes[f"lab-host-keys-{name}"] = {}
    for index, site in enumerate(sites, 1):
        short = site["id"].split("-")[0].lower()
        service = ipaddress.ip_network(site["service"])
        management = ipaddress.ip_network(site["management"])
        networks[f"site-{short}"] = {"internal": True, "ipam": {"config": [{"subnet": f"10.254.{index}.0/24", "gateway": f"10.254.{index}.254"}]}}
        node(f"{short}-router", "router", f"172.28.80.{10+index}",
             {"primary": address(f"10.250.0.{10+index}"), "backup": address(f"10.251.0.{10+index}"),
              f"site-{short}": address(f"10.254.{index}.10")},
             {"CARRIER_IP": f"10.254.{index}.10", "VLAN_ID": str(site["service_vlan"]),
              "SERVICE_IP": f"{service.network_address+1}/{service.prefixlen}", "MANAGEMENT_LOOPBACK": f"{management.network_address+1}/32",
              "PRIMARY_IP": f"10.250.0.{10+index}"}, f"{short}.conf")
        node(f"{short}-client", "client", f"172.28.80.{20+index}", {f"site-{short}": address(f"10.254.{index}.20")},
             {"CARRIER_IP": f"10.254.{index}.20", "VLAN_ID": str(site["service_vlan"]),
              "SERVICE_IP": f"{service.network_address+2}/{service.prefixlen}", "SERVICE_GATEWAY": str(service.network_address+1)})
        write(f"config/frr/{short}.conf", site_config(site, index))
    for secondary in (False, True):
        name, transit, service_ip, ip = ("core-backup", "backup", "10.90.0.2", "172.28.80.3") if secondary else ("core-primary", "primary", "10.90.0.1", "172.28.80.2")
        node(name, "router", ip, {transit: address("10.251.0.1" if secondary else "10.250.0.1"), "service": address(service_ip)}, config=f"{name}.conf")
        write(f"config/frr/{name}.conf", core_config(sites, secondary))
    node("traffic-server", "server", "172.28.80.4", {"service": address("10.90.0.10")},
         {"SITE_PREFIXES": ",".join(site["service"] for site in sites)})
    services["lab-controller"] = {"build": {"context": "..", "dockerfile": "lab/automation/Dockerfile"},
        "mem_limit": "320m", "ports": ["127.0.0.1:8084:8084"], "env_file": ".env",
        "environment": {"LAB_PIPELINE_ENABLED": "${LAB_PIPELINE_ENABLED:-false}", "LAB_NETBOX_ENABLED": "${LAB_NETBOX_ENABLED:-false}"},
        "volumes": ["./config:/lab/config:ro", "./runtime/ssh:/lab/ssh:ro", "lab-evidence:/lab/evidence"],
        "networks": ["management"], "depends_on": {f"{site['id'].split('-')[0].lower()}-router": {"condition": "service_healthy"} for site in sites}}
    app_env = {"KAFKA_BOOTSTRAP_SERVERS": "kafka:9092", "MINIO_ENDPOINT": "http://minio:9000",
        "INTEGRATION_HUB_URL": "http://integration-hub:8082", "MODEL_API_URL": "http://127.0.0.1:1",
        "AIOPS_STATE_DB": "/app/data/integrations.sqlite", "CONNECTORS_FILE": "/app/config/connectors.yml",
        "NETBOX_ENABLED": "${LAB_NETBOX_ENABLED:-false}", "NETBOX_URL": "http://netbox:8080",
        "PROMETHEUS_URL": "http://prometheus:9090", "GRAFANA_URL": "http://grafana:3000",
        "STORAGE_METRICS_URL": "http://consumer:9101", "PREDICTOR_METRICS_URL": "http://predictor:9102",
        "STORAGE_BATCH_SIZE": "32", "STORAGE_BATCH_SECONDS": "5", "CONNECTOR_POLL_SECONDS": "10",
        "INCIDENT_CONFIRMATIONS": "2", "RECOVERY_CONFIRMATIONS": "2", "AI_ENABLED": "false"}
    def app(name, command, **extra):
        services[name] = {"build": "..", "image": "strata-lab-app:local", "profiles": ["data"], "env_file": ".env",
                          "environment": app_env.copy(), "command": command, "networks": ["management"], "mem_limit": "512m", **extra}
    services["kafka"] = {"image": "apache/kafka:3.9.1", "profiles": ["data"], "mem_limit": "768m",
        "environment": {"KAFKA_NODE_ID": 1, "KAFKA_PROCESS_ROLES": "broker,controller",
          "KAFKA_LISTENERS": "PLAINTEXT://:9092,CONTROLLER://:9093", "KAFKA_ADVERTISED_LISTENERS": "PLAINTEXT://kafka:9092",
          "KAFKA_CONTROLLER_LISTENER_NAMES": "CONTROLLER", "KAFKA_LISTENER_SECURITY_PROTOCOL_MAP": "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT",
          "KAFKA_CONTROLLER_QUORUM_VOTERS": "1@kafka:9093", "KAFKA_INTER_BROKER_LISTENER_NAME": "PLAINTEXT",
          "KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR": 1, "KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR": 1,
          "KAFKA_TRANSACTION_STATE_LOG_MIN_ISR": 1, "KAFKA_AUTO_CREATE_TOPICS_ENABLE": "false",
          "KAFKA_HEAP_OPTS": "-Xms256m -Xmx512m", "KAFKA_LOG_DIRS": "/var/lib/kafka/data"},
        "networks": ["management"], "volumes": ["lab-kafka:/var/lib/kafka/data"],
        "healthcheck": {"test": ["CMD", "/opt/kafka/bin/kafka-topics.sh", "--bootstrap-server", "localhost:9092", "--list"], "interval": "10s", "timeout": "10s", "retries": 18}}
    topic_command = "for topic in telco.network.metrics telco.network.dead-letter telco.network.predictions strata.lab.changes; do /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --create --if-not-exists --topic \"$topic\" --partitions 1 --replication-factor 1; done"
    services["kafka-init"] = {"image": "apache/kafka:3.9.1", "profiles": ["data"], "networks": ["management"],
        "entrypoint": ["/bin/bash", "-ec", topic_command.replace("$topic", "$$topic")],
        "depends_on": {"kafka": {"condition": "service_healthy"}}, "restart": "no"}
    services["minio"] = {"build": {"context": "..", "dockerfile": "lab/storage/Dockerfile"}, "image": "strata-minio-community:local", "profiles": ["data"], "mem_limit": "384m",
        "command": ["server", "/data", "--console-address", ":9001"], "env_file": ".env",
        "environment": {"MINIO_ROOT_USER": "${MINIO_ACCESS_KEY}", "MINIO_ROOT_PASSWORD": "${MINIO_SECRET_KEY}"},
        "ports": ["127.0.0.1:19000:9000", "127.0.0.1:19001:9001"], "networks": ["management"], "volumes": ["lab-minio:/data"]}
    app("minio-init", ["python", "-m", "scripts.bootstrap_storage"], depends_on=["minio"], restart="no")
    app("integration-hub", ["python", "-m", "integrations.hub"], ports=["127.0.0.1:18082:8082"],
        volumes=["lab-hub:/app/data", "../config:/app/config:ro"], depends_on={"kafka-init": {"condition": "service_completed_successfully"}})
    dependencies = {"kafka-init": {"condition": "service_completed_successfully"}, "minio-init": {"condition": "service_completed_successfully"}}
    app("consumer", ["python", "-m", "consumer.kafka_to_minio"], depends_on=dependencies, restart="unless-stopped")
    app("predictor", ["python", "-m", "predictor.auto_predictor"], depends_on={"kafka-init": {"condition": "service_completed_successfully"}}, restart="unless-stopped")
    services["prometheus"] = {"image": "prom/prometheus:v3.2.1", "profiles": ["monitoring"], "mem_limit": "256m",
        "command": ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.retention.time=2d"],
        "ports": ["127.0.0.1:19090:9090"], "volumes": ["./config/prometheus.yml:/etc/prometheus/prometheus.yml:ro", "lab-prometheus:/prometheus"], "networks": ["management"]}
    services["grafana"] = {"image": "grafana/grafana:11.6.0", "profiles": ["monitoring"], "mem_limit": "256m",
        "ports": ["127.0.0.1:13000:3000"], "env_file": ".env", "environment": {"GF_SECURITY_ADMIN_PASSWORD": "${GRAFANA_ADMIN_PASSWORD}", "GF_USERS_ALLOW_SIGN_UP": "false"},
        "volumes": ["./config/grafana:/etc/grafana/provisioning:ro", "lab-grafana:/var/lib/grafana"], "networks": ["management"]}
    services["netbox-postgres"] = {"image": "postgres:17-alpine", "profiles": ["inventory"], "mem_limit": "256m",
        "env_file": ".env", "environment": {"POSTGRES_DB": "netbox", "POSTGRES_USER": "netbox", "POSTGRES_PASSWORD": "${NETBOX_DB_PASSWORD}"},
        "volumes": ["lab-netbox-db:/var/lib/postgresql/data"], "networks": ["management"],
        "healthcheck": {"test": ["CMD", "pg_isready", "-U", "netbox"], "interval": "10s", "retries": 10}}
    services["netbox-redis"] = {"image": "valkey/valkey:8.0-alpine", "profiles": ["inventory"], "mem_limit": "128m",
        "command": ["valkey-server", "--requirepass", "${NETBOX_REDIS_PASSWORD}"], "networks": ["management"], "volumes": ["lab-netbox-redis:/data"]}
    services["netbox"] = {"image": "netboxcommunity/netbox:v4.2-3.2.0", "profiles": ["inventory"], "mem_limit": "1024m",
        "env_file": ".env", "ports": ["127.0.0.1:18000:8080"], "networks": ["management"],
        "environment": {"DB_HOST": "netbox-postgres", "DB_NAME": "netbox", "DB_USER": "netbox", "DB_PASSWORD": "${NETBOX_DB_PASSWORD}",
          "REDIS_HOST": "netbox-redis", "REDIS_CACHE_HOST": "netbox-redis", "REDIS_PASSWORD": "${NETBOX_REDIS_PASSWORD}",
          "REDIS_CACHE_PASSWORD": "${NETBOX_REDIS_PASSWORD}", "REDIS_DATABASE": 0, "REDIS_CACHE_DATABASE": 1,
          "SECRET_KEY": "${NETBOX_SECRET_KEY}", "ALLOWED_HOSTS": "netbox localhost 127.0.0.1", "SKIP_SUPERUSER": "true", "METRICS_ENABLED": "true", "CENSUS_REPORTING_ENABLED": "false"},
        "volumes": ["./config:/lab/config:ro", "./automation/seed_netbox.py:/lab/seed_netbox.py:ro", "lab-netbox-media:/opt/netbox/netbox/media"],
        "depends_on": {"netbox-postgres": {"condition": "service_healthy"}, "netbox-redis": {"condition": "service_started"}},
        "healthcheck": {"test": ["CMD", "curl", "-f", "http://localhost:8080/login/"], "interval": "15s", "start_period": "90s", "retries": 20}}
    for name in ("lab-evidence", "lab-kafka", "lab-minio", "lab-hub", "lab-prometheus", "lab-grafana", "lab-netbox-db", "lab-netbox-redis", "lab-netbox-media"):
        volumes[name] = {}
    from scripts.render_lab_mobile import render as mobile
    mobile(services, volumes, write)
    write("compose.yml", yaml.safe_dump({"name": "strata-engineering-lab", "services": services, "networks": networks, "volumes": volumes}, sort_keys=False))
    write("config/sites.json", json.dumps(sites, indent=2) + "\n")
    write("config/prometheus.yml", yaml.safe_dump({"global": {"scrape_interval": "10s"}, "scrape_configs": [
        {"job_name": "lab-controller", "static_configs": [{"targets": ["lab-controller:8084"]}]},
        {"job_name": "integration-hub", "static_configs": [{"targets": ["integration-hub:8082"]}]},
        {"job_name": "storage", "static_configs": [{"targets": ["consumer:9101"]}]},
        {"job_name": "predictor", "static_configs": [{"targets": ["predictor:9102"]}]}]}, sort_keys=False))
    write("config/grafana/datasources/lab.yml", yaml.safe_dump({"apiVersion": 1, "datasources": [{"name": "Lab Prometheus", "uid": "lab-prometheus", "type": "prometheus", "url": "http://prometheus:9090", "access": "proxy", "isDefault": True}]}, sort_keys=False))


def prepare_credentials():
    env_file = LAB / ".env"
    if not env_file.exists():
        values = {key: secrets.token_hex(length) for key, length in {"LAB_API_TOKEN": 24, "INTEGRATION_API_TOKEN": 24,
            "NETBOX_TOKEN": 20, "NETBOX_SECRET_KEY": 32, "NETBOX_DB_PASSWORD": 16, "NETBOX_REDIS_PASSWORD": 16,
            "NETBOX_ADMIN_PASSWORD": 16, "MINIO_SECRET_KEY": 24, "GRAFANA_ADMIN_PASSWORD": 16}.items()}
        values.update({"MINIO_ACCESS_KEY": "strata-lab", "LAB_PIPELINE_ENABLED": "false", "LAB_NETBOX_ENABLED": "false"})
        write(".env", "\n".join(f"{key}={value}" for key, value in values.items()) + "\n")
        os.chmod(env_file, 0o600)
    key = LAB / "runtime/ssh/id_ed25519"
    if not key.exists():
        executable = shutil.which("ssh-keygen")
        if not executable:
            raise SystemExit("Install OpenSSH client/ssh-keygen, then rerun preparation. Existing credentials were preserved.")
        key.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([executable, "-q", "-t", "ed25519", "-N", "", "-C", "strata-isolated-lab", "-f", str(key)], check=True)
    print("Generated lab credentials/SSH identity are stored privately; existing credentials were preserved.")


def main():
    catalog = json.loads((ROOT / "lab/reference/software-catalog.json").read_text(encoding="utf-8"))
    validate(catalog)
    render(catalog)
    prepare_credentials()
    print("Rendered lab/compose.yml, actual FRR configurations, VLAN site plans and monitoring configuration.")
    print("Container execution is separate: use python -m scripts.lab doctor, then up/verify.")


if __name__ == "__main__":
    main()
