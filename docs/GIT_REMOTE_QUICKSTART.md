# Push the existing workspace with git remote, without cloning

This procedure applies to the current ZIP-downloaded project, which has no project-local `.git`, and to the existing GitHub repository's main branch. It preserves the existing remote history and current local application files.

No VPS or paid hosting account is needed to upload the source. Publishing it to GitHub does not run the application. With the current zero cloud budget, Vercel can host the console preview; the existing full backend still needs remote compute or a separate implementation of the lighter testing architecture described in [the deployment guide](GITHUB_REMOTE_DEPLOYMENT.md#testing-with-no-paid-cloud-budget). Vercel Hobby is limited to personal, non-commercial use.

```powershell
cd C:\Users\lapt1\Downloads\aiops-telco-main
git init -b main
git remote add origin https://github.com/RobertinoGladden/aiops-telco.git
git fetch origin main
git reset --mixed --quiet origin/main
```

Stop if fetching the remote fails. `reset --mixed` prepares the index/history from the existing remote while leaving the downloaded and edited working files in place. Do not use `--hard`. Run the initial setup only once, before creating local commits.

```powershell
git add .gitignore .dockerignore .env.example README.md Dockerfile docker-compose.yml requirements.txt requirements-dev.txt console.ps1 start.ps1 status.ps1 stop.ps1 train.ps1
git add aiops api consumer predictor model integrations config console deploy scripts monitoring grafana airflow tests docs
git diff --cached --stat
git commit -m "Update Strata console and GitHub deployment"
git push -u origin main
```

The selected paths stage the current application changes without staging modifications to the older tracked `venv/`. Inspect the staged files before commit. Do not add `.env`, `.env.online`, tunnel credentials or runtime databases. If origin already exists, inspect `git remote -v` and correct it with `git remote set-url origin ...` only if necessary. If commit requests an author, configure your Git name/email for this repository. GitHub push may open a browser authentication flow.

After the first upload, use add/commit/push for subsequent changes. The complete GitHub/Vercel build settings and hosted-backend choices are in [the remote deployment guide](GITHUB_REMOTE_DEPLOYMENT.md). A successful GitHub push publishes source; it does not by itself start the backend.

Official references: [GitHub local-code import](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github), [git remote](https://git-scm.com/docs/git-remote), [git reset](https://git-scm.com/docs/git-reset).
