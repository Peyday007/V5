# Brain's operator (§106): the published Hermes Agent image, pinned by digest,
# plus one standard-library file that runs it for Brain. Nothing is installed:
# Hermes' own dependency pins stay exactly as Nous Research shipped them.
FROM nousresearch/hermes-agent@sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08
COPY server.py /opt/brain-operator/server.py
COPY tests /opt/brain-operator/tests
ENV PORT=8080 HERMES_BIN=/opt/hermes/bin/hermes
EXPOSE 8080
# Not the image's s6 entrypoint: no gateway, cron or dashboard runs here. Brain's
# tick starts each run; this process only answers it.
# Hermes runs its agent as the unprivileged `hermes` user; so does this.
USER hermes
ENTRYPOINT ["/opt/hermes/.venv/bin/python", "/opt/brain-operator/server.py"]
