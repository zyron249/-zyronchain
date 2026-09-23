#!/bin/sh
# Start the Telegram long-poll and the HTTP API in one container.
# The API replaces this shell so it is PID 1 and receives SIGTERM.
# PYTHONPATH and the rest of the environment come from the image and the host.
set -eu

python -m zyron_node.bot &
exec python -m zyron_node
