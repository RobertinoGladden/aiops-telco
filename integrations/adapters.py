"""Read-only API adapters; lab node state is topology, never fabricated telemetry."""
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import quote, urljoin, urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from aiops.contracts import NetworkMetric, utcnow


@dataclass
class PollResult:
    inventory: list[dict] = field(default_factory=list)
    telemetry: list[dict] = field(default_factory=list)
    topology: dict = field(default_factory=dict)


def env(spec: dict, key: str, required=False) -> str:
    value = os.getenv(spec.get(f"{key}_env", ""), spec.get(key, ""))
    if required and not value:
        raise ValueError(f"missing connector setting: {key}")
    return value


def named(value, default="unknown"):
    return (value.get("name") or value.get("label") or default) if isinstance(value, dict) else (value or default)


class Adapter:
    def __init__(self, spec, session=None):
        self.spec = spec
        self.name = spec["name"]
        self.url = env(spec, "url", required=True).rstrip("/")
        if urlparse(self.url).scheme not in ("http", "https"):
            raise ValueError("connector URL requires http or https")
        self.session = session or requests.Session()
        if session is None:
            retry = Retry(total=2, backoff_factor=0.5, status_forcelist=[429, 502, 503, 504], allowed_methods=["GET"])
            self.session.mount("http://", HTTPAdapter(max_retries=retry))
            self.session.mount("https://", HTTPAdapter(max_retries=retry))
        self.timeout = float(spec.get("timeout_seconds", 10))
        token = env(spec, "token")
        if token:
            scheme = spec.get("auth_scheme", "bearer")
            if scheme == "auto":
                scheme = "bearer" if token.startswith("nbt_") else "token"
            if scheme == "x-auth-token":
                self.session.headers["X-Auth-Token"] = token
            else:
                self.session.headers["Authorization"] = f"{'Token' if scheme == 'token' else 'Bearer'} {token}"
        user = env(spec, "username")
        if user and spec["kind"] != "eve_ng":
            self.session.auth = (user, env(spec, "password", required=True))

    def request(self, method, path="", **kwargs):
        url = path if path.startswith(("https://", "http://")) else f"{self.url}/{path.lstrip('/')}"
        # NetBox pagination may provide absolute URLs; never forward credentials elsewhere.
        if urlparse(url).netloc != urlparse(self.url).netloc or urlparse(url).scheme != urlparse(self.url).scheme:
            raise ValueError("cross-origin pagination is not allowed")
        response = self.session.request(method, url, timeout=self.timeout, allow_redirects=False, **kwargs)
        response.raise_for_status()
        if 300 <= response.status_code < 400:
            raise ValueError("configure the final connector URL; redirects are disabled")
        return response.json()

    def metric(self, device_id, timestamp, measurements, **kwargs):
        return NetworkMetric(
            device_id=str(device_id), source=self.name, timestamp=timestamp,
            **measurements, **kwargs,
        ).model_dump(mode="json")


class NetBoxAdapter(Adapter):
    def poll(self):
        result = PollResult()
        path = "api/dcim/devices/?limit=100"
        while path:
            page = self.request("GET", path)
            for device in page["results"]:
                ip = device.get("primary_ip4") or device.get("primary_ip6") or {}
                dtype = device.get("device_type") or {}
                result.inventory.append({
                    "device_id": device.get("name") or f"netbox-{device['id']}",
                    "remote_id": str(device["id"]), "source": self.name,
                    "region": named(device.get("site")),
                    "device_type": named(device.get("role") or device.get("device_role")),
                    "vendor": named(dtype.get("manufacturer")),
                    "management_ip": ip.get("address", "").split("/")[0],
                    "netbox_id": device["id"], "status": named(device.get("status")),
                    "maintenance": bool((device.get("custom_fields") or {}).get("aiops_maintenance", False)),
                })
            path = urljoin(self.url + "/", page["next"]) if page.get("next") else None
        return result


