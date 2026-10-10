"""Export the pilot source for GitHub uploads without local environments/runtime files."""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist/github-upload"
DIRECTORIES = ("aiops", "api", "consumer", "predictor", "model", "integrations", "config",
               "console", "deploy", "scripts", "monitoring", "grafana", "airflow", "tests", "docs")
FILES = (".gitignore", ".dockerignore", ".env.example", "Dockerfile", "docker-compose.yml",
         "requirements.txt", "requirements-dev.txt", "README.md", "console.ps1", "start.ps1",
         "status.ps1", "stop.ps1", "train.ps1")
BLOCKED = {"__pycache__", ".git", ".vercel", "venv", ".venv", "node_modules", "secrets", "data", "public"}


def allowed(file, relative):
    return (not file.is_symlink() and not any(part in BLOCKED for part in relative.parts) and
            not file.name.startswith(".env") and file.suffix not in {".pyc", ".pyo", ".log", ".sqlite", ".db"})


def package():
    # Never reuse a folder into which someone could have added secrets between runs.
    try:
        OUTPUT.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise SystemExit("dist/github-upload already exists; it was preserved. Use the existing package or rename it before exporting again.") from None
    count = 0
    for name in FILES:
        shutil.copyfile(ROOT / name, OUTPUT / name)
        count += 1
    for name in DIRECTORIES:
        for file in sorted((ROOT / name).rglob("*")):
            relative = file.relative_to(ROOT)
            if file.is_file() and allowed(file, relative):
                target = OUTPUT / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, target)
                count += 1
    print(f"GitHub upload source ready: {OUTPUT}")
    print(f"Files: {count}. Local .env/.env.online, tunnel credentials, virtual environments and runtime data are excluded.")
    print("Upload the contents at your repository root, preserving directory names. Do not upload a ZIP as source code.")


if __name__ == "__main__":
    package()
