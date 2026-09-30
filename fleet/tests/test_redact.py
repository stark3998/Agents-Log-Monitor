from agentmon_fleet.models import EventKind
from agentmon_fleet.redact import redact_event, redact_text, redact_value

from .conftest import ev


def test_secrets_are_typed_placeholders():
    s = redact_text("key AKIAABCDEFGHIJKLMNOP and ghp_" + "a" * 36 + " and Bearer " + "x" * 40)
    assert "[REDACTED:aws_access_key]" in s
    assert "[REDACTED:github_token]" in s
    assert "[REDACTED:bearer_token]" in s
    assert "AKIA" not in s


def test_assignment_keeps_key_name():
    s = redact_text('api_key = "sup3rs3cr3tvalue123"')
    assert s.startswith("api_key") and "sup3rs3cr3t" not in s and "[REDACTED:secret]" in s


def test_pii_email_keeps_domain_and_luhn_cards():
    s = redact_text("mail jane.doe@contoso.com card 4111 1111 1111 1111 not-card 1234 5678 9012 3456 ssn 123-45-6789")
    assert "j***@contoso.com" in s
    assert "[REDACTED:card]" in s
    assert "1234 5678 9012 3456" in s  # fails Luhn
    assert "[REDACTED:us_ssn]" in s


def test_sensitive_keys_in_dicts():
    v = redact_value({"client_secret": "abc", "nested": {"password": "hunter2hunter2"}, "note": "ok"})
    assert v["client_secret"] == "[REDACTED:field]"
    assert v["nested"]["password"] == "[REDACTED:field]"
    assert v["note"] == "ok"


def test_redact_event_in_place_preserves_code_shape():
    e = ev(EventKind.TOOL_CALL, tool_name="code_interpreter",
           arguments="import base64\npayload='aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQgZW5jb2RlZA=='\nexec(base64.b64decode(payload))")
    redact_event(e)
    assert "b64decode" in e.arguments and "aGVsbG8" in e.arguments  # obfuscation evidence must survive
