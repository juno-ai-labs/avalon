FROM rust:1.91-bookworm AS builder

RUN cargo install minidump-stackwalk --version 0.26.1 --locked

FROM python:3.13-slim-bookworm

RUN useradd --create-home --uid 10001 processor \
    && install --directory --owner=processor --group=processor --mode=0700 /workspace

COPY --from=builder /usr/local/cargo/bin/minidump-stackwalk /usr/local/bin/minidump-stackwalk
COPY --chmod=0555 processor.py /usr/local/bin/rally-symbolicate

USER processor
WORKDIR /workspace
# Wrangler's local Container supervisor requires an exposed port even for this
# exec-only image. Production symbolication still communicates exclusively via
# the Durable Object's authenticated exec boundary; nothing listens here.
EXPOSE 8080
CMD ["sleep", "infinity"]
