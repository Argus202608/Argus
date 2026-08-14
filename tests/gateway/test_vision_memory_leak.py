"""Regression guards for the native gateway image path.

The legacy auxiliary vision-description step was removed. Images now travel as
native content parts, so no model-generated description can echo hidden memory
context into a user message at the gateway boundary.
"""


def _runner():
    from gateway.run import GatewayRunner

    runner = object.__new__(GatewayRunner)
    runner._pending_native_image_paths_by_session = {}
    return runner


def test_legacy_auxiliary_enrichment_is_absent():
    from gateway.run import GatewayRunner

    assert not hasattr(GatewayRunner, "_enrich_message_with_vision")


def test_native_image_paths_are_consumed_once():
    runner = _runner()
    runner._pending_native_image_paths_by_session["session-a"] = ["/tmp/img.jpg"]

    assert runner._consume_pending_native_image_paths("session-a") == ["/tmp/img.jpg"]
    assert runner._consume_pending_native_image_paths("session-a") == []


def test_native_image_paths_do_not_cross_sessions():
    runner = _runner()
    runner._pending_native_image_paths_by_session["session-a"] = ["/tmp/a.jpg"]

    assert runner._consume_pending_native_image_paths("session-b") == []
    assert runner._consume_pending_native_image_paths("session-a") == ["/tmp/a.jpg"]
