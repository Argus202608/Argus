"""Dispatch/pool-routing tests for the tui_gateway JSON-RPC protocol.

Split out of test_protocol.py: these tests drive the module-level RPC
ThreadPoolExecutor with threading.Event-gated handlers, which makes the file
that hosts them sensitive to host scheduling. Keeping them in their own file
gives each batch a fresh process (per-file isolation) and keeps both files
well under the CI per-file timeout.
"""

import io
import json
import sys
import threading
import time
from unittest.mock import MagicMock, patch

import pytest

_original_stdout = sys.stdout


@pytest.fixture(autouse=True)
def _restore_stdout():
    yield
    sys.stdout = _original_stdout


@pytest.fixture()
def server():
    with patch.dict("sys.modules", {
        "hermes_constants": MagicMock(get_hermes_home=MagicMock(return_value="/tmp/hermes_test")),
        "hermes_cli.env_loader": MagicMock(),
        "hermes_cli.banner": MagicMock(),
        "hermes_state": MagicMock(),
    }):
        import importlib
        mod = importlib.import_module("tui_gateway.server")
        yield mod
        # Reset module-level session state without re-importing. importlib.reload
        # would re-register the module's atexit hooks (ThreadPoolExecutor
        # shutdown, _shutdown_sessions); the duplicates race the stderr
        # buffer at interpreter shutdown and surface as Fatal Python error:
        # _enter_buffered_busy. Clearing the per-session dicts gives the
        # next test a clean slate; _methods is NOT cleared because it's
        # populated at module import time and re-registration only happens
        # via reload (which we don't do).
        mod._sessions.clear()
        mod._pending.clear()
        mod._answers.clear()


@pytest.fixture()
def capture(server):
    """Redirect server's real stdout to a StringIO and return (server, buf)."""
    buf = io.StringIO()
    original = server._real_stdout
    server._real_stdout = buf
    try:
        yield server, buf
    finally:
        server._real_stdout = original


# ── dispatch(): pool routing for long handlers (#12546) ──────────────


def test_dispatch_runs_short_handlers_inline(server):
    """Non-long handlers return their response synchronously from dispatch()."""
    server._methods["fast.ping"] = lambda rid, params: server._ok(rid, {"pong": True})

    resp = server.dispatch({"id": "r1", "method": "fast.ping", "params": {}})

    assert resp == {"jsonrpc": "2.0", "id": "r1", "result": {"pong": True}}


def test_dispatch_offloads_long_handlers_and_emits_via_stdout(capture):
    """Long handlers run on the pool and write their response via write_json."""
    server, buf = capture
    server._methods["slash.exec"] = lambda rid, params: server._ok(rid, {"output": "hi"})

    resp = server.dispatch({"id": "r2", "method": "slash.exec", "params": {}})
    assert resp is None

    for _ in range(50):
        if buf.getvalue():
            break
        time.sleep(0.01)

    written = json.loads(buf.getvalue())
    assert written == {"jsonrpc": "2.0", "id": "r2", "result": {"output": "hi"}}


def test_dispatch_long_handler_does_not_block_fast_handler(server):
    """A slow long handler must not prevent a concurrent fast handler from completing."""
    released = threading.Event()
    server._methods["slash.exec"] = lambda rid, params: (released.wait(timeout=5), server._ok(rid, {"done": True}))[1]
    server._methods["fast.ping"] = lambda rid, params: server._ok(rid, {"pong": True})

    t0 = time.monotonic()
    assert server.dispatch({"id": "slow", "method": "slash.exec", "params": {}}) is None

    fast_resp = server.dispatch({"id": "fast", "method": "fast.ping", "params": {}})
    fast_elapsed = time.monotonic() - t0

    assert fast_resp["result"] == {"pong": True}
    assert fast_elapsed < 0.5, f"fast handler blocked for {fast_elapsed:.2f}s behind slow handler"

    released.set()


def test_dispatch_session_compress_does_not_block_fast_handler(server):
    """Manual TUI compaction can take minutes, so it must not block the RPC loop."""
    released = threading.Event()

    def slow_compress(rid, params):
        released.wait(timeout=5)
        return server._ok(rid, {"done": True})

    server._methods["session.compress"] = slow_compress
    server._methods["fast.ping"] = lambda rid, params: server._ok(rid, {"pong": True})

    t0 = time.monotonic()
    assert server.dispatch({"id": "slow", "method": "session.compress", "params": {}}) is None

    fast_resp = server.dispatch({"id": "fast", "method": "fast.ping", "params": {}})
    fast_elapsed = time.monotonic() - t0

    assert fast_resp["result"] == {"pong": True}
    assert fast_elapsed < 0.5, f"fast handler blocked for {fast_elapsed:.2f}s behind session.compress"

    released.set()


