# syntax=docker/dockerfile:1.7
# Immutable CUDA/PyTorch base used by the reviewed Nanochat Modal runtime.
FROM pytorch/pytorch@sha256:7b324d212a4450795b49edba9949b7cdc72429148a64e974334bfe5774d51385

ARG NANOCHAT_REVISION=92d63d4e8bb4df75c3b71618f31ddde2378b2bcd
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends git curl \
    && rm -rf /var/lib/apt/lists/* \
    && git clone https://github.com/karpathy/nanochat.git /opt/nanochat \
    && git -C /opt/nanochat checkout --detach "${NANOCHAT_REVISION}" \
    && test "$(git -C /opt/nanochat rev-parse HEAD)" = "${NANOCHAT_REVISION}"
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && /root/.local/bin/uv sync --project /opt/nanochat --extra gpu --frozen \
    && /root/.local/bin/uv pip install --python /opt/nanochat/.venv/bin/python PyYAML==6.0.2
ENV PATH=/opt/nanochat/.venv/bin:/root/.local/bin:${PATH}
WORKDIR /opt/nanochat
