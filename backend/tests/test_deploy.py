"""What has to hold for a deployed instance to serve the site.

Everything here is about the gap between "the tests pass" and "the URL works".
That gap is real: the frontend mount was resolved from the package's own
location, which is correct in the source tree and wrong in every install that
copies the package into site-packages — so the API answered and the site
returned 404, with nothing in the logs to say why.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from app.main import _find_frontend, create_app

ROOT = Path(__file__).resolve().parents[2]


def test_the_site_is_found_from_the_repository_root_whatever_the_install():
    """A host runs the process from the checkout root. That alone has to be
    enough to find the site, because `pip install ./backend` (no -e) moves the
    package out of the tree and breaks the path-relative answer."""
    assert _find_frontend() == ROOT / "frontend"


def test_an_explicit_directory_wins():
    os.environ["FRONTEND_DIR"] = str(ROOT / "frontend")
    try:
        assert _find_frontend() == ROOT / "frontend"
    finally:
        del os.environ["FRONTEND_DIR"]


def test_a_directory_without_an_index_is_not_accepted(tmp_path):
    """Existing is not the test — serving is. An empty directory mounted at /
    answers 404 for every page while looking configured."""
    os.environ["FRONTEND_DIR"] = str(tmp_path)
    try:
        assert _find_frontend() is None
    finally:
        del os.environ["FRONTEND_DIR"]


def test_a_missing_site_leaves_the_api_running_rather_than_failing_to_boot():
    """API-only is a legitimate deployment. Refusing to start would turn a
    cosmetic misconfiguration into an outage."""
    os.environ["FRONTEND_DIR"] = "/nonexistent"
    try:
        assert create_app() is not None
    finally:
        del os.environ["FRONTEND_DIR"]


def test_the_page_is_served_at_the_root():
    """The mount exists and answers at /, which is the one route a person
    opening the link actually uses."""
    from fastapi.testclient import TestClient

    with TestClient(create_app()) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert "<title>" in response.text


def test_the_start_command_binds_the_port_the_host_assigns():
    """Hosts assign a port through $PORT and health-check that exact port. A
    hardcoded 8000 passes locally and is marked unhealthy everywhere else."""
    for config in (ROOT / "Dockerfile", ROOT / "render.yaml"):
        text = config.read_text()
        assert "$PORT" in text or "${PORT}" in text, f"{config.name} hardcodes a port"
        assert "0.0.0.0" in text, f"{config.name} does not bind a reachable interface"


def test_the_deployment_installs_the_package_the_way_the_app_expects():
    """Both deployment paths must install `backend`, not just its dependencies:
    `uvicorn app.main:app` fails to import otherwise."""
    for config in (ROOT / "Dockerfile", ROOT / "render.yaml"):
        text = config.read_text()
        assert re.search(r"pip install[^\n]*backend", text), f"{config.name} never installs the app"


def test_no_deployment_file_carries_a_secret():
    """Committed config is public config."""
    pattern = re.compile(r"(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|\d{9,10}:[A-Za-z0-9_-]{35})")
    for config in (ROOT / "Dockerfile", ROOT / "render.yaml"):
        assert not pattern.search(config.read_text()), f"{config.name} contains a credential"
