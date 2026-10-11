# Site equipment and native configuration studio

The **Site equipment** tab connects the selected three-site design to configuration files and commissioning arithmetic. The Vercel/browser app opens no device connection and runs no vendor operating system. A reviewed Twin routing change executes only in the bounded model.

## Routing profiles

The studio generates the same private-ASN, exact-prefix import/export and primary/backup preference intent for seven representative profiles. This is not every vendor, every OS release or every feature. Native parsers and device execution have not been tested.

| Profile | Target and scope | Primary documentation |
|---|---|---|
| FRRouting | Integrated configuration for the isolated Debian Bookworm lab; record the installed FRR release | [Route maps](https://docs.frrouting.org/en/stable-8.4/routemap.html) |
| Cisco IOS XE | 17.x IPv4 BGP and route-map fragment | [External BGP configuration](https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ip-routing/b-ip-routing/m_irg-external-sp-0.html) |
| Cisco IOS XR | 7.x prefix sets, RPL and IPv4 BGP fragment | [Routing policy](https://www.cisco.com/c/en/us/td/docs/iosxr/ncs5000/routing/72x/b-routing-cg-ncs5000-72x/implementing-routing-policy.html) |
| Juniper Junos | Set-style external BGP and exact route filters | [Basic routing policies](https://www.juniper.net/documentation/us/en/software/junos/bgp/topics/topic-map/basic-routing-policies.html) |
| MikroTik RouterOS | RouterOS 7 filter chains only; bind to the installed release's BGP connections separately | [Route selection and filters](https://help.mikrotik.com/docs/spaces/ROS/pages/74678285/Route+Selection+and+Filters) |
| Huawei VRP | IP prefixes, route policies and IPv4 BGP fragment | [Local preference](https://info.support.huawei.com/hedex/api/pages/EDOC1100277650/AZM1016J/04/resources/command/yunshan/APPLY-LOCAL-PREF%28RTPOM%29.html) |
| Nokia SR OS | Classic CLI Base-router policy options and external BGP fragment | [Route policies](https://documentation.nokia.com/sr/22-10-4/books/unicast-routing-protocols/route-policies.html) |

Choose a platform and **Current modeled preference**, **Candidate: prefer backup**, or **Candidate: restore primary**. Export downloads a native text fragment. **Create reviewed Twin candidate** uses the normal Operator → Reviewer → Operator workflow; it does not SSH to a device or apply this vendor fragment.

Provision connected service/loopback/transit routes and map actual interfaces before native testing. Check OS syntax, existing policies, licenses and platform-specific activation. The fragments deliberately do not invent QoS capacity commands, credentials, RF control or a universal commercial-device configuration. In particular, RouterOS BGP setup has release-specific changes, so only its routing filter definitions are exported.

`lab/config/vendors/` contains 21 materialized baseline fragments (seven profiles × three sites) and a manifest of intent, target and source. These are reproducible with:

```powershell
node scripts/package_native_configs.cjs
```

## Mobile core native files

`lab/config/mobile/` now contains native AMF, SMF and UPF YAML for the pinned Open5GS v2.7.6 lab, plus UERANSIM v3.2.7 gNB/UE files and a deliberately public test subscriber fixture. `lab/mobile/core.py` loads the declared AMF/SMF/UPF files; other core functions retain the pinned upstream build's native defaults with explicit PLMN/database/logger overrides.

PLMN 001/01, TAC 1, SST 1 / SD 000001, DNN internet and UE subnet 10.45.0.0/16 are aligned across these files. AMF NGAP and UPF GTP-U use the declared container address; PFCP functions share the core container's loopback namespace. The native schema follows the [Open5GS configuration guide](https://open5gs.org/open5gs/docs/guide/01-quickstart/) and pinned [AMF](https://github.com/open5gs/open5gs/blob/v2.7.6/configs/open5gs/amf.yaml.in), [SMF](https://github.com/open5gs/open5gs/blob/v2.7.6/configs/open5gs/smf.yaml.in) and [UPF](https://github.com/open5gs/open5gs/blob/v2.7.6/configs/open5gs/upf.yaml.in) templates.

The Docker network is internal. DNN naming and upstream public DNS defaults do not establish Internet egress. Native traffic testing targets the declared private lab service. Docker is absent on this laptop; no core daemon, RAN connection or user-plane packet test has been executed.

Regenerate just these YAML files with `python -m scripts.render_open5gs`. Full lab preparation also regenerates them. No private subscriber/operator credential is bundled.

## Equipment and commissioning

The register includes transport router, access switch/VLAN, RU/RRU/AAU, DU, CU, sector antenna/RET, feeders, fiber/optics, microwave backhaul, rectifier/battery/DC plant, GNSS/PTP/SyncE, and 5G core/UPF. Each row displays its actual control boundary. Native Open5GS/UERANSIM is a separate optional protocol track; the browser's modeled mobile sessions are not equivalent to its real messages.

Radio inputs are generic planning values, not a specific manufacturer's datasheet. The calculation is:

- Free-space loss in dB = `32.44 + 20 log10(frequency MHz) + 20 log10(distance km)`.
- EIRP in dBm = transmit power + antenna gain − feeder loss.
- Received total power = EIRP − free-space loss − declared additional loss, assuming 0 dBi receiver gain.
- Battery hours = voltage magnitude × Ah × usable fraction / load watts.

This is not NR RSRP/SINR, terrain coverage, an antenna radiation pattern or a measured drive test. Pointing and tilt are recorded values; they do not change the computed loss. Battery arithmetic excludes voltage curves, aging, temperature and electrical protection. Calculation does not alter Twin transport or slice capacity. Plans are stored separately by site and exported as JSON.

Actual RET needs a compatible AISG controller and equipment-specific integration; antenna geometry cannot be reproduced by a generic router command. See the [CommScope RET controller documentation](https://www.commscope.com/globalassets/digizuite/53341-a997-0095-f-pdf.pdf). DU/MAC/eCPRI, microwave modems, optics measurements, VSWR/PIM and timing protocols remain external boundaries.

## Export pack and verification

**Export native lab pack** downloads JSON containing the text and SHA-256 hashes of 36 explicitly selected public config files, the current site's seven routing policies and its last calculated commissioning values. Static baseline files and current policies are separate entries. This JSON container preserves file contents; it is not a directly executable Compose deployment or an archive extractor.

The pack excludes `.env`, private SSH material and runtime data by a fixed file allowlist. A repository Vercel build regenerates it with Node.js; it never requires Docker or a running backend.

```powershell
node --test tests/test_twin.cjs tests/test_device_configs.cjs tests/test_vercel.mjs
.\venv\Scripts\python.exe -m unittest tests.test_mobile_config
```

These checks verify bounded intent, unsafe input rejection, arithmetic, fixture bindings and file integrity. They do not validate vendor parsers or prove 1:1 field equivalence. That claim requires specific equipment/OS versions, native execution and comparable measurements.
