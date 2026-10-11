# Optional native-software lab definitions

Use [Strata Twin](STRATA_TWIN.md) for the current Vercel-native portfolio. `lab/` retains the separate native-software path requested earlier: actual configuration files, container build definitions and allowlisted execution code. These files are **not deployed or live-validated**. Docker Engine is not installed on this laptop. Compose configuration validation confirms structure, not working BGP, Kafka delivery, image builds or a mobile session.

The lab does not install every catalog alternative. It defines FRR routers, Linux VLAN/netem behavior, real ping/iperf probes, Ansible execution and optional Kafka/MinIO/Strata workers, NetBox, Prometheus/Grafana and Open5GS/UERANSIM profiles. Tools such as AWX, Zabbix, Kea, Open vSwitch and vendor RAN remain external/reference extensions. The model coverage and native lab coverage are different.

## Files and topology

| Files | Intended native execution |
|---|---|
| `lab/compose.yml` | Isolated internal bridges; host ports bound to 127.0.0.1; default core plus staged profiles |
| `lab/config/sites.json` | Three source site designs from the ecosystem catalog |
| `lab/config/frr/*.conf` | Five actual FRR configurations: three access routers and two core routers |
| `lab/router/entrypoint.py` | Discover carrier interfaces by IP; create 802.1Q service VLANs; launch FRR, SSH or iperf server |
| `lab/router/device.py` | Inspect configuration, bounded route preference and owned netem changes |
| `lab/router/probe.py` | Real ping and iperf output parsing; missing measurements stay absent |
| `lab/automation/change.yml` | Actual approved Ansible command tasks for dedicated site routers |
| `lab/automation/service.py` | Authenticated API, persisted candidates/review, stale configuration checks, actual observations and evidence delivery |
| `lab/automation/seed_netbox.py` | NetBox 4.2 ORM bootstrap for intended sites/devices/prefixes/VLANs/ASNs |
| `lab/config/prometheus.yml` | Real scrape targets; disabled-profile targets remain down |
| `lab/config/grafana/datasources/lab.yml` | Real Prometheus data source; no provisioned dashboard in this lab profile |
| `lab/config/mobile/gnb.yml`, `ue.yml`, `subscriber.json` | Native UERANSIM settings and a public test subscriber fixture |
| `lab/mobile/core.py` | Explicit overrides on installed upstream native Open5GS YAML, subscriber seed, TUN/NAT setup and 5GC function supervision |
| `lab/storage/Dockerfile` | MinIO community source build pinned to an upstream commit |

Service VLANs 201–203 are created on site/client carrier links; service prefixes are 10.81.1/2/3.0/24. Management VLANs 101–103 are inventory design records; actual management uses the isolated 172.28.80.0/24 bridge with management loopbacks. The lab does not claim those management VLANs are provisioned. Primary/backup transit bridges are 10.250.0.0/24 and 10.251.0.0/24; traffic server is 10.90.0.10. Docker gateways reserve .254 so router .1 addresses are available.

Traffic-server return routes use core-primary. This is an intentionally asymmetric return design, not symmetric bidirectional failover. Primary impairment is on site egress only. No host interface or physical equipment is targeted.

## Run later, with Docker installed

Docker Desktop requires a supported Windows/WSL2 setup. See [official Windows installation requirements](https://docs.docker.com/desktop/setup/install/windows-install/). The 8 GB target requires staged profiles and enough free disk for builds; resource caps do not guarantee successful builds or host responsiveness. Twin needs none of this software.

```powershell
.\venv\Scripts\python.exe -m scripts.prepare_lab
.\venv\Scripts\python.exe -m scripts.lab doctor
.\venv\Scripts\python.exe -m scripts.lab up
.\venv\Scripts\python.exe -m scripts.lab probe --site JKT-001
.\venv\Scripts\python.exe -m scripts.lab demo --site JKT-001 --approve
.\venv\Scripts\python.exe -m scripts.lab down
```

Preparation creates private `lab/.env` and `lab/runtime/ssh/` only when absent. Never upload them. The controller is on `http://127.0.0.1:8084`; API calls require the generated lab token. `demo --approve` authorizes the documented dedicated-lab sequence: inject primary delay/loss, prefer backup, clear impairment, restore primary. Evidence uses actual subprocess results and is retained under `data/lab-runs/`; failures must be reviewed. Do not run against operator equipment.

Stop the lab before switching profiles; `down` retains named volumes and evidence. Add one profile at a time initially:

```powershell
# Actual Kafka/MinIO/Hub workers; separate from Twin
.\venv\Scripts\python.exe -m scripts.lab up --profile data
.\venv\Scripts\python.exe -m scripts.lab verify --site JKT-001
# verify matches the current actual event ID in Kafka and both Parquet buckets
.\venv\Scripts\python.exe -m scripts.lab down

# Actual NetBox database and API
.\venv\Scripts\python.exe -m scripts.lab up --profile inventory
.\venv\Scripts\python.exe -m scripts.lab seed-netbox
.\venv\Scripts\python.exe -m scripts.lab down

# Mobile track: compilation and protocol-level validation remain pending
.\venv\Scripts\python.exe -m scripts.lab up --profile mobile
.\venv\Scripts\python.exe -m scripts.lab verify-mobile
.\venv\Scripts\python.exe -m scripts.lab down
```

The Hub runs only in the data profile at `http://127.0.0.1:18082`; standalone inventory uses NetBox `http://127.0.0.1:18000`. Do not enable data with inventory/mobile on the 8 GB target. Optional monitoring exposes Prometheus 19090 and Grafana 13000; probe values appear only after real probes. No continuous site poller is configured.

The data profile uses single-node Kafka with replication factor 1 and community MinIO from a fixed source commit because the previous binary tag is unavailable. The [MinIO community repository](https://github.com/minio/minio) is archived; this retained portfolio dependency has no assertion of active maintenance. First builds need outbound Internet access; runtime bridges are internal.

## Validation still required

No Docker containers have been started. Remaining checks include actual image compilation, FRR/Linux interface setup, return routing, SSH host-key persistence, Ansible execution/rollback recovery, NetBox ORM seeding, Kafka/MinIO exact-event verification and Open5GS registration/PDU traffic. The mobile profile uses public lab identity/key fixtures and needs native slice/config compatibility and TUN-route verification. It does not exercise RF or operator SIMs.

Treat these as optional lab definitions until those checks pass. Vercel exports exclude this private runtime and never execute its Docker profiles. Real evidence must retain `actual-virtual-site-lab` / measured source labels, distinct from `strata-twin-model`.
