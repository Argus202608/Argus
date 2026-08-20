"""Canonical Argus CLI namespace.

The implementation continues to live in :mod:`hermes_cli` so installations
and third-party integrations built before the Argus rename remain compatible.
New callers should import or execute :mod:`argus_cli`.
"""

from hermes_cli.main import main

__all__ = ["main"]
