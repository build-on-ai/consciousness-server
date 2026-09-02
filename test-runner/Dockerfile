FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git nodejs npm \
  && rm -rf /var/lib/apt/lists/*

COPY test-runner/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY test-runner/server.py ./
COPY lib/ports.py lib/verify_signed.py ./middleware/

ENV PORT=3041

EXPOSE 3041

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["python", "server.py"]
