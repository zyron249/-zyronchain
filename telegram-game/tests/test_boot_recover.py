import shutil
import subprocess
from pathlib import Path


def test_boot_recover_retries_then_surfaces_a_real_failure():
    node = shutil.which("node")
    assert node, "node is required to test Mini App boot recovery"
    script = Path(__file__).with_name("boot_recover.test.js")
    result = subprocess.run([node, str(script)], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    assert "boot-recover ok" in result.stdout
    frontend = Path("frontend")
    for name in ("app.js", "boot.js", "boot-recover.js"):
        checked = subprocess.run([node, "--check", str(frontend / name)], check=False, capture_output=True, text=True)
        assert checked.returncode == 0, checked.stderr

    app = Path("frontend/app.js").read_text(encoding="utf-8")
    boot_js = Path("frontend/boot.js").read_text(encoding="utf-8")
    assert "policy.recoverBoot" in app
    assert "timeoutMs: policy.TIMEOUT_MS" in app
    assert "if (!state.me)" in app
    assert "followUps = 0" in app
    assert "MainButton" in boot_js
    assert "url.hash" in boot_js
