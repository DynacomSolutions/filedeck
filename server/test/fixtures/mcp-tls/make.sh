#!/bin/sh
# Makes the test certificates of the MCP TLS tests. Run it from any folder: sh server/test/fixtures/mcp-tls/make.sh
# The tests need two self-signed pairs (the second one is the "renewed" pair). They are checked in, so a test run never needs the openssl program.
# Each pair is valid for 100 years for the names localhost and 127.0.0.1. The keys are for tests only. They protect nothing.
set -eu
dir=$(dirname "$0")
for name in tls renewed; do
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$dir/$name.key" -out "$dir/$name.crt" -days 36500 \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
done
