"""Create a separate online environment, or validate it without printing secrets."""
import argparse
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / ".env.online"
TOKEN = ROOT / "deploy/secrets/cloudflare_tunnel_token"


def prepare():
    text = (ROOT / ".env.example").read_text(encoding="utf-8")
    for key in ("INTEGRATION_API_TOKEN", "MINIO_SECRET_KEY", "GRAFANA_ADMIN_PASSWORD", "AIRFLOW_ADMIN_PASSWORD"):
        text = re.sub(rf"^{key}=.*$", f"{key}={secrets.token_urlsafe(48)}", text, flags=re.M)
    text = re.sub(r"^COMPOSE_PROJECT_NAME=.*$", "COMPOSE_PROJECT_NAME=strata-online", text, flags=re.M)
    text += ("\n# Online mode remains blocked until Access and a named tunnel are configured.\n"
             "STRATA_DEPLOYMENT_MODE=online\n"
             "CF_ACCESS_TEAM_DOMAIN=https://REPLACE_TEAM.cloudflareaccess.com\n"
             "CF_ACCESS_AUDIENCE=REPLACE_ACCESS_AUDIENCE\n"
             f"STRATA_OPERATOR_TOKEN={secrets.token_urlsafe(48)}\n"
             f"STRATA_TUNNEL_UID={os.getuid() if hasattr(os, 'getuid') else 1000}\n"
             f"STRATA_TUNNEL_GID={os.getgid() if hasattr(os, 'getgid') else 1000}\n")
    try:
        with ENV.open("x", encoding="utf-8") as stream:
            stream.write(text)
    except FileExistsError:
        raise SystemExit(".env.online already exists; it was preserved. Edit it and run --check.") from None
    if os.name != "nt":
        ENV.chmod(0o600)
    TOKEN.parent.mkdir(parents=True, exist_ok=True)
    print("Created .env.online with separate generated credentials. Existing .env was preserved.")
    print("Next: configure Cloudflare Access/tunnel using docs/ONLINE_DEPLOYMENT.md, then run --check.")


def check():
    if not ENV.is_file():
        raise SystemExit("Run this script without --check to create .env.online first.")
    values = dotenv_values(ENV)
    issues = []
    for key in ("INTEGRATION_API_TOKEN", "MINIO_SECRET_KEY", "GRAFANA_ADMIN_PASSWORD",
                "AIRFLOW_ADMIN_PASSWORD", "STRATA_OPERATOR_TOKEN"):
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,}", values.get(key) or ""):
            issues.append(f"{key} must be a generated URL-safe secret of at least 32 characters")
    if values.get("STRATA_OPERATOR_TOKEN") == values.get("INTEGRATION_API_TOKEN"):
        issues.append("Workspace and Hub tokens must be different")
    try:
        domain = urlsplit(values.get("CF_ACCESS_TEAM_DOMAIN") or "")
        if (domain.scheme != "https" or not domain.hostname or "replace" in domain.hostname.lower() or
                not domain.hostname.endswith(".cloudflareaccess.com") or domain.path or domain.query or
                domain.fragment or domain.username or domain.password or domain.port):
            issues.append("Set CF_ACCESS_TEAM_DOMAIN to your real https://TEAM.cloudflareaccess.com domain")
    except ValueError:
        issues.append("CF_ACCESS_TEAM_DOMAIN is invalid")
    audience = values.get("CF_ACCESS_AUDIENCE") or ""
    if not audience or audience.startswith("REPLACE_"):
        issues.append("Set CF_ACCESS_AUDIENCE to your Access application audience tag")
    if values.get("STRATA_DEPLOYMENT_MODE") != "online":
        issues.append("STRATA_DEPLOYMENT_MODE must be online")
    if not TOKEN.is_file() or len(TOKEN.read_text(encoding="utf-8").strip()) < 32:
        issues.append("Save the named tunnel token in deploy/secrets/cloudflare_tunnel_token")
    if issues:
        raise SystemExit("Online preflight needs configuration:\n- " + "\n- ".join(issues))
    print("Local configuration checks passed. This does not verify Cloudflare policy, HTTPS or live connectivity.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    check() if args.check else prepare()
