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


# ── gated pool handlers ──────────────────────────────────────────────
#
# Every "slow handler must not block the fast path" test below used to assert
# `time.monotonic() - t0 < 0.5` and then fire-and-forget the pool task. Both
# halves were load-sensitive and both burned CI:
#
#   * The wall-clock bound measured from *before* `_pool.submit()`, so it also
#     covered lazy worker-thread creation and `contextvars.copy_context()`. On a
#     2-core runner already running several pytest processes, 0.5s is not a
#     reliable ceiling for work that is supposed to take microseconds.
#   * Releasing the stub without joining it let the pool worker outlive the
#     test. `handle_request` resolves handlers at execution time via
#     `_methods.get(method)`, so a worker scheduled after `patch.dict` unwound
#     would call the *real* handler with `params={}` — by which point the
#     `server` fixture's `patch.dict("sys.modules", ...)` had also unwound, so
#     it touched the real modules. Pool workers are non-daemon and
#     `atexit`'s `_pool.shutdown(wait=False)` cannot interrupt a running task,
#     so `concurrent.futures.thread._python_exit` joined it at interpreter
#     shutdown: every test passed, then the process never exited and the
#     harness SIGKILLed it at the 140s per-file cap with no summary.
#     `faulthandler_timeout` cannot catch that — it is armed per test and
#     already disarmed by then.
#
# `_GatedHandler` replaces both with explicit handshakes. Asserting that the
# fast response arrived *while the slow handler is still inside the pool* tests
# the real property and is immune to scheduling jitter.

_GATE_TIMEOUT = 30.0


class _GatedHandler:
    """RPC handler that announces entry and returns only once released."""

    def __init__(self, server, result):
        self._server = server
        self._result = result
        self.entered = threading.Event()
        self.released = threading.Event()
        self.finished = threading.Event()

    def __call__(self, rid, params):
        self.entered.set()
        try:
            if not self.released.wait(timeout=_GATE_TIMEOUT):
                raise AssertionError("gated handler was never released")
            return self._server._ok(rid, self._result)
        finally:
            self.finished.set()

    def wait_entered(self):
        """Block until a pool worker is actually executing this handler."""
        assert self.entered.wait(timeout=_GATE_TIMEOUT), (
            "pool never started the handler"
        )

    def release(self):
        """Release the handler and join it, so it cannot outlive the test."""
        self.released.set()
        assert self.finished.wait(timeout=_GATE_TIMEOUT), (
            "pool handler never finished"
        )


def _pong(server):
    return lambda rid, params: server._ok(rid, {"pong": True})


def _wait_for_write(buf, timeout=_GATE_TIMEOUT):
    """Wait for the pool worker's response to land in *buf*.

    Was `for _ in range(50): time.sleep(0.01)` — a hard 0.5s budget for
    "schedule a pool worker and write one line", which is not something a
    loaded runner guarantees.
    """
    deadline = time.monotonic() + timeout
    while not buf.getvalue() and time.monotonic() < deadline:
        time.sleep(0.01)
    written = buf.getvalue()
    assert written, f"pool worker wrote nothing within {timeout:.0f}s"
    return json.loads(written)


# ── dispatch(): pool routing for long handlers (#12546) ──────────────


def test_dispatch_runs_short_handlers_inline(server):
    """Non-long handlers return their response synchronously from dispatch()."""
    with patch.dict(server._methods, {"fast.ping": _pong(server)}):
        resp = server.dispatch({"id": "r1", "method": "fast.ping", "params": {}})

    assert resp == {"jsonrpc": "2.0", "id": "r1", "result": {"pong": True}}


def test_dispatch_offloads_long_handlers_and_emits_via_stdout(capture):
    """Long handlers run on the pool and write their response via write_json."""
    server, buf = capture

    with patch.dict(
        server._methods,
        {"slash.exec": lambda rid, params: server._ok(rid, {"output": "hi"})},
    ):
        resp = server.dispatch({"id": "r2", "method": "slash.exec", "params": {}})
        assert resp is None

        written = _wait_for_write(buf)

    assert written == {"jsonrpc": "2.0", "id": "r2", "result": {"output": "hi"}}


