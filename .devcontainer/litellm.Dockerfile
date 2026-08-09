FROM ghcr.io/berriai/litellm:main-latest@sha256:76d036d18bb352ac3b4e0a84d5892b2cb2fe472e305bf2ac0619aef97fe6ced0

COPY .devcontainer/litellm-config.yaml /app/config.yaml

CMD ["--config", "/app/config.yaml", "--host", "0.0.0.0", "--port", "4000"]