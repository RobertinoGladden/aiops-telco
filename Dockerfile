FROM python:3.10-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY aiops aiops
COPY api api
COPY consumer consumer
COPY predictor predictor
COPY scripts scripts
COPY model model
COPY integrations integrations
COPY config config
COPY console console
RUN useradd --create-home aiops && mkdir /app/data && chown aiops:aiops /app/data
USER aiops
CMD ["python", "-m", "integrations.hub"]
