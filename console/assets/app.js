"use strict";
const $ = (selector) => document.querySelector(selector);
const names = {
  netbox: "NetBox",
  zabbix: "Zabbix",
  librenms: "LibreNMS",
  gns3: "GNS3",
  "eve-ng": "EVE-NG",
};
const roles = {
  netbox: "Source of truth",
  zabbix: "Telemetry & alerts",
  librenms: "Network monitoring",
  gns3: "Network lab",
  "eve-ng": "Virtual network lab",
};
const descriptions = {
  netbox:
    "Device identities, vendors, regions, management IPs, and maintenance context.",
  zabbix:
    "Measured latency, packet loss, CPU, and your mapped telemetry items.",
  librenms: "Inventory, CPU, ping, and throughput from selected interfaces.",
  gns3: "GNS3 project nodes and links, paired with telemetry from your monitoring tools.",
  "eve-ng":
    "EVE-NG lab nodes and interfaces mapped to consistent device identities.",
};
const marks = {
  netbox: "N",
  zabbix: "Z",
  librenms: "L",
  gns3: "G3",
  "eve-ng": "EV",
};
const stateLabels = {
  healthy: "Healthy",
  disabled: "Disabled",
  waiting: "Waiting",
  unknown: "Not checked",
  error: "Error",
  stale: "Stale",
  unavailable: "Unavailable",
  reachable: "TCP reachable",
  open: "Open",
  observing: "Observe",
  resolved: "Resolved",
  suppressed: "Maintenance",
  critical: "Critical",
  warning: "Warning",
  normal: "Normal",
  ready: "Ready",
  failed: "Failed",
  running: "Running",
  pending: "Pending",
  sent: "Acknowledged",
  retrying: "Retrying",
};
const actionLabels = {
  observe: "Observe",
  collect_diagnostics: "Collect diagnostics",
  escalate_noc: "Review NOC",
  review_failover: "Review failover",
  review_capacity: "Review capacity",
};
const errors = {
  ai_not_configured:
    "Enable AI_ENABLED and set GROQ_API_KEY and OPENAI_API_KEY in the server .env.",
  ai_disabled: "AI is disabled on the server.",
  analysis_in_progress:
    "Another analysis is running. Try again when it finishes.",
  cooldown:
    "Wait for the cooldown before requesting a new analysis for this incident.",
  daily_limit: "The daily AI analysis limit has been reached.",
  evidence_stale: "Incident evidence is stale. Wait for a fresh observation.",
  evidence_changed:
    "Evidence has changed since analysis. Request a new analysis before submitting a review.",
  incident_not_open: "The incident is no longer open.",
  maintenance: "The device is in maintenance.",
  no_measured_evidence:
    "The incident has no measured telemetry or monitoring alert.",
  low_confidence: "Decision confidence is below the review threshold.",
  insufficient_evidence: "Evidence is insufficient for operational review.",
  observation_only: "This decision recommends observation only.",
  topology_unavailable: "Device topology is unavailable for failover review.",
  link_impairment_unmeasured:
    "Failover review requires measured latency or packet loss that indicates link impairment.",
  workflow_not_configured:
    "Enable and configure your workflow in the server .env.",
  decision_not_ready: "The decision is not ready for review.",
  decision_refused:
    "The provider refused the decision. The review gate remains closed.",
  provider_unavailable:
    "The AI provider is unreachable. Check network access and server configuration.",
  provider_http_error:
    "The AI provider rejected the request. Check credentials, model access, quota, and provider logs.",
  invalid_provider_response:
    "The provider response does not match the expected contract.",
  invalid_decision_response:
    "The Decisions response failed choice or probability validation.",
  incident_not_found: "Incident not found.",
  decision_not_found: "Decision not found.",
};
const views = {
  twin: ["Digital Twin", "Digital twin lab.", "Experiment with transport, mobile access and operational recovery."],
  overview: [
    "Overview",
    "Your network. One clear view.",
    "Connect field systems. Turn measured signals into informed action.",
  ],
  integrations: [
    "Integrations",
    "Your field stack, connected.",
    "Inspect collectors, data freshness, and configuration across your integrations.",
  ],
  operations: [
    "Operations",
    "See the health of every layer.",
    "From collection to delivery: worker heartbeats, processing backlog, and operational evidence.",
  ],
  incidents: [
    "Incidents",
    "Focus on what needs action.",
    "Confirmed incidents, maintenance context, and measured evidence for your NOC.",
  ],
  intelligence: [
    "AI decision desk",
    "Evidence in. Decisions on record.",
    "Groq interprets signals. OpenAI Decisions selects a reviewable next step.",
  ],
  inventory: [
    "Devices & topology",
    "Know the network you operate.",
    "Cross-source device identities and topology, from inventory to network labs.",
  ],
  settings: [
    "Settings",
    "Configure your operations.",
    "Manage provider configuration, analysis limits, and operational workflows on your server.",
  ],
};
let token = "",
  data = null,
  selectedView = "overview",
  incidentFilter = "all",
  refreshing = false,
  busy = false,
  sessionVersion = 0,
  query = "";
function el(tag, className, text, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  children.forEach((child) => node.append(child));
  return node;
}
function replace(selector, children) {
  $(selector).replaceChildren(...children);
}
function tag(state, label) {
  return el("span", `tag ${state}`, label || stateLabels[state] || state);
}
function icon(name) {
  const paths = {
    overview: ["M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"],
    integrations: ["M8 5H4v4M4 5l5 5M16 19h4v-4M20 19l-5-5M9 15l6-6"],
    incidents: ["M3 12h4l3-7 4 14 3-7h4"],
    intelligence: ["M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z"],
    inventory: [
      "M4 3h16v5H4zM4 10h16v5H4zM4 17h16v4H4zM7 5.5h.1M7 12.5h.1M7 19h.1",
    ],
    settings: [
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M5.6 18.4l1.5-1.5M16.9 7.1l1.5-1.5",
    ],
    search: ["M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15M16 16l5 5"],
    refresh: [
      "M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3",
    ],
    close: ["M6 6l12 12M18 6L6 18"],
    orbit: [
      "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M3 18c-2-2 1-6 6-10s10-5 12-3-1 6-6 10-10 5-12 3M12 10v4M10 12h4",
    ],
    outbox: ["M3 5h18v14H3zM3 13h5l2 3h4l2-3h5M12 4v7M9 8l3 3 3-3"],
    operations: ["M3 7l9-5 9 5-9 5zM3 12l9 5 9-5M3 17l9 5 9-5"],
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "ui-icon",
  }))
    svg.setAttribute(key, value);
  for (const d of paths[name] || paths.orbit) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
