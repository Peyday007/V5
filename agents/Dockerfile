# Brain's open-source agents: Sellbird (contact research) and Browser Use
# (read-only browsing), one small CPU image. Built and run by
# .github/workflows/agents.yml as its own private Fly app; never part of the
# Brain's image (deploymentOwnership: one workflow deploys the Brain).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ANONYMIZED_TELEMETRY=false \
    BROWSER_USE_SETUP_LOGGING=false \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Sellbird at a pinned commit (AGPL-3.0, run unmodified as a separate service).
ARG SELLBIRD_SHA=25ec83978b21d16ae20779d09bfea113f37f0ef8

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt \
 && pip install --no-deps "https://github.com/ethanplusai/sellbird/archive/${SELLBIRD_SHA}.tar.gz" \
 && python -m playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.cache

COPY brain_agents ./brain_agents
COPY tests ./tests

RUN useradd --create-home --uid 10001 agent && chown -R agent /app
USER agent

EXPOSE 8080
CMD ["uvicorn", "brain_agents.app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-access-log"]
