"""Run the Mini App API. Bind address comes from HOST and PORT."""

from __future__ import annotations

import uvicorn

from zyron_node.app import create_app
from zyron_node.config import load_settings, validate_settings
from zyron_node.logging_setup import setup_logging


def main() -> None:
    settings = load_settings()
    validate_settings(settings)
    setup_logging(settings.log_level)
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_config=None)


if __name__ == "__main__":
    main()
