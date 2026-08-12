from pathlib import Path


def test_explorer_summary_uses_dom_safe_rendering():
    template = Path("templates/index.html").read_text(encoding="utf-8")

    # API-derived explorer fields must never be interpolated into HTML strings.
    assert ".innerHTML" not in template
    assert "insertAdjacentHTML" not in template
    assert "document.write" not in template

    # Dynamic text is rendered as text and route segments are encoded.
    assert ".textContent" in template
    assert "encodeURIComponent" in template
    assert "document.createElement('tr')" in template
    assert "document.createElement('td')" in template
    assert "document.createElement('a')" in template


def test_explorer_identifies_historical_python_surface():
    template = Path("templates/index.html").read_text(encoding="utf-8")

    assert "Historical Python testnet explorer" in template