def test_dispatch_long_handler_does_not_block_fast_handler(server):
    """A slow long handler must not prevent a concurrent fast handler from completing."""
    slow = _GatedHandler(server, {"done": True})

    with patch.dict(
        server._methods, {"slash.exec": slow, "fast.ping": _pong(server)}
    ):
        assert server.dispatch({"id": "slow", "method": "slash.exec", "params": {}}) is None
        slow.wait_entered()

        fast_resp = server.dispatch({"id": "fast", "method": "fast.ping", "params": {}})

        assert fast_resp["result"] == {"pong": True}
        assert not slow.finished.is_set(), (
            "fast handler only completed after the slow handler returned"
        )

        slow.release()


def test_dispatch_session_compress_does_not_block_fast_handler(server):
    """Manual TUI compaction can take minutes, so it must not block the RPC loop."""
    slow = _GatedHandler(server, {"done": True})

    with patch.dict(
        server._methods, {"session.compress": slow, "fast.ping": _pong(server)}
    ):
        assert server.dispatch(
            {"id": "slow", "method": "session.compress", "params": {}}
        ) is None
        slow.wait_entered()

        fast_resp = server.dispatch({"id": "fast", "method": "fast.ping", "params": {}})

        assert fast_resp["result"] == {"pong": True}
        assert not slow.finished.is_set(), (
            "fast handler only completed after session.compress returned"
        )

        slow.release()


def test_dispatch_long_handler_exception_produces_error_response(capture):
    """An exception inside a pool-dispatched handler still yields a JSON-RPC error."""
    server, buf = capture

    def boom(rid, params):
        raise RuntimeError("kaboom")

    with patch.dict(server._methods, {"slash.exec": boom}):
        server.dispatch({"id": "r3", "method": "slash.exec", "params": {}})

        written = _wait_for_write(buf)

    assert written["id"] == "r3"
    assert written["error"]["code"] == -32000
    assert "kaboom" in written["error"]["message"]


def test_dispatch_unknown_long_method_still_goes_inline(server):
    """Method name not in _LONG_HANDLERS takes the sync path even if handler is slow."""
    with patch.dict(
        server._methods,
        {"some.method": lambda rid, params: server._ok(rid, {"ok": True})},
    ):
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
    slow = _GatedHandler(server, {"items": []})

    with patch.dict(
        server._methods, {completion_method: slow, "fast.ping": _pong(server)}
    ):
        assert server.dispatch(
            {"id": "slow", "method": completion_method, "params": {}}
        ) is None
        slow.wait_entered()

        fast_resp = server.dispatch({"id": "fast", "method": "fast.ping", "params": {}})

        assert fast_resp["result"] == {"pong": True}
        assert not slow.finished.is_set(), (
            f"fast handler only completed after {completion_method} returned"
        )

        slow.release()


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
    slow = _GatedHandler(server, {"entries": []})

    # The `server` fixture deliberately does NOT restore _methods (it's populated
    # at import time), so patch.dict is what keeps this stub from leaking into
    # tests that call the real handler directly (e.g.
    # test_trajectory_image_budget.py's snapshot test). `slow.release()` inside the
    # `with` block is what makes that safe: `handle_request` looks the handler up at
    # execution time, so a worker still parked in the gate when patch.dict unwound
    # would go on to call the *real* handler.
    with patch.dict(
        server._methods, {hydration_method: slow, "fast.ping": _pong(server)}
    ):
        assert server.dispatch(
            {"id": "slow", "method": hydration_method, "params": {}}
        ) is None
        slow.wait_entered()

        fast_resp = server.dispatch({"id": "fast", "method": "fast.ping", "params": {}})

        assert fast_resp["result"] == {"pong": True}
        assert not slow.finished.is_set(), (
            f"fast handler only completed after {hydration_method} returned"
        )

        slow.release()
