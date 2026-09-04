# The Python agents service (ADR-0007).
#
# A soft dependency by design: /forecast/indicators and /suggestion answer 503 when this
# is down and the trading path never touches it. That is why it gets its own image and
# its own lifecycle -- it may be restarted, or left out of a deployment entirely, without
# the money path noticing.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Loopback-only in the compose file below: this service is reached over the private
# network by the backend and is never exposed publicly. It has no authentication of its
# own and is not meant to.
ENV HOST=0.0.0.0
ENV PORT=8000

RUN useradd --create-home --uid 10001 agents
USER agents

EXPOSE 8000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "server.py"]