function enhanceIcons() {
  document
    .querySelectorAll(".sidebar [data-view] .nav-icon")
    .forEach((node) =>
      node.replaceChildren(icon(node.closest("[data-view]").dataset.view)),
    );
  document
    .querySelectorAll(".stat-icon")
    .forEach((node, index) =>
      node.replaceChildren(
        icon(["integrations", "inventory", "incidents", "outbox"][index]),
      ),
    );
  $(".search > span").replaceChildren(icon("search"));
  $("#refresh > span").replaceChildren(icon("refresh"));
  document
    .querySelectorAll(".icon-button")
    .forEach((node) => node.replaceChildren(icon("close")));
}
const dialogTimers = new WeakMap();
function openDialog(dialog) {
  clearTimeout(dialogTimers.get(dialog));
  dialog.classList.remove("is-closing");
  if (!dialog.open) dialog.showModal();
}
function closeDialog(dialog) {
  if (!dialog.open || dialog.classList.contains("is-closing")) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    dialog.close();
    return;
  }
  dialog.classList.add("is-closing");
  dialogTimers.set(
    dialog,
    setTimeout(() => {
      dialog.close();
      dialog.classList.remove("is-closing");
    }, 180),
  );
}
function button(label, action, className = "button") {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
function empty(title, body) {
  return el("div", "empty", null, [
    el("span", "empty-icon", null, [icon("orbit")]),
    el("b", "", title),
    el("p", "", body),
  ]);
}
function stamp(value) {
  if (!value) return "No observation yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Timestamp invalid"
    : new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short",
      }).format(date);
}
function ago(value) {
  if (!value) return "No data yet";
  const seconds = Math.floor((Date.now() - new Date(value)) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return "Just updated";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  return `${Math.floor(seconds / 3600)} hours ago`;
}
function number(value) {
  return new Intl.NumberFormat("en-GB").format(value || 0);
}
function observedNumber(value) {
  return value === null || value === undefined ? "—" : number(value);
}
function countLabel(value, noun) {
  return `${number(value)} ${noun}${value === 1 ? "" : "s"}`;
}
function matches(row) {
  return (
    !query ||
    [row.device_id, row.source, row.state, row.severity, row.region, row.name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query))
  );
}
function toast(message, duration = 5500) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  $("#toast").classList.remove("is-closing");
  clearTimeout(toast.timer);
  clearTimeout(toast.exitTimer);
  if (duration)
    toast.timer = setTimeout(() => {
      $("#toast").classList.add("is-closing");
      toast.exitTimer = setTimeout(() => {
        $("#toast").hidden = true;
      }, 200);
    }, duration);
}
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
      signal: controller.signal,
      cache: "no-store",
    });
    const body = await response.json();
    if (!response.ok) {
      const message =
        response.status === 401
          ? "Invalid Hub token. Reconnect your workspace."
          : errors[body.detail] || `Request failed (${response.status}).`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error(
        "The request timed out. Refresh to check for a saved result.",
      );
    if (error instanceof TypeError)
      throw new Error(
        "The Integration Hub is unreachable. Check the server process.",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
function showView(view, updateHash = true) {
  if (!Object.hasOwn(views, view)) { view = "twin"; updateHash = true; }
  selectedView = view;
  document.body.classList.toggle("twin-view", view === "twin");
  $("#search").placeholder = "Search devices, sources, incidents…";
  $("#search").setAttribute("aria-label", "Search devices or incidents");
  const groups = {twin: [["twin", "Digital Twin"]],
    operations: [["overview", "Overview"], ["operations", "Service health"], ["incidents", "Incidents"], ["inventory", "Assets"]],
    workspace: [["integrations", "Connections"], ["intelligence", "AI review"], ["settings", "Settings"]]};
  const group = Object.keys(groups).find((key) => groups[key].some(([id]) => id === view));
  const tabs = $("#context-tabs"); tabs.hidden = group === "twin";
  tabs.replaceChildren(...groups[group].map(([id, name]) => {
    const button = el("button", id === view ? "selected" : "", name);
    button.type = "button"; button.setAttribute("aria-current", id === view ? "page" : "false");
    button.addEventListener("click", () => showView(id)); return button;
  }));
  Object.keys(views).forEach((key) => {
    $(`#view-${key}`).hidden = key !== view;
  });
  document.querySelectorAll(".sidebar [data-view]").forEach((node) => {
    node.classList.toggle("active", node.dataset.navGroup === group);
    node.setAttribute(
      "aria-current",
      node.dataset.navGroup === group ? "page" : "false",
    );
  });
  $("#breadcrumb").textContent = views[view][0];
  $("#page-title").textContent = views[view][1];
  $("#page-subtitle").textContent = views[view][2];
  const panel = $(`#view-${view}`);
  clearTimeout(showView.timer);
  document
    .querySelectorAll(".view")
    .forEach((node) => node.classList.remove("is-entering"));
  void panel.offsetWidth;
  panel.classList.add("is-entering");
  showView.timer = setTimeout(() => panel.classList.remove("is-entering"), 650);
  if (updateHash) history.replaceState(null, "", `#${view}`);
  document.dispatchEvent(new CustomEvent("strata:viewchange", {detail: {view}}));
  window.scrollTo({ top: 0, behavior: "instant" });
}
function connectorRows() {
  return (
    data?.connectors ||
    Object.keys(names).map((id) => ({
      id,
      state: "unknown",
      devices: 0,
      metrics: 0,
    }))
  );
}
function connectorHead(row) {
  return el("div", "connector-top", null, [
    el("span", `connector-icon ${row.id}`, marks[row.id] || "↔"),
    el("div", "", null, [
      el("div", "connector-name", names[row.id] || row.id),
      el("div", "connector-role", roles[row.id] || row.kind),
    ]),
    tag(row.state),
  ]);
}
function renderConnectors() {
  replace(
    "#connector-grid",
    connectorRows().map((row) => {
      const node = button("", () => connectorDetail(row), "connector-card");
      node.setAttribute(
        "aria-label",
        `${names[row.id] || row.id}: ${stateLabels[row.state] || row.state}`,
      );
      node.append(
        connectorHead(row),
        el("div", "connector-bottom", null, [
          el(
            "strong",
            "",
            data ? countLabel(row.devices, "device") : "— devices",
          ),
          el("span", "", ago(row.observed_at)),
        ]),
      );
      return node;
    }),
  );
  replace(
    "#integration-list",
    connectorRows().map((row) =>
      el("article", "panel integration-detail", null, [
        connectorHead(row),
        el(
          "p",
          "integration-description",
          descriptions[row.id] || "External collector",
        ),
        el("div", "integration-info", null, [
          el("div", "", null, [
            el("span", "", "Devices"),
            el("strong", "", data ? number(row.devices) : "—"),
          ]),
          el("div", "", null, [
            el("span", "", "Metrics / poll"),
            el("strong", "", data ? observedNumber(row.metrics) : "—"),
          ]),
          el("div", "", null, [
            el("span", "", "Last observed"),
            el("strong", "", row.observed_at ? stamp(row.observed_at) : "—"),
          ]),
        ]),
        el("div", "integration-config", null, [
          el(
            "div",
            "",
            row.enabled
              ? "Collector enabled on the server."
              : "Enable the collector and configure installation access in .env.",
          ),
          el(
            "code",
            "",
            `${row.enabled_env || `${row.id.toUpperCase().replaceAll("-", "_")}_ENABLED`}=true`,
          ),
          el(
            "div",
            "",
            row.error_type
              ? `Latest error: ${row.error_type}`
              : `URL: ${row.url_env || "see .env.example"}`,
          ),
        ]),
      ]),
    ),
  );
}
function renderServices() {
  const services =
    data?.services ||
    [
      "Kafka",
      "Storage worker",
      "Detection worker",
      "MinIO",
      "Model API",
      "MLflow",
      "Prometheus",
      "Alertmanager",
      "Grafana",
      "Airflow",
    ].map((name) => ({ name, state: "unknown", detail: "Not checked" }));
  replace(
    "#services",
    services.map((row) => {
      const node = button("", () => serviceDetail(row), `service ${row.state}`);
      node.append(
        el("b", "", row.name),
        el("small", "", null, [
          el("span", "status-dot"),
          el("span", "", stateLabels[row.state] || row.state),
        ]),
      );
      node.title = `${row.detail || ""}${row.checked_at ? ` · ${stamp(row.checked_at)}` : ""}`;
      return node;
    }),
  );
}
function incidentTable(rows) {
  if (!rows.length)
    return empty(
      data ? "No incidents in this view" : "Waiting for incident evidence",
      data
        ? "Incidents appear after confirmed collector or predictor detections. Check your search and status filters."
        : "Connect your workspace to view the incident queue and evidence.",
    );
  const table = el("table");
  table.append(
    el("thead", "", null, [
      el(
        "tr",
        "",
        null,
        ["DEVICE", "SEVERITY", "SOURCE", "STATUS", "OBSERVED", ""].map(
          (label) => el("th", "", label),
        ),
      ),
    ]),
  );
  table.append(
    el(
      "tbody",
      "",
      null,
      rows.map((row) =>
        el("tr", "", null, [
          el("td", "", null, [
            el("strong", "", row.device_id),
            el("small", "", row.region || "unknown"),
          ]),
          el("td", "", null, [tag(row.severity)]),
          el("td", "", row.source),
          el("td", "", null, [tag(row.state)]),
          el("td", "", stamp(row.timestamp)),
          el("td", "", null, [
            button("View →", () => incidentDetail(row), "text-button"),
          ]),
        ]),
      ),
    ),
  );
  return el("div", "table-wrap", null, [table]);
}
function renderIncidents() {
  const all = (data?.incidents || [])
    .filter(matches)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const filtered = all.filter(
    (row) => incidentFilter === "all" || row.state === incidentFilter,
  );
  replace("#recent-incidents", [incidentTable(all.slice(0, 5))]);
  replace("#incident-table", [incidentTable(filtered)]);
  $("#incident-count").textContent = countLabel(filtered.length, "incident");
  const active = all.filter((row) => row.state === "open");
  replace(
    "#ai-incident-list",
    active.length
      ? active.map((row) => {
          const analyze = button("✧ Analyze with AI", () =>
            analyzeIncident(row),
          );
          analyze.disabled = busy || !data?.ai.ready;
          return el("div", "ai-incident", null, [
            tag(row.severity),
            el("div", "", null, [
              el("b", "", row.device_id),
              el("p", "", `${row.source} · ${stamp(row.timestamp)}`),
            ]),
            analyze,
          ]);
        })
      : [
          empty(
            "No open incidents yet",
            "Enable a telemetry source to start evaluating network events.",
          ),
        ],
  );
}
function providerRows() {
  const ai = data?.ai;
  const providers = ai?.providers || [
    { name: "Groq", role: "Incident analysis", model: "openai/gpt-oss-20b" },
    { name: "OpenAI Decisions", role: "Typed decision", model: "gpt-6-luna" },
  ];
  const rows = providers.map((row) =>
    el("div", "provider-row", null, [
      el("span", "provider-icon", "✧"),
      el("div", "", null, [
        el("b", "", row.name),
        el("small", "", `${row.role} · ${row.model}`),
      ]),
      tag(
        row.configured === undefined
          ? "unknown"
          : row.configured
            ? "healthy"
            : "disabled",
        row.configured === undefined
          ? "Not checked"
          : row.configured
            ? "Key configured"
            : "Not configured",
      ),
    ]),
  );
  rows.push(
    el("div", "policy-note", null, [
      el(
        "b",
        "",
        ai
          ? `AI ${ai.enabled ? "enabled" : "disabled"} · operator review mode`
          : "Connect your workspace to check configuration.",
      ),
      el(
        "p",
        "",
        ai
          ? `Up to ${ai.max_daily_runs} analyses / UTC day · evidence age limit ${ai.max_evidence_age_seconds}s · threshold ${ai.min_confidence}. Workflow ${ai.workflow_enabled ? "enabled" : "disabled"}. Provider access is verified during a request.`
          : "Credentials stay on the server.",
      ),
    ]),
  );
  replace("#provider-status", rows);
}
function decisionCard(run) {
  const head = el("div", "decision-card-head", null, [
    el("h3", "", run.device_id),
    tag(run.status),
  ]);
  const card = el("article", "decision-card", null, [head]);
  if (run.analysis) card.append(el("p", "", run.analysis.summary));
  else
    card.append(
      el(
        "p",
        "",
        run.error_code
          ? errors[run.error_code] || run.error_code
          : "Analysis started. If the server stopped, retry after the cooldown.",
      ),
    );
  const metadata = [
    `${stamp(run.created_at)}`,
    `${run.models?.analysis || "Groq"} → ${run.models?.decision || "OpenAI Decisions"}`,
    `Incident v${run.incident_version}`,
  ];
  if (run.decision)
    metadata.push(`Confidence ${Math.round(run.decision.confidence * 100)}%`);
  card.append(
    el(
      "div",
      "decision-meta",
      null,
      metadata.map((value) => el("span", "", value)),
    ),
  );
  const actions = el("div", "decision-action");
  if (run.decision) {
    actions.append(
      tag("purple", actionLabels[run.decision.action] || run.decision.action),
    );
    const progress = el("progress", "confidence-bar");
    progress.max = 1;
    progress.value = run.decision.confidence;
    progress.setAttribute("aria-label", "Decision confidence");
    actions.append(progress);
  }
  actions.append(
    button(
      "View evidence & decision ↗",
      () => decisionDetail(run),
      "text-button",
    ),
  );
  card.append(actions);
  return card;
}
function renderDecisions() {
  const runs = (data?.decisions || []).filter(matches);
  $("#decision-count").textContent = countLabel(runs.length, "decision");
  $("#export-audit").disabled = !data?.decisions?.length;
  replace(
    "#decision-list",
    runs.length
      ? runs.map(decisionCard)
      : [
          empty(
            "Your first decision starts with evidence",
            "Select an open incident and choose Analyze with AI. Results, models, probabilities, and policy checks are saved to the audit trail.",
          ),
        ],
  );
}
function renderInventory() {
  const rows = Object.entries(data?.inventory || {})
    .flatMap(([source, snapshot]) =>
      snapshot.data.map((row) => ({
        ...row,
        source,
        observed_at: snapshot.observed_at,
      })),
    )
    .filter(matches);
  $("#inventory-count").textContent = countLabel(
    rows.length,
    "device observation",
  );
  if (!rows.length)
    replace("#inventory-table", [
      empty(
        "No inventory available yet",
        "Connect NetBox, Zabbix, LibreNMS, GNS3, or EVE-NG to observe your actual devices.",
      ),
    ]);
  else {
    const table = el("table");
    table.append(
      el("thead", "", null, [
        el(
          "tr",
          "",
          null,
          [
            "DEVICE ID",
            "SOURCE",
            "MANAGEMENT IP",
            "VENDOR / TYPE",
            "REGION",
            "MAINTENANCE",
          ].map((text) => el("th", "", text)),
        ),
      ]),
      el(
        "tbody",
        "",
        null,
        rows.map((row) =>
          el("tr", "", null, [
            el("td", "", null, [el("strong", "", row.device_id)]),
            el("td", "", names[row.source] || row.source),
            el("td", "", row.management_ip || "—"),
            el("td", "", null, [
              el("span", "", row.vendor || "unknown"),
              el("small", "", row.device_type || "unknown"),
            ]),
            el("td", "", row.region || "unknown"),
            el("td", "", null, [
              tag(
                row.maintenance ? "suppressed" : "disabled",
                row.maintenance ? "Yes" : "No",
              ),
            ]),
          ]),
        ),
      ),
    );
    replace("#inventory-table", [el("div", "table-wrap", null, [table])]);
  }
  const topologies = Object.entries(data?.topology || {});
  replace(
    "#topology",
    topologies.length
      ? topologies.map(([source, snapshot]) => {
          const topo = snapshot.data;
          const nodes = data?.inventory[source]?.data || [];
          const remoteNames = Object.fromEntries(
            nodes.map((node) => [node.remote_id, node.device_id]),
          );
          const segments = new Map();
          if (source === "eve-ng") {
            for (const node of topo.nodes || []) {
              for (const [portId, port] of Object.entries(
                node.interfaces?.ethernet || {},
              )) {
                if (!port.network_id) continue;
                const key = String(port.network_id);
                if (!segments.has(key)) segments.set(key, []);
                segments
                  .get(key)
                  .push(
                    `${remoteNames[node.remote_id] || node.remote_id}:${port.name ?? portId}`,
                  );
              }
            }
          }
          const section = el("section", "topology-source", null, [
            el("h3", "", names[source] || source),
            el(
              "div",
              "topology-nodes",
              null,
              nodes.map((node) =>
                el("div", "node", null, [
                  el(
                    "b",
                    "",
                    node.device_id ||
                      node.name ||
                      node.remote_id ||
                      node.node_id ||
                      "Node",
                  ),
                  el(
                    "small",
                    "",
                    node.status ?? node.state ?? "Status not reported",
                  ),
                ]),
              ),
            ),
            el("div", "topology-summary", null, [
              el("span", "", countLabel(nodes.length, "node")),
              el(
                "span",
                "",
                source === "eve-ng"
                  ? `${segments.size} virtual segment`
                  : countLabel((topo.links || []).length, "link"),
              ),
              el("span", "", stamp(snapshot.observed_at)),
            ]),
          ]);
          if (topo.links?.length)
            section.append(
              el(
                "div",
                "topology-links",
                null,
                topo.links.map((link) =>
                  el(
                    "div",
                    "",
                    (link.endpoints || [])
                      .map(
                        (end) =>
                          `${end.device_id || remoteNames[end.remote_id] || end.remote_id || end.node_id || "node"}:${end.port_name ?? end.port_number ?? end.port ?? end.name ?? "port"}`,
                      )
                      .join(" ↔ ") ||
                      link.link_id ||
                      "Lab connection",
                  ),
                ),
              ),
            );
          if (segments.size)
            section.append(
              el(
                "div",
                "topology-links",
                null,
                [...segments].map(([networkId, endpoints]) =>
                  el(
                    "div",
                    "",
                    `Segment ${networkId} · ${endpoints.join(" ↔ ")}`,
                  ),
                ),
              ),
            );
          return section;
        })
      : [
          empty(
            "Topology awaits your network lab",
            "Enable the GNS3 or EVE-NG collector for your project or lab. Pair lab topology with a monitoring source for measured telemetry.",
          ),
        ],
  );
}
function renderSetup() {
  const sources = data?.connectors || [];
  const workers = (data?.services || []).filter((row) =>
    ["storage", "predictor"].includes(row.id),
  );
  const steps = [
    {
      title: "Workspace access",
      text: data
        ? "Authenticated Hub connection"
        : "Connect your Integration Hub token",
      ready: Boolean(data),
      view: "overview",
    },
    {
      title: "Field systems",
      text: `${sources.filter((row) => row.state === "healthy").length} healthy / ${sources.length || 5} connectors`,
      ready: sources.some((row) => row.state === "healthy"),
      view: "integrations",
    },
    {
      title: "Processing pipeline",
      text: "Storage and detection worker heartbeats",
      ready:
        workers.length === 2 && workers.every((row) => row.state === "healthy"),
      view: "operations",
    },
    {
      title: "AI providers",
      text: "Configure Groq and OpenAI Decisions",
      ready: Boolean(data?.ai.ready),
      view: "intelligence",
    },
    {
      title: "Review workflow",
      text: "Configure your approval endpoint",
      ready: Boolean(data?.ai.workflow_enabled),
      view: "settings",
    },
  ];
  $("#setup-progress").textContent = data
    ? `${steps.filter((step) => step.ready).length} / 5 setup steps ready`
    : "Connect your workspace to get started";
  replace(
    "#setup-grid",
    steps.map((step, index) => {
      const node = button(
        "",
        () =>
          step.view === "overview" && !data
            ? openDialog($("#auth-dialog"))
            : showView(step.view),
        `setup-step ${step.ready ? "complete" : ""}`,
      );
      node.append(
        el(
          "span",
          "setup-index",
          step.ready ? "✓" : String(index + 1).padStart(2, "0"),
        ),
        el("b", "", step.title),
        el("small", "", step.text),
        el(
          "span",
          "setup-state",
          data
            ? step.ready
              ? "Ready ↗"
              : "Set up ↗"
            : "Awaiting connection",
        ),
      );
      return node;
    }),
  );
}
const serviceRoles = {
  kafka: "Event transport",
  storage: "Raw & feature persistence",
  predictor: "ML & rule detection",
  minio: "Telemetry & model storage",
  "model-api": "Inference readiness",
  mlflow: "Model tracking",
  prometheus: "Metrics & alert rules",
  alertmanager: "Alert delivery",
  grafana: "Dashboards",
  airflow: "Scheduled processing",
};
function renderOperations() {
  const ops = data?.operations;
  const pipeline = ops?.pipeline;
  const lag = pipeline?.lag;
  const backlog = ops?.delivery;
  const ai = ops?.ai;
  const totalLag =
    lag?.storage != null && lag?.predictor != null
      ? lag.storage + lag.predictor
      : null;
  const kpis = [
    [
      "Consumer lag",
      observedNumber(totalLag),
      `Storage ${observedNumber(lag?.storage)} · detection ${observedNumber(lag?.predictor)}`,
    ],
    [
      "Delivery retries",
      observedNumber(backlog?.retrying),
      backlog?.oldest_pending_at
        ? `Oldest pending: ${ago(backlog.oldest_pending_at)}`
        : "Durable outbox · exponential backoff",
    ],
    [
      "Firing platform alerts",
      observedNumber(pipeline?.firing_alerts),
      `Dead-letter topic offset: ${observedNumber(pipeline?.dead_letter_offset)}`,
    ],
    [
      "AI runs today",
      ai ? `${number(ai.runs_today)} / ${number(ai.daily_limit)}` : "—",
      ai
        ? `${number(ai.ready_today)} ready · ${number(ai.failed_today)} failed · UTC day`
        : "Provider requests and daily budget",
    ],
  ];
  replace(
    "#operation-stats",
    kpis.map(([label, value, description]) =>
      el("article", "stat", null, [
        el("div", "", label),
        el("strong", "", value),
        el("p", "", description),
      ]),
    ),
  );
  const services =
    data?.services ||
    Object.entries(serviceRoles).map(([id]) => ({
      id,
      name:
        {
          storage: "Storage worker",
          predictor: "Detection worker",
          "model-api": "Model API",
          alertmanager: "Alertmanager",
          minio: "MinIO",
          mlflow: "MLflow",
        }[id] || id.charAt(0).toUpperCase() + id.slice(1),
      state: "unknown",
    }));
  const available = services.filter((row) =>
    ["healthy", "reachable"].includes(row.state),
  ).length;
  $("#platform-count").textContent = data
    ? `${available} / ${services.filter((row) => row.state !== "disabled").length} reachable`
    : "Awaiting data";
  replace(
    "#platform-grid",
    services.map((row) => {
      const node = button("", () => serviceDetail(row), "platform-card");
      node.append(
        el("div", "platform-head", null, [
          el("b", "", row.name),
          tag(row.state),
        ]),
        el("p", "", serviceRoles[row.id] || "Platform service"),
        el(
          "small",
          "",
          row.checked_at
            ? `Probed ${stamp(row.checked_at)}`
            : "No probe received",
        ),
      );
      if (row.metrics)
        node.append(
          el("div", "worker-counts", null, [
            el(
              "span",
              "",
              `${observedNumber(row.metrics.processed_events_total)} processed`,
            ),
            el(
              "span",
              "",
              `${observedNumber(row.metrics.buffered_events)} buffered`,
            ),
          ]),
        );
      return node;
    }),
  );
  const devices = new Map();
  for (const snapshot of Object.values(data?.inventory || {})) {
    for (const device of snapshot.data) {
      if (
        !devices.has(device.device_id) ||
        devices.get(device.device_id).region === "unknown"
      )
        devices.set(device.device_id, device);
    }
  }
  const regions = new Map();
  function region(name) {
    name = name || "unknown";
    if (!regions.has(name))
      regions.set(name, { name, devices: 0, incidents: 0, critical: 0 });
    return regions.get(name);
  }
  for (const device of devices.values()) region(device.region).devices += 1;
  for (const incident of data?.incidents || []) {
    if (incident.state !== "open") continue;
    const row = region(incident.region);
    row.incidents += 1;
    row.critical += incident.severity === "critical";
  }
  replace(
    "#region-list",
    regions.size
      ? [...regions.values()]
          .sort(
            (a, b) =>
              b.critical - a.critical ||
              b.incidents - a.incidents ||
              a.name.localeCompare(b.name),
          )
          .map((row) =>
            el("div", "region-row", null, [
              el("span", "region-mark", null, [icon("inventory")]),
              el("div", "", null, [
                el("b", "", row.name),
                el("small", "", countLabel(row.devices, "observed device")),
              ]),
              tag(
                row.critical
                  ? "critical"
                  : row.incidents
                    ? "warning"
                    : "disabled",
                `${row.incidents} open`,
              ),
            ]),
          )
      : [
          empty(
            "Your network footprint",
            "Connect inventory and telemetry to view devices and incidents by region.",
          ),
        ],
  );
  const events = backlog?.recent || [];
  $("#delivery-count").textContent = backlog
    ? `${number(backlog.pending)} pending · ${number(backlog.sent)} acknowledged`
    : "Awaiting delivery data";
  if (!events.length)
    replace("#delivery-table", [
      empty(
        "No delivery events yet",
        "Ingested telemetry, incident transitions, and AI reviews appear here with their delivery state.",
      ),
    ]);
  else {
    const table = el("table", "delivery-ledger", null, [
      el("thead", "", null, [
        el(
          "tr",
          "",
          null,
          [
            "EVENT",
            "DESTINATION",
            "STATE",
            "RETRIES",
            "CREATED",
            "NEXT / ACKNOWLEDGED",
            "",
          ].map((label) => el("th", "", label)),
        ),
      ]),
    ]);
    table.append(
      el(
        "tbody",
        "",
        null,
        events.map((row) =>
          el("tr", "", null, [
            el("td", "event-id", row.event_id),
            el("td", "", row.kind === "kafka" ? "Kafka" : "Review workflow"),
            el("td", "", null, [
              tag(
                row.state === "pending" && row.attempts
                  ? "retrying"
                  : row.state,
              ),
            ]),
            el("td", "", number(row.attempts)),
            el(
              "td",
              "",
              row.created_at ? stamp(row.created_at) : "Age not recorded",
            ),
            el(
              "td",
              "",
              row.state === "sent"
                ? row.delivered_at
                  ? stamp(row.delivered_at)
                  : "Time not recorded"
                : row.attempts
                  ? stamp(new Date(row.next_attempt * 1000).toISOString())
                  : "Ready for delivery",
            ),
            el("td", "", null, [
              button("Details ↗", () => deliveryDetail(row), "text-button"),
            ]),
          ]),
        ),
      ),
    );
    replace("#delivery-table", [el("div", "table-wrap", null, [table])]);
  }
  $("#operations-updated").textContent = data
    ? `Snapshot ${stamp(data.time)} · probes ${stamp(pipeline?.checked_at)}`
    : "No operational snapshot yet";
  $("#export-operations").disabled = !ops;
}
function serviceDetail(row) {
  const nodes = [
    line("Role", serviceRoles[row.id] || "Platform service"),
    line("Status", stateLabels[row.state] || row.state),
    line("Checked at", stamp(row.checked_at)),
    line(
      "Probe duration",
      row.latency_ms != null ? `${row.latency_ms} ms` : "—",
    ),
    el(
      "div",
      "policy-note",
      row.detail || "Connect your workspace to receive service probes.",
    ),
  ];
  if (row.metrics) {
    const metrics = row.metrics;
    const time = (value) =>
      value > 0
        ? stamp(new Date(value * 1000).toISOString())
        : "No completed batch yet";
    nodes.push(
      el("h3", "detail-section-title", "Worker telemetry"),
      line("Heartbeat", time(metrics.heartbeat_timestamp_seconds)),
      line(
        "Last acknowledged batch",
        time(metrics.last_success_timestamp_seconds),
      ),
      line("Processed events", observedNumber(metrics.processed_events_total)),
      line("Buffered events", observedNumber(metrics.buffered_events)),
      line(
        "Quarantined events",
        observedNumber(metrics.quarantined_events_total),
      ),
      line("Rule fallbacks", observedNumber(metrics.rule_fallbacks_total)),
      line("Recovery errors", observedNumber(metrics.errors_total)),
      el(
        "p",
        "muted",
        "Counters describe this worker process and reset on restart. Processed counts advance after durable acknowledgement.",
      ),
    );
  }
  if (row.components)
    for (const [name, value] of Object.entries(row.components))
      nodes.push(line(name, value));
  if (row.model) {
    nodes.push(
      el("h3", "detail-section-title", "Active model"),
      line("Model", row.model.name),
      line("Features", row.model.features.join(", ")),
    );
    for (const [name, value] of Object.entries(row.model.training))
      nodes.push(line(name.replaceAll("_", " "), value));
  }
  detail(row.name, nodes, "PLATFORM HEALTH");
}
function deliveryDetail(row) {
  detail(
    "Delivery event",
    [
      line("Event", row.event_id),
      line("Destination", row.kind === "kafka" ? "Kafka" : "Review workflow"),
      line("State", row.state),
      line("Attempts", row.attempts),
      line(
        "Created",
        row.created_at
          ? stamp(row.created_at)
          : "Not recorded for this legacy event",
      ),
      line(
        "Acknowledged",
        row.delivered_at ? stamp(row.delivered_at) : "Not recorded",
      ),
      line("Latest error", row.last_error),
      el(
        "div",
        "policy-note",
        "Acknowledgement confirms destination acceptance. Network recovery is tracked through new telemetry and incident transitions.",
      ),
    ],
    "DELIVERY LEDGER",
  );
}
function downloadJSON(filename, value) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = el("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("#export-audit").addEventListener("click", () => {
  if (!data?.decisions?.length) return;
  downloadJSON(
    `strata-decision-audit-${new Date().toISOString().slice(0, 10)}.json`,
    {
      product: "Strata",
      exported_at: new Date().toISOString(),
      scope: "Latest 100 decision audits",
      decisions: data.decisions,
    },
  );
  toast("Decision audit exported.");
});
$("#export-operations").addEventListener("click", () => {
  if (!data?.operations) return;
  const { time, summary, connectors, services, operations } = data;
  downloadJSON(
    `strata-operations-${new Date().toISOString().slice(0, 10)}.json`,
    {
      product: "Strata",
      exported_at: new Date().toISOString(),
      snapshot_at: time,
      summary,
      connectors,
      services,
      operations,
    },
  );
  toast("Operational snapshot exported.");
});
function render() {
  renderConnectors();
  renderServices();
  renderIncidents();
  providerRows();
  renderDecisions();
  renderInventory();
  renderSetup();
  renderOperations();
  $("#notice").hidden = Boolean(data);
  $("#session-button").textContent = token ? "Disconnect" : "Hub token";
  if (data) {
    $("#stat-connectors").replaceChildren(
      document.createTextNode(number(data.summary.healthy_connectors)),
      el("small", "", `/ ${data.summary.total_connectors}`),
    );
    $("#stat-devices").textContent = number(data.summary.devices);
    $("#stat-incidents").textContent = number(data.summary.active_incidents);
    $("#stat-backlog").textContent = number(data.outbox.pending);
    $("#stat-connectors-detail").textContent =
      `${data.connectors.filter((row) => row.state === "disabled").length} disabled · ${data.connectors.filter((row) => ["error", "stale"].includes(row.state)).length} need attention`;
    $("#stat-backlog-detail").textContent =
      `${number(data.outbox.sent)} events acknowledged by destination`;
    $("#nav-incidents").textContent = data.summary.active_incidents;
    $("#ai-ready-label").textContent = data.ai.ready
      ? "Providers configured · analysis on demand"
      : "Provider setup required · no AI calls made";
    $("#updated-at").textContent = `Snapshot ${stamp(data.time)}`;
  } else {
    ["devices", "incidents", "backlog"].forEach((key) => {
      $(`#stat-${key}`).textContent = "—";
    });
    $("#stat-connectors").replaceChildren(
      document.createTextNode("—"),
      el("small", "", "/ 5"),
    );
    $("#stat-connectors-detail").textContent =
      "Waiting for your Integration Hub";
    $("#stat-backlog-detail").textContent =
      "Durable delivery · Kafka & workflow";
    $("#nav-incidents").textContent = "0";
    $("#ai-ready-label").textContent = "Waiting for provider configuration";
    $("#updated-at").textContent = "No snapshot yet";
  }
}
async function refresh(showErrors = true) {
  if (!token || refreshing) return false;
  refreshing = true;
  document.body.classList.add("is-loading");
  const version = sessionVersion;
  $("#refresh").disabled = true;
  try {
    const snapshot = await api("/console/overview");
    if (version !== sessionVersion) return false;
    const changed =
      JSON.stringify(data?.summary) !== JSON.stringify(snapshot.summary);
    data = snapshot;
    $("#error").hidden = true;
    $("#connection").className = "live-label connected";
    $("#connection").replaceChildren(
      el("span", "status-dot"),
      document.createTextNode("Hub connected"),
    );
    render();
    if (changed) {
      document.body.classList.add("is-updated");
      setTimeout(() => document.body.classList.remove("is-updated"), 650);
    }
    return true;
  } catch (error) {
    if (version !== sessionVersion) return false;
    $("#connection").className = "live-label offline";
    $("#connection").replaceChildren(
      el("span", "status-dot"),
      document.createTextNode("Connection lost"),
    );
    if (showErrors) {
      $("#error").textContent =
        `${error.message}${data ? " Showing the last snapshot; updates are currently unavailable." : ""}`;
      $("#error").hidden = false;
    }
    if ($("#auth-dialog").open) $("#auth-error").textContent = error.message;
    return false;
  } finally {
    refreshing = false;
    document.body.classList.remove("is-loading");
    $("#refresh").disabled = false;
  }
}
function detail(title, content, eyebrow = "INCIDENT DETAILS") {
  $("#detail-title").textContent = title;
  $("#detail-eyebrow").textContent = eyebrow;
  replace("#detail-content", content);
  if (!$("#detail-dialog").open) openDialog($("#detail-dialog"));
}
function line(label, value) {
  return el("div", "detail-line", null, [
    el("b", "", label),
    el("code", "", value ?? "—"),
  ]);
}
function connectorDetail(row) {
  detail(
    names[row.id] || row.id,
    [
      el("p", "", descriptions[row.id] || "Collector"),
      line("Status", stateLabels[row.state] || row.state),
      line("Devices", row.devices),
      line("Metrics / poll", row.metrics),
      line("Observed", stamp(row.observed_at)),
      line("Collector checked", stamp(row.checked_at)),
      line("Enable variable", `${row.enabled_env || "see .env.example"}=true`),
      line("URL variable", row.url_env || "see .env.example"),
      el(
        "div",
        "policy-note",
        row.error_type
          ? `Collector error: ${row.error_type}`
          : "Set endpoint and credentials in the server .env, then restart the Integration Hub.",
      ),
    ],
    "FIELD INTEGRATION",
  );
}
async function incidentDetail(row) {
  const nodes = [
    line("Source", row.source),
    line("Status", row.state),
    line("Severity", row.severity),
    line("Observed", stamp(row.timestamp)),
    line("Method", row.method),
    el("h3", "detail-section-title", "Saved evidence"),
    el("pre", "evidence", JSON.stringify(row.evidence, null, 2)),
  ];
  if (row.state === "open") {
    const analyze = button(
      "✧ Analyze with Groq & Decisions",
      () => analyzeIncident(row),
      "button primary",
    );
    analyze.disabled = busy || !data?.ai.ready;
    nodes.push(
      analyze,
      el(
        "p",
        "",
        data?.ai.ready
          ? "Selected incident facts will be sent to both AI providers."
          : "Configure AI providers in the server .env to run an analysis.",
      ),
    );
  }
  detail(row.device_id, nodes);
  try {
    const history = await api(
      `/incidents/${encodeURIComponent(row.incident_id)}/history`,
    );
    if (
      $("#detail-dialog").open &&
      $("#detail-title").textContent === row.device_id
    ) {
      $("#detail-content").append(
        el("h3", "detail-section-title", "Transition history"),
        ...history.map((item) =>
          el("div", "history-item", null, [
            tag(item.state),
            el(
              "span",
              "",
              `v${item.version} · ${stamp(item.updated_at)} · ${item.severity}`,
            ),
          ]),
        ),
      );
    }
  } catch (error) {
    if (error.status !== 404) toast(error.message);
  }
}
function decisionDetail(run) {
  const metadata = [
    line("Decision ID", run.id),
    line("Model", `${run.models?.analysis} → ${run.models?.decision}`),
    line("Incident version", run.incident_version),
    line("Evidence hash", run.evidence_hash),
    line("Created", stamp(run.created_at)),
    line("Status", run.status),
    line("Provider stage", run.stage || "—"),
  ];
  if (run.usage)
    metadata.push(
      el("h3", "detail-section-title", "Token usage & latency"),
      el(
        "pre",
        "evidence",
        JSON.stringify(
          { usage: run.usage, latency_ms: run.latency_ms },
          null,
          2,
        ),
      ),
    );
  const nodes = [];
  if (run.decision)
    nodes.push(
      el("div", "decision-summary", null, [
        el("span", "eyebrow", "RECOMMENDED NEXT STEP"),
        el("h3", "", actionLabels[run.decision.action] || run.decision.action),
        el("div", "decision-summary-meta", null, [
          el(
            "span",
            "",
            `${Math.round(run.decision.confidence * 100)}% confidence`,
          ),
          tag(
            run.policy?.eligible_for_review ? "healthy" : "disabled",
            run.policy?.eligible_for_review
              ? "Eligible for review"
              : "Review blocked",
          ),
        ]),
      ]),
    );
  if (run.analysis) {
    nodes.push(
      el("h3", "detail-section-title", "Groq analysis"),
      el("p", "", run.analysis.summary),
      el("p", "", `Hypothesis: ${run.analysis.probable_cause}`),
      el("p", "", run.analysis.rationale),
      el("h3", "detail-section-title", "Evidence & gap"),
      el(
        "pre",
        "evidence",
        JSON.stringify(
          {
            evidence: run.analysis.evidence,
            missing_evidence: run.analysis.missing_evidence,
          },
          null,
          2,
        ),
      ),
    );
  }
  if (run.decision) {
    nodes.push(
      el("h3", "detail-section-title", "OpenAI Decisions"),
      line("Next step", actionLabels[run.decision.action]),
      line("Confidence", `${Math.round(run.decision.confidence * 100)}%`),
      line(
        "Evidence probability",
        `${Math.round(run.decision.evidence_probability * 100)}%`,
      ),
      el(
        "div",
        "probability-list",
        null,
        Object.entries(run.decision.probabilities)
          .sort((a, b) => b[1] - a[1])
          .map(([action, probability]) => {
            const meter = el("meter", "probability-meter");
            meter.min = 0;
            meter.max = 1;
            meter.value = probability;
            meter.setAttribute(
              "aria-label",
              `${actionLabels[action] || action} probability`,
            );
            return el("div", "probability-row", null, [
              el("span", "", actionLabels[action] || action),
              meter,
              el("b", "", `${Math.round(probability * 100)}%`),
            ]);
          }),
      ),
    );
  }
  const blockers = run.policy?.blockers || [];
  nodes.push(
    el("div", "policy-note", null, [
      el(
        "b",
        "",
        run.policy?.eligible_for_review
          ? "Policy: eligible for operator review"
          : "Policy: review gate closed",
      ),
      el(
        "p",
        "",
        blockers.map((code) => errors[code] || code).join(" ") ||
          "Review requests require your operational approval process.",
      ),
    ]),
  );
  if (run.status === "ready") {
    const review = button(
      run.review_status === "queued"
        ? "Review request already queued"
        : "Submit review request",
      async () => {
        review.disabled = true;
        try {
          const result = await api(
            `/ai/decisions/${encodeURIComponent(run.id)}/request-review`,
            { method: "POST" },
          );
          toast(
            "Review request saved to the durable outbox. Network execution remains with your workflow.",
          );
          await refresh();
          decisionDetail(result);
        } catch (error) {
          toast(error.message);
          review.disabled = false;
        }
      },
      "button primary full",
    );
    review.disabled =
      run.review_status === "queued" ||
      !run.policy?.eligible_for_review ||
      !data?.ai.workflow_enabled ||
      !data?.ai.enabled;
    nodes.push(
      el(
        "p",
        "",
        data?.ai.workflow_enabled
          ? "The server rechecks current evidence before queuing a review."
          : "Set WORKFLOW_WEBHOOK_URL and enable WORKFLOW_ENABLED to connect your review workflow.",
      ),
      review,
    );
  }
  if (run.error_code)
    nodes.push(el("p", "", errors[run.error_code] || run.error_code));
  nodes.push(
    el("details", "audit-disclosure", null, [
      el("summary", "", "Audit metadata & provider usage"),
      el("div", "audit-disclosure-content", null, metadata),
    ]),
  );
  detail(run.device_id, nodes, "AI DECISION AUDIT");
}
async function analyzeIncident(row) {
  if (busy) return;
  busy = true;
  const version = sessionVersion;
  renderIncidents();
  if ($("#detail-dialog").open) closeDialog($("#detail-dialog"));
  toast(
    "Groq is analyzing evidence, then OpenAI Decisions will evaluate the next step…",
    0,
  );
  try {
    const run = await api(
      `/incidents/${encodeURIComponent(row.incident_id)}/analyze`,
      { method: "POST" },
    );
    if (version !== sessionVersion) return;
    showView("intelligence");
    await refresh();
    decisionDetail(run);
    toast(
      run.cached
        ? "A saved decision for this evidence was retrieved."
        : "Analysis and decision saved. Review the evidence and policy checks.",
    );
  } catch (error) {
    if (version !== sessionVersion) return;
    toast(error.message);
    await refresh();
  } finally {
    busy = false;
    renderIncidents();
  }
}
document
  .querySelectorAll("[data-view]")
  .forEach((node) =>
    node.addEventListener("click", () => showView(node.dataset.view)),
  );
$("#search").addEventListener("input", (event) => {
  query = event.target.value.trim().toLowerCase();
  renderIncidents();
  renderDecisions();
  renderInventory();
});
$("#incident-filters").addEventListener("click", (event) => {
  const node = event.target.closest("[data-filter]");
  if (!node) return;
  incidentFilter = node.dataset.filter;
  document
    .querySelectorAll("[data-filter]")
    .forEach((item) => item.classList.toggle("selected", item === node));
  renderIncidents();
});
$("#refresh").addEventListener("click", () => {
  if (token) refresh();
  else openDialog($("#auth-dialog"));
});
$("#connect").addEventListener("click", () => openDialog($("#auth-dialog")));
$("#session-button").addEventListener("click", () => {
  if (token) {
    sessionVersion += 1;
    token = "";
    data = null;
    if ($("#detail-dialog").open) closeDialog($("#detail-dialog"));
    render();
    $("#error").hidden = true;
    $("#connection").className = "live-label";
    $("#connection").replaceChildren(
      el("span", "status-dot"),
      document.createTextNode("Not connected"),
    );
    toast("Workspace disconnected.");
  } else openDialog($("#auth-dialog"));
});
$("#close-auth").addEventListener("click", () =>
  closeDialog($("#auth-dialog")),
);
$("#close-detail").addEventListener("click", () =>
  closeDialog($("#detail-dialog")),
);
$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = $("#auth-form [type=submit]");
  submit.disabled = true;
  $("#auth-error").textContent = "";
  sessionVersion += 1;
  token = $("#hub-token").value.trim();
  try {
    if (await refresh()) {
      $("#hub-token").value = "";
      closeDialog($("#auth-dialog"));
      toast("Workspace connected. Snapshots refresh automatically.");
    } else {
      token = "";
      render();
    }
  } finally {
    submit.disabled = false;
  }
});
window.addEventListener("hashchange", () =>
  showView(location.hash.slice(1), false),
);
setInterval(() => {
  if (token && !document.hidden && !busy) refresh();
}, 10000);
document.addEventListener("visibilitychange", () => {
  if (token && !document.hidden && !busy) refresh();
});
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog(dialog);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      closeDialog(dialog);
  });
});
document.addEventListener("keydown", (event) => {
  if (
    event.key !== "/" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    document.querySelector("dialog[open]") ||
    /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)
  )
    return;
  event.preventDefault();
  $("#search").focus();
});
enhanceIcons();
showView(location.hash.slice(1) || "twin", false);
render();