class ZabbixAdapter(Adapter):
    def rpc(self, method, params):
        data = self.request("POST", "api_jsonrpc.php", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        if "error" in data:
            raise ValueError(f"Zabbix rejected {method}: code {data['error'].get('code')}")
        return data["result"]

    def poll(self):
        hosts = self.rpc("host.get", {"output": ["hostid", "host", "name"], "monitored_hosts": True,
                                      "selectInterfaces": ["ip", "dns", "useip"]})
        result = PollResult()
        mappings = self.spec["metric_map"]
        if not hosts:
            return result
        items = self.rpc("item.get", {"output": ["hostid", "key_", "lastvalue", "lastclock", "state"],
                                      "hostids": [host["hostid"] for host in hosts],
                                      "filter": {"key_": [value["key"] for value in mappings.values()], "status": "0"}})
        by_host = {}
        max_age = self.spec.get("max_age_seconds", 300)
        now = time.time()
        for item in items:
            if str(item.get("state", "0")) != "0" or now - float(item["lastclock"]) > max_age or float(item["lastclock"]) <= 0:
                continue
            by_host.setdefault(item["hostid"], {})[item["key_"]] = item
        for host in hosts:
            interfaces = host.get("interfaces", [])
            result.inventory.append({"source": self.name, "remote_id": host["hostid"], "device_id": host["host"],
                                     "management_ip": interfaces[0].get("ip", "") if interfaces else ""})
            values, clocks = {}, []
            for metric, mapping in mappings.items():
                item = by_host.get(host["hostid"], {}).get(mapping["key"])
                if item:
                    values[metric] = float(item["lastvalue"]) * mapping.get("scale", 1) + mapping.get("offset", 0)
                    clocks.append(float(item["lastclock"]))
            if values:
                # The oldest included measurement controls freshness; per-item clocks remain auditable.
                result.telemetry.append(self.metric(host["host"], datetime.fromtimestamp(min(clocks), timezone.utc), values,
                    metadata={"remote_id": host["hostid"], "item_clocks": {k: v["lastclock"] for k, v in by_host.get(host["hostid"], {}).items()}}))
        return result


class LibreNMSAdapter(Adapter):
    def poll(self):
        result = PollResult()
        devices = self.request("GET", "api/v0/devices", params={"type": "active"})["devices"]
        for device in devices:
            device_id = device.get("sysName") or device["hostname"]
            remote = str(device["device_id"])
            result.inventory.append({"source": self.name, "remote_id": remote, "device_id": device_id,
                                     "management_ip": device.get("ip", device["hostname"]),
                                     "region": device.get("location") or "unknown", "device_type": device.get("type") or "unknown"})
            poll_time = device.get("last_polled")
            if not poll_time:
                continue
            stamp = datetime.fromisoformat(str(poll_time).replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)  # Configure LibreNMS DB timezone as UTC.
            if time.time() - stamp.timestamp() > self.spec.get("max_age_seconds", 600):
                continue
            values = {}
            if device.get("last_ping_timetaken") is not None:
                values["latency_ms"] = float(device["last_ping_timetaken"])
            processors = self.request("GET", f"api/v0/devices/{quote(remote, safe='')}/health/device_processor")
            cpu = []
            for row in processors.get("graphs", []):
                if row.get("processor_usage") is not None:
                    cpu.append(float(row["processor_usage"]))
                elif row.get("sensor_id") is not None:
                    details = self.request("GET", f"api/v0/devices/{remote}/health/device_processor/{row['sensor_id']}")
                    cpu.extend(float(item["processor_usage"]) for item in details.get("graphs", []) if item.get("processor_usage") is not None)
            if cpu:
                values["cpu_usage_pct"] = sum(cpu) / len(cpu)
            selected = self.spec.get("interfaces", [])
            if selected:
                ports = self.request("GET", f"api/v0/devices/{remote}/ports",
                    params={"columns": "ifName,ifInOctets_rate,ifOutOctets_rate"}).get("ports", [])
                rates = [float(row["ifInOctets_rate"]) + float(row["ifOutOctets_rate"]) for row in ports
                         if row.get("ifName") in selected and row.get("ifInOctets_rate") is not None and row.get("ifOutOctets_rate") is not None]
                if rates:
                    values["throughput_mbps"] = sum(rates) * 8 / 1_000_000
            if values:
                result.telemetry.append(self.metric(device_id, stamp, values, metadata={"remote_id": remote}))
        return result


class GNS3Adapter(Adapter):
    def poll(self):
        project = env(self.spec, "project_id", required=True)
        nodes = self.request("GET", f"v2/projects/{quote(project, safe='')}/nodes")
        links = self.request("GET", f"v2/projects/{quote(project, safe='')}/links")
        inventory = [{"source": self.name, "remote_id": node["node_id"], "device_id": node["name"],
                      "status": node.get("status"), "device_type": node.get("node_type", "unknown"),
                      "project_id": project} for node in nodes]
        edges = [{"link_id": link["link_id"], "endpoints": [
            {"remote_id": endpoint["node_id"], "adapter": endpoint.get("adapter_number"), "port": endpoint.get("port_number")}
            for endpoint in link.get("nodes", [])]} for link in links]
        return PollResult(inventory=inventory, topology={"source": self.name, "project_id": project, "links": edges, "observed_at": utcnow()})


class EVENGAdapter(Adapter):
    def poll(self):
        login = self.request("POST", "api/auth/login", json={"username": env(self.spec, "username", True),
            "password": env(self.spec, "password", True), "html5": "-1"})
        if login.get("status") != "success":
            raise ValueError("EVE-NG login failed")
        lab = quote(env(self.spec, "lab_path", True).lstrip("/"), safe="/")
        response = self.request("GET", f"api/labs/{lab}/nodes")
        if response.get("status") != "success":
            raise ValueError("EVE-NG node query failed")
        nodes = response.get("data", {})
        inventory = [{"source": self.name, "remote_id": str(key), "device_id": node["name"],
                      "status": node.get("status"), "device_type": node.get("template", "unknown"), "lab_path": lab}
                     for key, node in nodes.items()]
        # Per-node interface endpoints expose virtual network IDs; retained for topology joins.
        links = []
        for key in nodes:
            interfaces = self.request("GET", f"api/labs/{lab}/nodes/{key}/interfaces")
            if interfaces.get("status") != "success":
                raise ValueError("EVE-NG interface query failed")
            links.append({"remote_id": str(key), "interfaces": interfaces.get("data", {})})
        return PollResult(inventory=inventory, topology={"source": self.name, "lab_path": lab, "nodes": links, "observed_at": utcnow()})


ADAPTERS = {"netbox": NetBoxAdapter, "zabbix": ZabbixAdapter, "librenms": LibreNMSAdapter,
            "gns3": GNS3Adapter, "eve_ng": EVENGAdapter}
