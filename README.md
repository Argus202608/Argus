<p align="center">
  <img src="assets/mmargus_logo.jpeg" alt="MM-Argus logo" width="420">
</p>

# Argus

Argus is a real-time multimodal AI agent that can watch a shared screen or
camera, listen to user and environment audio, answer questions about recent
frames, recall earlier events, and run long-lived monitors or research tasks.

[简体中文](README.zh-CN.md) · [Español](README.es.md) · [اردو](README.ur-pk.md)

> Argus is derived from [Hermes Agent](https://github.com/NousResearch/hermes-agent)
> by Nous Research. The original copyright and MIT license are preserved in
> [LICENSE](LICENSE).

## Highlights

- Current and historical visual question answering through `query_multimodal`.
- Continuous event monitoring with `set_monitor`.
- Long-running video research with `set_live_watcher`.
- Screen, camera, microphone, and shared-system-audio capture in the web and
  desktop clients.
- Layered multimodal memory for scenes, speech, events, and entities.
- The Hermes-compatible agent core, tools, skills, gateway, TUI, and desktop
  application.

## Requirements

- Python 3.11–3.13
- Node.js 20.19+ or 22.12+ for web and desktop builds
- `ffmpeg` for audio processing
- macOS screen and system-audio permissions for desktop screen sharing

## Install from PyPI

```bash
python -m pip install "mm-argus[web]"
argus setup
argus
```

The PyPI distribution is `mm-argus`; the primary command is `argus`. Legacy
`hermes`, `hermes-agent`, and `hermes-acp` entry points remain available for
compatibility with inherited integrations.

## Install from source

```bash
git clone https://github.com/MMArgus-Team/Argus.git
cd argus

uv venv --python 3.11 .venv
source .venv/bin/activate
uv pip install -e ".[web]"
```

On Windows PowerShell, activate the environment with:

```powershell
.venv\Scripts\Activate.ps1
```

## Configuration

Secrets are never committed to the repository. Copy the public templates into
your local Argus home and fill in only the providers you use:

```bash
mkdir -p ~/.argus
cp config.example.yaml ~/.argus/config.yaml
cp .env.example ~/.argus/.env
```

- `~/.argus/config.yaml` contains behavior, model, endpoint, and multimodal
  settings.
- `~/.argus/.env` contains API keys, tokens, and passwords only.

Run the guided setup at any time:

```bash
argus setup
```

## Run

```bash
argus                         # Interactive CLI
argus dashboard               # Web dashboard
argus gateway                 # Messaging gateway
argus mm doctor               # Multimodal diagnostics
```

## Desktop development

```bash
npm install
npm --workspace apps/desktop run dev
```

The desktop app needs macOS Screen & System Audio Recording permission to
capture audio from a shared screen. After changing that permission, fully quit
and restart the desktop app before sharing again.

## Web development

```bash
npm install
npm --workspace web run dev
```

## Tests

Use the repository wrapper so credentials and local Argus state are isolated:

```bash
scripts/run_tests.sh
npm --workspace apps/desktop run test:desktop
```

## Documentation and support

- [Documentation source](website/docs)
- [Issues](https://github.com/MMArgus-Team/Argus/issues)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License and attribution

Argus is distributed under the MIT License. It is a modified derivative of
Hermes Agent by Nous Research; upstream notices and copyright statements are
retained. See [LICENSE](LICENSE) for details.
