"""Fail-closed quarantine hook for archived Python/Flask compatibility services.

Python imports ``sitecustomize`` automatically when this repository is on
``PYTHONPATH``. The hook is inert unless the explicit Render/service quarantine
flag is set, so local compatibility/replay tooling keeps its historical
behavior by default.
"""

import json
import os


QUARANTINE_ENV = "ZYRON_LEGACY_PUBLIC_QUARANTINE"


def legacy_public_quarantine_enabled() -> bool:
    """Return True only for the single explicit fail-closed activation value."""
    return os.environ.get(QUARANTINE_ENV) == "1"


if legacy_public_quarantine_enabled():
    from flask import Flask
    from werkzeug.wrappers import Response

    def _quarantined_wsgi_app(self, environ, start_response):
        payload = json.dumps(
            {
                "canonical": False,
                "message": (
                    "This archived Python compatibility endpoint is quarantined "
                    "and is not the canonical ZyronChain Layer-1 network."
                ),
                "network": "legacy-python-compatibility-testnet",
                "status": "gone",
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        response = Response(
            payload,
            status=410,
            content_type="application/json; charset=utf-8",
        )
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-ZyronChain-Network"] = "legacy-quarantined"
        return response(environ, start_response)

    Flask.wsgi_app = _quarantined_wsgi_app