def test_dispatch_long_handler_exception_produces_error_response(capture):
    """An exception inside a pool-dispatched handler still yields a JSON-RPC error."""
    server, buf = capture

    def boom(rid, params):
        raise RuntimeError("kaboom")

    server._methods["slash.exec"] = boom

    server.dispatch({"id": "r3", "method": "slash.exec", "params": {}})

    for _ in range(50):
        if buf.getvalue():
            break
        time.sleep(0.01)

    written = json.loads(buf.getvalue())
    assert written["id"] == "r3"
    assert written["error"]["code"] == -32000
    assert "kaboom" in written["error"]["message"]


def test_dispatch_unknown_long_method_still_goes_inline(server):
    """Method name not in _LONG_HANDLERS takes the sync path even if handler is slow."""
    server._methods["some.method"] = lambda rid, params: server._ok(rid, {"ok": True})

    resp = server.dispatch({"id": "r4", "method": "some.method", "params": {}})

    assert resp["result"] == {"ok": True}


@pytest.mark.parametrize("completion_method", ["complete.path", "complete.slash"])
def test_completion_handlers_are_pool_routed(completion_method, server):
    """complete.path/complete.slash must run on the pool, never the reader thread.

    Regression for #21123: completion ran inline, so a slow git ls-files /
    skill-scan blocked prompt.submit and froze the TUI for the 120s RPC timeout.
    """
    assert completion_method in server._LONG_HANDLERS


@pytest.mark.parametrize("completion_method", ["complete.path", "complete.slash"])
def test_slow_completion_does_not_block_fast_handler(completion_method, server):
    """A slow completion RPC must not block a concurrent fast handler (#21123)."""
    released = threading.Event()

    def slow_completion(rid, params):
        released.wait(timeout=5)
        return server._ok(rid, {"items": []})

    server._methods[completion_method] = slow_completion
    server._methods["fast.ping"] = lambda rid, params: server._ok(rid, {"pong": True})

    t0 = time.monotonic()
    assert server.dispatch({"id": "slow", "method": completion_method, "params": {}}) is None

    fast_resp = server.dispatch({"id": "fast", "method": "fast.ping", "params": {}})
    fast_elapsed = time.monotonic() - t0

    assert fast_resp["result"] == {"pong": True}
    assert fast_elapsed < 0.5, f"fast handler blocked for {fast_elapsed:.2f}s behind {completion_method}"

    released.set()


# The dashboard fires all four of these immediately after session.resume returns
# (fetchRegistries / fetchMmSidechannel / fetchTrajectory in MultimodalChatPage).
SESSION_SWITCH_HYDRATION_METHODS = [
    "multimodal.list_registries",
    "multimodal.list_monitor_alerts",
    "multimodal.list_watcher_content",
    "multimodal.trajectory.list",
]


@pytest.mark.parametrize("hydration_method", SESSION_SWITCH_HYDRATION_METHODS)
def test_session_switch_hydration_is_pool_routed(hydration_method, server):
    """Session-switch hydration RPCs must run on the pool, not the reader thread.

    Regression for "web 端切换 session 时候内容加载速度非常的慢": session.resume was
    already pool-routed, but these four ran inline on the reader thread — the same
    thread that flushes streaming tokens — so switching sessions stalled the event
    loop (`ws write slow (loop stalled >10.0s)`, max_send=9.47s in agent.log) and
    the restored bubbles arrived later than the resume response carrying them.
    """
    assert hydration_method in server._LONG_HANDLERS


@pytest.mark.parametrize("hydration_method", SESSION_SWITCH_HYDRATION_METHODS)
def test_slow_hydration_does_not_block_fast_handler(hydration_method, server):
    """A slow hydration RPC must not block concurrent fast RPCs on the reader thread."""
    released = threading.Event()

    def slow_hydration(rid, params):
        released.wait(timeout=5)
        return server._ok(rid, {"entries": []})

    # The `server` fixture deliberately does NOT restore _methods (it's populated
    # at import time), so patch.dict is what keeps this stub from leaking into
    # tests that call the real handler directly (e.g.
    # test_trajectory_image_budget.py's snapshot test).
    with patch.dict(
        server._methods,
        {
            hydration_method: slow_hydration,
            "fast.ping": lambda rid, params: server._ok(rid, {"pong": True}),
        },
    ):
        t0 = time.monotonic()
        assert server.dispatch(
            {"id": "slow", "method": hydration_method, "params": {}}
        ) is None

        fast_resp = server.dispatch({"id": "fast", "method": "fast.ping", "params": {}})
        fast_elapsed = time.monotonic() - t0

        assert fast_resp["result"] == {"pong": True}
        assert fast_elapsed < 0.5, (
            f"fast handler blocked for {fast_elapsed:.2f}s behind {hydration_method}"
        )

        released.set()
