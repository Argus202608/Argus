from pathlib import Path
import subprocess


REPO_ROOT = Path(__file__).resolve().parents[2]
SETUP_SCRIPT = REPO_ROOT / "setup-hermes.sh"
CANONICAL_SETUP_SCRIPT = REPO_ROOT / "setup-argus.sh"


def test_setup_hermes_script_is_valid_shell():
    result = subprocess.run(["bash", "-n", str(SETUP_SCRIPT)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_setup_hermes_script_delegates_to_argus_setup():
    content = SETUP_SCRIPT.read_text(encoding="utf-8")

    assert 'exec "$SCRIPT_DIR/setup-argus.sh" "$@"' in content


def test_setup_argus_script_has_termux_path():
    content = CANONICAL_SETUP_SCRIPT.read_text(encoding="utf-8")

    assert "is_termux()" in content
    assert ".[termux]" in content
    assert "constraints-termux.txt" in content
    assert "$PREFIX/bin" in content
