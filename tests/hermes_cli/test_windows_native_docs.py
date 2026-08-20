from pathlib import Path


def test_windows_native_install_path_docs_match_installer() -> None:
    doc = Path("website/docs/user-guide/windows-native.md").read_text()
    install = Path("scripts/install.ps1").read_text()

    assert "%LOCALAPPDATA%\\argus\\argus\\venv\\Scripts" in doc
    assert "Get-Command argus        # should print C:\\Users\\<you>\\AppData\\Local\\argus\\argus\\venv\\Scripts\\argus.exe" in doc
    assert '$argusBin = "$InstallDir\\venv\\Scripts"' in install
