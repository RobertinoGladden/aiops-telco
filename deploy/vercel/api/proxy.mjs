import { createHash, timingSafeEqual } from "node:crypto";

const routes = {
  overview: ["GET", "/console/overview"],
  connectors: ["GET", "/connectors"],
  inventory: ["GET", "/inventory"],
  topology: ["GET", "/topology"],
  incidents: ["GET", "/incidents"],
  aiStatus: ["GET", "/ai/status"],
  decisions: ["GET", "/ai/decisions"],
  history: ["GET", (id) => `/incidents/${id}/history`],
  analyze: ["POST", (id) => `/incidents/${id}/analyze`],
  review: ["POST", (id) => `/ai/decisions/${id}/request-review`],
};
const digest = (value) => createHash("sha256").update(value).digest();
const secretPattern = /^[A-Za-z0-9_-]{32,}$/;

function reply(res, status, detail) {
  return res.status(status).json({ detail });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const route = typeof req.query?.route === "string" && Object.hasOwn(routes, req.query.route) && routes[req.query.route];
  if (!route) return reply(res, 404, "Unknown console route");
  if (req.method !== route[0]) return reply(res, 405, "Method not allowed");
  if (typeof route[1] === "function" && (typeof req.query?.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(req.query.id)))
    return reply(res, 400, "Invalid record ID");

  const operatorToken = process.env.STRATA_OPERATOR_TOKEN || "";
  const hubToken = process.env.STRATA_HUB_TOKEN || "";
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!secretPattern.test(operatorToken) || !secretPattern.test(hubToken) ||
      operatorToken === hubToken || !clientId || !clientSecret)
    return reply(res, 503, "Online console is not configured");
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || authorization.length > 512 ||
      !timingSafeEqual(digest(authorization), digest(`Bearer ${operatorToken}`)))
    return reply(res, 401, "Invalid workspace access token");

  let origin;
  try {
    origin = new URL(process.env.STRATA_BACKEND_URL);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.port ||
        origin.pathname !== "/" || origin.search || origin.hash ||
        !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(origin.hostname) ||
        /^\d+(?:\.\d+){3}$/.test(origin.hostname) ||
        /\.(?:localhost|local|internal|trycloudflare\.com)$/i.test(origin.hostname))
      throw new Error("Invalid configured origin");
  } catch {
    return reply(res, 503, "Online backend URL is not configured");
  }
  // The UI's mutation routes have no request payload. Never forward arbitrary bodies or headers.
  if (req.body && Object.keys(req.body).length)
    return reply(res, 400, "This console action does not accept a payload");
  const path = typeof route[1] === "function" ? route[1](req.query.id) : route[1];
  try {
    const upstream = await fetch(new URL(path, origin), {
      method: route[0], redirect: "manual", signal: AbortSignal.timeout(55000),
      headers: {
        Authorization: `Bearer ${hubToken}`,
        "CF-Access-Client-Id": clientId,
        "CF-Access-Client-Secret": clientSecret,
        Accept: "application/json",
      },
    });
    if (upstream.status >= 300 && upstream.status < 400)
      return reply(res, 502, "Backend access policy rejected the connection");
    if (!upstream.headers.get("content-type")?.includes("application/json"))
      return reply(res, 502, "Backend returned an unexpected response");
    const body = await upstream.json();
    // Do not pass origin cookies, authentication headers or detailed exceptions to the browser.
    if (!upstream.ok)
      return reply(res, upstream.status >= 500 ? 502 : upstream.status,
        typeof body.detail === "string" ? body.detail : "Backend rejected the request");
    return res.status(upstream.status).json(body);
  } catch {
    return reply(res, 502, "Strata backend is unavailable. Keep the collector host running.");
  }
}
