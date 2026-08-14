<p align="center">
  <img src="assets/banner.png" alt="Argus" width="100%">
</p>

# Argus

Argus es un agente de IA multimodal en tiempo real. Puede observar una pantalla
compartida o una cámara, escuchar audio del usuario y del entorno, responder
preguntas sobre imágenes recientes y ejecutar monitores o investigaciones de
vídeo de larga duración.

[English](README.md) · [简体中文](README.zh-CN.md) · [اردو](README.ur-pk.md)

> Argus deriva de [Hermes Agent](https://github.com/NousResearch/hermes-agent)
> de Nous Research. Conserva los avisos originales y la
> [licencia MIT](LICENSE).

## Funciones principales

- Preguntas visuales actuales e históricas con `query_multimodal`.
- Monitorización continua de eventos con `set_monitor`.
- Investigación de vídeo en segundo plano con `set_live_watcher`.
- Captura de pantalla, cámara, micrófono y audio compartido en web y escritorio.
- Memoria multimodal para escenas, voz, eventos y entidades.

## Instalación desde PyPI

```bash
python -m pip install "mm-argus[web]"
argus setup
argus
```

El nombre de la distribución es `mm-argus` y el comando principal es `argus`.

## Instalación desde el código fuente

```bash
git clone https://github.com/Argus202608/argus.git
cd argus
uv venv --python 3.11 .venv
source .venv/bin/activate
uv pip install -e ".[web]"
```

## Configuración

```bash
mkdir -p ~/.argus
cp config.example.yaml ~/.argus/config.yaml
cp .env.example ~/.argus/.env
argus setup
```

`config.yaml` contiene opciones de comportamiento y endpoints; `.env` contiene
únicamente claves, tokens y contraseñas. No publiques ninguno de esos archivos
con credenciales reales.

## Ejecución y desarrollo

```bash
argus
argus dashboard
argus gateway

npm install
npm --workspace apps/desktop run dev
```

## Enlaces

- [Documentación](website/docs)
- [Incidencias](https://github.com/Argus202608/argus/issues)
- [Política de seguridad](SECURITY.es.md)
- [Contribuir](CONTRIBUTING.es.md)

## Licencia

Argus se distribuye bajo la licencia MIT y conserva la atribución y los avisos
de copyright de Hermes Agent y Nous Research. Consulta [LICENSE](LICENSE).
