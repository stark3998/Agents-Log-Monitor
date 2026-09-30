# Data classifiers

Classifiers detect sensitive data in tool arguments, results, prompts and stored payloads. They drive three things:

- **findings** on conversations
- **payload redaction**
- **`classifier:` conditions** in [policies](policies.md) and lanes

The catalog has 96 built-in classifiers. 85 come from the standard catalog, across these categories: Secrets, PII, Financial, Healthcare, Legal, Government, Infrastructure, Code, Prompt Injection and Education. The other 11 are the original detector keys (`private_key`, `github_token`, `aws_key`, `ai_key`, `slack_token`, `google_key`, `azure_conn`, `jwt`, `env_secret`, `password_url`, `email`), kept so stored findings and existing lane rules keep working. `slack_bot_token` is an alias of `slack_token`.

Each classifier has:

| Field | Meaning |
|---|---|
| `category`, `sensitivity` | Low / Medium / High, shown in the UI and on detections |
| `isActive` | Runs for analytics findings and redaction |
| `enforceable` | May be used in policy / lane `classifier:` rules |
| `contextRequired` | Needs nearby keywords (for example a routing number only counts next to "routing" / "ABA") |
| `source` | `builtin` or `custom` |

## Precision

Where a format has a check digit, the regex match is also validated:

- Luhn: payment cards, Canadian SIN, NPI
- IBAN: mod-97
- ABA routing numbers: checksum
- US SSN: area / group / serial rules
- Aadhaar: Verhoeff
- VIN, DEA, CUSIP, ISIN, Australian TFN: check digits
- EIN: valid prefixes

Placeholders such as `${VAR}`, `<secret>` and `changeme` are ignored. Only active classifiers run on a scan (256 KB cap per text). The effective set is cached and recomputed only when the configuration changes.

## Enforcing inactive classifiers

A classifier can be enforceable but inactive. For example, you may not want every passport-like number flagged in analytics, but you do want to block it leaving over the network. Policy rules that reference it run that classifier **on demand** for the action being checked.

## Configuration

Edit classifiers on the **Policies → Data classifiers** tab, or through the API:

| Call | Purpose |
|---|---|
| `GET /api/gov/classifiers` | Effective classifiers + stored config |
| `PATCH /api/gov/classifiers/:code` `{isActive?, enforceable?}` | Toggle one classifier (PolicyAdmin) |
| `PUT /api/gov/classifiers/config` `{overrides, custom}` | Replace the whole config (PolicyAdmin) |
| `POST /api/gov/classifiers/test` `{text, codes?, custom?}` | Try classifiers or an unsaved custom definition. Returns masked samples only. |

Custom classifier:

```json
{ "code": "contoso_ticket", "label": "Contoso ticket id", "category": "Code", "sensitivity": "Low",
  "pattern": "CTS-\\d{6}", "contextPattern": "ticket|incident", "isActive": true, "enforceable": true }
```

- Codes are lowercase snake_case and may not collide with built-ins.
- Custom patterns run inline on every event, and JavaScript regexes can't be interrupted, so patterns are checked for ReDoS-prone shapes before they are accepted. These are rejected:
  - backreferences
  - repeated groups that contain alternation or another quantifier (`(a|b)+`, `(a+)*`). Write `[ab]+` instead.
  - more than 4 unbounded quantifiers
  - patterns longer than 500 characters
- Testing an unsaved custom pattern requires PolicyAdmin.

The config is stored in the governance store (SQLite locally, Cosmos in the cloud). Local enforcers pull it from the control plane on every sync. `detectors.disabled` in `agent-monitor.rules.json` still turns classifiers off for analytics.

## Redaction

`REDACT_PAYLOADS=secrets` masks **active** classifiers in the Secrets category. `all` also masks PII-type categories (PII, Financial, Healthcare, Government, Education, Legal). Infrastructure, Code and Prompt Injection classifiers never redact. Findings only ever store masked samples.
