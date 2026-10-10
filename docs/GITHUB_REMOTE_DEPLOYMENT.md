# Remote pilot through GitHub and Vercel

The complete deployment described here keeps Strata available when your development laptop is off: GitHub stores the source, Vercel builds the console and its bounded proxy, and remote compute runs the continuous backend. Cloudflare Access and a named tunnel protect the server-hosted backend HTTPS endpoint. Physical drive-test equipment still needs an active collector near the equipment or on an independently connected device; a cloud dashboard cannot collect new readings from a powered-off field collector.

**For the current situation (no VPS, no personal server and no paid cloud budget), follow steps 1 and 2 for a frontend preview.** The complete backend is not hosted by that preview. The zero-budget testing architecture below requires further implementation; the server instructions from step 3 onward are an optional future route, not prerequisites for uploading the source.

The current repository is `https://github.com/RobertinoGladden/aiops-telco`. Its public main branch still contains the older Telco AIOps files. Upload the updated source before importing it into Vercel. This local workspace came from a ZIP and has no project-local Git repository: its inherited Git root is the Windows home directory. Initialize Git inside this project before staging anything. The upload workflow below uses `git remote`, without cloning.

## 1. Upload the current source to GitHub

For this existing Downloads workspace, run the following in PowerShell. The remote already contains a main branch, so fetch that history before creating the update commit:

```powershell
cd C:\Users\lapt1\Downloads\aiops-telco-main
git init -b main
git remote add origin https://github.com/RobertinoGladden/aiops-telco.git
git fetch origin main
git reset --mixed --quiet origin/main
```

This is a first-time setup for a folder without its own `.git`. `reset --mixed` adopts the fetched history and index while preserving all current working files. Do not substitute `--hard`, which would replace working files. No clone or unrelated-history merge is needed. If the fetch fails, stop before running reset or continuing. If you already added origin, use `git remote -v` to inspect it; use `git remote set-url origin ...` only to correct the existing URL.

Stage only the application source/configuration directories and named root files, avoiding the legacy tracked virtual environment:

```powershell
git add .gitignore .dockerignore .env.example README.md Dockerfile docker-compose.yml requirements.txt requirements-dev.txt console.ps1 start.ps1 status.ps1 stop.ps1 train.ps1
git add aiops api consumer predictor model integrations config console deploy scripts monitoring grafana airflow tests docs
git diff --cached --stat
git commit -m "Update Strata console and GitHub deployment"
git push -u origin main
```

Review the staged list before committing; secrets and runtime data must not appear. This selected staging leaves the remote's older tracked `venv/` untouched rather than uploading the changed local packages. Follow Git's browser credential flow if push requires authentication. Configure your local Git name/email if commit reports missing author information. A normal push retains the remote history; a concurrent update may require fetch/review before retrying. Do not use force push to bypass that condition.

After this first synchronization, future reviewed source updates only need add, commit and push. Do not rerun the initial reset after creating local commits. Vercel will build from the commit, so generated `dist` folders do not need to be committed.

### Optional browser-upload alternative

The export helper creates a separate source folder from the runtime's known directories:

```powershell
cd C:\Users\lapt1\Downloads\aiops-telco-main
.\venv\Scripts\python.exe scripts/package_github.py
```

Open `dist/github-upload`. On GitHub, open the repository root and select **Add file → Upload files**. Drag the folder's contents into the upload area, preserving `console/`, `deploy/`, `scripts/` and the other directory names. Upload the contents at the repository root; do not add an outer `github-upload/` or `aiops-telco-main/` directory. Commit the source update to the intended branch, such as main for this pilot. Browser uploads allow up to 100 files at a time and 25 MiB per file; if needed, upload top-level folders in batches before importing Vercel. A ZIP file stored in the repository does not provide runnable source files.

The package excludes `.env`, `.env.online`, tunnel secrets, runtime databases and virtual environments. `.env.example` contains configuration examples and is included intentionally. The export is a new folder and refuses to overwrite a prior export. It does not certify arbitrary source edits as secret-free; review the files before publishing. Remove the older tracked `venv/` folder from GitHub when convenient because it is a local environment, not deployable source. Adding it to `.gitignore` does not untrack existing committed files.

The browser upload is optional. The primary workflow for this project is the Git initialization/remote/push method above.

## 2. Import the GitHub repository into Vercel

In the Vercel dashboard, choose **Add New → Project**, connect GitHub and import `RobertinoGladden/aiops-telco`. Grant access to this repository. Configure:

