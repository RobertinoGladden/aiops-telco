"""Validate the reference catalog and render its internal lab reference without external services."""
import argparse
import ipaddress
import json
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "lab/reference/software-catalog.json"
PRIVATE = tuple(ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def validate(catalog):
    def require(condition, message):
        if not condition:
            raise ValueError(message)

    def unique(items, key, kind):
        values = [item[key] for item in items]
        require(len(values) == len(set(values)), f"Duplicate {kind}")
        return set(values)

    require(catalog["version"] == 1, "Unsupported catalog version")
    layers = unique(catalog["layers"], "id", "layer")
    tools = unique(catalog["tools"], "id", "tool")
    unique(catalog["sites"], "id", "site")
    unique(catalog["scenarios"], "id", "scenario")
    for tool in catalog["tools"]:
        require(tool["layer"] in layers, f"Unknown layer: {tool['id']}")
        require(tool["status"] in catalog["statuses"], f"Unknown status: {tool['id']}")
        for field in ("name", "role", "interface", "boundary"):
            require(bool(tool[field].strip()), f"Missing {field}: {tool['id']}")
        source = urlsplit(tool["source"])
        require(source.scheme == "https" and source.hostname and not source.username and not source.password,
                f"Unsafe reference: {tool['id']}")
        if tool.get("evidence"):
            target = (ROOT / tool["evidence"]).resolve()
            require(target.is_relative_to(ROOT) and target.is_file(), f"Missing repository evidence: {tool['id']}")
    for allocation in catalog["allocations"]:
        require(allocation["owner"] in tools, "Unknown allocation owner")
    networks, vlans, asns = [], set(), set()
    for site in catalog["sites"]:
        require(64512 <= site["asn"] <= 65534 and site["asn"] not in asns, f"Invalid/duplicate private ASN: {site['id']}")
        asns.add(site["asn"])
        for purpose in ("management", "service"):
            network = ipaddress.ip_network(site[purpose], strict=True)
            require(network.version == 4 and any(network.subnet_of(pool) for pool in PRIVATE), "Lab prefix must use private IPv4")
            require(not any(network.overlaps(previous) for previous in networks), f"Overlapping prefix: {site['id']}")
            networks.append(network)
            vlan = site[f"{purpose}_vlan"]
            require(1 <= vlan <= 4094 and vlan not in vlans, f"Invalid/duplicate lab VLAN: {site['id']}")
            vlans.add(vlan)
    for scenario in catalog["scenarios"]:
        require(bool(scenario["steps"]), "Empty scenario")
        for step in scenario["steps"]:
            require(bool(step["evidence"].strip()) and bool(step["tools"]), "Missing scenario evidence/tools")
            require(set(step["tools"]).issubset(tools), f"Unknown scenario tool: {scenario['id']}")


def guide(catalog):
    names = {tool["id"]: tool["name"] for tool in catalog["tools"]}
    content = [
        "# Strata native software reference", "",
        "Strata pairs an owned browser operations simulator with optional native-software lab definitions and clearly scoped telecom roles. It is a portfolio environment; physical RF and protocol equivalence are not claimed.", "",
        "The public application opens the Digital Twin lab; see [the simulator guide](STRATA_TWIN.md). This internal catalog retains software roles and optional native lab designs, and is excluded from public Vercel assets. Live Operations still requires its separate backend.", "",
        f"The catalog contains **{len(catalog['tools'])} components across {len(catalog['layers'])} layers**. It includes core choices and optional alternatives, not a claim that every listed tool is deployed or used by every telecom operator. Walkthroughs inspect design stages; they do not execute external jobs or synthesize live service-health claims.", "",
        "## Allocation ownership", "",
    ]
    for row in catalog["allocations"]:
        content += [f"- **{row['name']} — {names[row['owner']]}:** {row['explanation']}"]
    content += ["", "## Recommended lab composition", "",
        "The optional [native lab definitions](EXECUTABLE_LAB.md) use Compose/FRRouting, a dedicated Ansible controller, staged NetBox and Kafka/MinIO/Strata/Prometheus/Grafana profiles, plus a separate Open5GS/UERANSIM track. They have not run on this laptop. Containerlab, Zabbix and AWX are reference alternatives/extensions, not installed dependencies. Start with [Strata Twin](STRATA_TWIN.md) for the current Vercel-native portfolio.", "",
        "LibreNMS can complement or replace the initial NMS. GNS3 and EVE-NG are alternative lab engines. Nornir/NAPALM/Netmiko provide alternative automation paths; choose supported device drivers rather than requiring all libraries at once. OpenDaylight, srsRAN and OpenAirInterface belong to further SDN/RAN tracks. Supporting services such as Redis/MongoDB depend on the chosen application's installation and should be recorded when those services are actually deployed.", "",
        "The mobile-core track exercises subscriber registration, session establishment and user-plane forwarding. UERANSIM's simulated radio link does not supply physical RSRP/RSRQ/SINR or validated RF handover performance. Radio scheduling requires a compatible RAN implementation/test environment. Do not infer core traffic capacity from a radio label.", "",
        "## Proposed operational loop", "", "```mermaid", "flowchart LR",
        "  NB[NetBox intended allocation] --> Candidate[Ansible configuration candidate]",
        "  Candidate --> Validate[Supported config analysis and live baseline probes]",
        "  Validate --> Review[AWX approval and job scope]",
        "  Review --> Device[FRR virtual routers / configured lab services]",
        "  Device --> NMS[Zabbix / service probes]",
        "  NMS --> Hub[Strata Integration Hub]",
        "  Hub --> Kafka --> MinIO",
        "  Kafka --> Detection[Detection worker] --> Hub",
        "  Hub --> Request[Evidence and review request] --> Review",
        "  Device --> Verify[Post-change probes] --> Record[Evidence or supported rollback]",
        "```", "",
        "This loop is the target architecture. The existing Hub provides durable telemetry and review requests, not device execution. AWX launching, IPAM writes, provisioning templates, configuration backups and supported rollback remain implementation work. The existing Ansible artifact handles only bounded Linux link impairment.", "",
        "## Illustrative site allocation", "",
        "| Site | Management prefix / VLAN | Service prefix / VLAN | Private ASN |",
        "|---|---|---|---|",
    ]
    for site in catalog["sites"]:
        content += [f"| {site['id']} | {site['management']} / {site['management_vlan']} | {site['service']} / {site['service_vlan']} | {site['asn']} |"]
    content += ["", "These are checked design samples, not allocations read from or written to a running NetBox. Current validation requires distinct VLANs within this single lab scope; production VLAN reuse has a different scope model.", "", "## Catalog and official references", "",
        "Repository labels describe implementation scope, not running service health. Compose-defined applications still need startup validation; adapter-implemented applications need independent installations; planned/optional applications have no native integration yet.", ""]
    for layer in catalog["layers"]:
        content += [f"### {layer['name']}", "", layer["question"], "", "| Software | Role / interface | Repository scope |", "|---|---|---|"]
        for tool in catalog["tools"]:
            if tool["layer"] == layer["id"]:
                content += [f"| [{tool['name']}]({tool['source']}) | {tool['role']}<br>{tool['interface']} | **{catalog['statuses'][tool['status']]}** — {tool['boundary']} |"]
        content += [""]
    content += ["## Engineering scenarios", ""]
    for scenario in catalog["scenarios"]:
        content += [f"### {scenario['name']}", "", f"Expected acceptance: {scenario['outcome']}", ""]
        for index, step in enumerate(scenario["steps"], 1):
            content += [f"{index}. **{step['name']}** ({', '.join(names[item] for item in step['tools'])}). Evidence: {step['evidence']}"]
        content += [""]
    content += ["## Run and publish", "",
        "- Validate the catalog: `python scripts/check_portfolio.py`.",
        "- Regenerate this guide after editing the catalog: `python scripts/check_portfolio.py --write-doc`.",
        "- Build the static portfolio: `node deploy/vercel/build.mjs`; publish through the [GitHub/Vercel guide](GITHUB_REMOTE_DEPLOYMENT.md).",
        "- Open `/#twin` for executable modeled scenarios; use the existing full-stack startup instructions to demonstrate actual Kafka/MinIO processing.",
        "- Capture a real lab run separately: save configuration diffs, job/probe output, event IDs, Kafka offsets, stored artifacts and recovery evidence. Present those as recorded evidence rather than always-on backend health.", "",
        "No vendor appliances, Docker services, AWX workflows or mobile-core sessions were launched while building this catalog. Current live-test limits are in [validation evidence](VALIDATION.md).", ""]
    return "\n".join(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-doc", action="store_true")
    args = parser.parse_args()
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    validate(catalog)
    if args.write_doc:
        (ROOT / "docs/LAB_REFERENCE.md").write_text(guide(catalog), encoding="utf-8")
    print(f"Valid: {len(catalog['tools'])} components, {len(catalog['layers'])} layers, {len(catalog['sites'])} site designs and {len(catalog['scenarios'])} scenarios.")


if __name__ == "__main__":
    main()
