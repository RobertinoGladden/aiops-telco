FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client git && rm -rf /var/lib/apt/lists/*
COPY lab/automation/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
WORKDIR /lab
COPY lab/automation /lab/automation
CMD ["uvicorn", "automation.service:app", "--host", "0.0.0.0", "--port", "8084"]