| Setting | Value |
|---|---|
| Framework Preset | Other |
| Root Directory | `deploy/vercel` |
| Build Command | `node build.mjs` |
| Output Directory | `public` |
| Install Command | Empty; there are no Node dependencies |
| Node.js | 22.x, matching package.json |
| Production Branch | The branch containing your updated source, normally main |
| Include source files outside of the Root Directory in the Build Step | Enabled |

The last setting allows the build to read the repository's `console/` directory. The build copies only the known console files into `public/`, changes the login copy to the operator token, and leaves the proxy in `api/proxy.mjs`. Python dependencies and Kafka are not installed by this Vercel project. The configuration is in `deploy/vercel/vercel.json`. Leave Skip deployment disabled initially so edits to `console/` also trigger a fresh build.

You can deploy the UI before provisioning the backend. It will show a sign-in page; the API returns a configuration/unavailable error until the server variables and backend exist. This is a frontend deployment, not a live telemetry demonstration.

### Testing with no paid cloud budget

The next implementation direction is a smaller cloud testing backend: bounded HTTP API handlers, managed Postgres/authentication, explicit sample telemetry or user-uploaded test data, and incident processing triggered by requests. Supabase offers a free database/authentication tier, but projects pause after a week of inactivity and the free tier has storage/usage limits and no uptime SLA. See [Supabase pricing](https://supabase.com/pricing). This would allow stored test data to be accessed without the development laptop while avoiding permanent Kafka/MLflow/monitoring processes in the testing deployment.

This lighter backend, cloud login and sample-data workflow are **not implemented in the current repository**. The existing Vercel API is a proxy to the protected Hub, not a replacement for it; inventing backend URLs or leaving dummy Cloudflare credentials does not make it work. Adapting the backend also means replacing local SQLite/runtime files with managed storage and defining authenticated ingest and operator access. Private field tools still require an active collector or a reachable vendor API. External AI requires valid provider access and its own usage allowance; do not assume hosting credits pay for AI requests.

[Vercel Functions have bounded execution durations](https://vercel.com/docs/functions/limitations), so the current continuous workers cannot simply be uploaded as functions. [Vercel Hobby is for personal, non-commercial use](https://vercel.com/docs/plans/hobby); evaluate the appropriate plan before using the deployment for commercial startup operations. A free testing architecture is a different deployment target from the current full pipeline and is not a promise of production availability.

## 3. Provision a remote Docker host

If you have no VPS or personal server, a managed container platform can provide the backend compute without you administering a VPS. Railway, for example, deploys GitHub/Dockerfile services and offers persistent volumes and provider-generated domains. It does **not** run this Compose file directly: each service, private address, startup command and volume must be translated to its platform. The current Cloudflare-based origin/proxy configuration also needs adaptation to a provider-native authentication boundary if no domain/Cloudflare account is available. This is a separate deployment path, not a verified one-click setup in the current repository. See [Railway's Compose translation guide](https://docs.railway.com/guides/docker-compose) and [pricing](https://railway.com/pricing).

The full Kafka/MinIO/MLflow/worker/monitoring pipeline consumes multiple persistent services. A small free web-service allowance is not equivalent to hosting the full pipeline continuously. If no paid cloud budget exists, deploy the frontend first, or plan a lighter testing backend with managed storage and request-driven processing; that lighter backend is not implemented here. The sections below remain the optional server-hosted setup.

You need a continuously running Linux server with persistent storage, Docker Engine and current Docker Compose. A VPS is one option; an existing always-on server reachable through an outbound tunnel also works. Vercel does not supply this host in this configuration. Select CPU/RAM/storage based on pilot traffic and the Kafka/ML/monitoring services you enable, then measure actual resource use before a customer pilot.

Install Docker from [the official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/) for your supported OS. Use an account authorized to run Docker. On Ubuntu, install Python venv support and Git if absent, then clone your updated repository:

```bash
git clone https://github.com/RobertinoGladden/aiops-telco.git
cd aiops-telco
python3 -m venv .venv
.venv/bin/python -m pip install python-dotenv==1.2.2
.venv/bin/python scripts/prepare_online.py
```

Install the `python3-venv` package through your OS package manager if creating the venv fails because it is missing. Application dependencies run in the Docker image; the host-side preparation script needs only python-dotenv. Generate `.env.online` on the server rather than publishing the laptop's secret file. The script preserves any existing online environment.

## 4. Configure Cloudflare before starting the backend

Have a domain managed in your Cloudflare account and choose a backend hostname, such as `api.your-domain.example`. In Cloudflare Zero Trust:

1. Create an Access application covering the whole backend hostname. Create a service token for the Vercel proxy and a **Service Auth** policy restricted to that token. Avoid Everyone/Bypass rules. Keep the client ID and secret for Vercel.
2. Save the Access team URL and application audience tag in the server's `.env.online`: `CF_ACCESS_TEAM_DOMAIN=https://YOUR-TEAM.cloudflareaccess.com` and `CF_ACCESS_AUDIENCE=YOUR-APPLICATION-AUDIENCE`. Use the actual values, with no trailing slash on the team URL.
3. Create a remotely managed named tunnel. Its published hostname must match the protected backend hostname; its service is **HTTP** at `gateway:8080`.
4. Save the tunnel token in `deploy/secrets/cloudflare_tunnel_token` on the server. It is a different credential from the Access service token. Give that file mode `600`, owned by the deployment user. The preparation script writes matching `STRATA_TUNNEL_UID`/`STRATA_TUNNEL_GID`; keep them matched to the token file owner.

Use a private server editor to paste values; keep credentials out of shell history, GitHub, browser assets and chat. See [the online guide](ONLINE_DEPLOYMENT.md) for the full Access and origin-verification details. Cloudflare routes into the container network; do not expose Kafka, MinIO, Grafana, the Model API or the Hub directly to public host ports.

Validate and start the server's demo pipeline:

```bash
.venv/bin/python scripts/prepare_online.py --check
docker compose --env-file .env.online -f docker-compose.yml -f deploy/compose.online.yml --profile demo config --quiet
docker compose --env-file .env.online -f docker-compose.yml -f deploy/compose.online.yml --profile demo up --build -d --wait --wait-timeout 240
```

Initial builds need downloads and may exceed the readiness timeout. Inspect the logs before retrying; do not erase volumes. The service restart policies retain the backend across container restarts; the Docker daemon must be configured to start on server boot. This is a single-host pilot, so maintain backups and test restoration. No VPS or Cloudflare resources are created by these repository scripts.

## 5. Connect Vercel to the protected remote backend

Set these in Vercel **Project Settings → Environment Variables** for the intended environment:

| Name | Source |
|---|---|
| `STRATA_BACKEND_URL` | Protected HTTPS backend origin, e.g. `https://api.your-domain.example`, with no path |
| `STRATA_OPERATOR_TOKEN` | Server `.env.online` value of the same name |
| `STRATA_HUB_TOKEN` | Server `.env.online` value of `INTEGRATION_API_TOKEN` |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access service token client ID |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token secret |

Redeploy after setting/changing variables. Keep Preview credentials separate from field data. All five variables stay on the Vercel server; only the operator token is supplied by the user at sign-in and held in browser tab memory. The Hub and Access secrets are never injected into the frontend.

For the internal pilot, enable **Vercel Authentication → All Deployments**, limited to your test team. Standard Protection excludes production domains. Add suitable Vercel firewall rate limits on the proxy paths. Shared operator tokens are still a pilot limitation; individual identity, permissions and customer isolation are needed before offering accounts to multiple customers.

## 6. Verify remote operation and maintain it

Open the Vercel URL, pass team access protection and sign in with `STRATA_OPERATOR_TOKEN`. Confirm the simulator data is labeled as synthetic, inspect incidents and exports, then turn the development laptop off and open the dashboard from another device. The remote server must keep processing. If the remote server fails, the console must show unavailability. Unauthorized backend requests must fail, and the public gateway must reject internal ingest/probe/docs paths.

After Vercel is connected to GitHub, pushing the production branch redeploys the frontend automatically. **That does not update the backend server.** For a controlled backend update on the remote host:

```bash
git pull --ff-only
docker compose --env-file .env.online -f docker-compose.yml -f deploy/compose.online.yml --profile demo up --build -d --wait --wait-timeout 240
```

Review migrations and back up data before backend updates. Keep the same secret environment and Compose project/volumes. Use the field configuration without a simulator after real equipment adapters are validated; explicitly stop an existing simulator when switching modes. AI provider keys are optional and belong in the backend server's `.env.online`. Radio/GPS/session/map features remain separate drive-test implementation work.

## Official references

- [GitHub browser uploads](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)
- [Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github)
- [Vercel Root Directory and build settings](https://vercel.com/docs/builds/configure-a-build)
- [Access to source outside Vercel Root Directory](https://vercel.com/docs/monorepos/monorepo-faq)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
