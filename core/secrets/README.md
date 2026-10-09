# core/secrets

One secret detector for the whole core, with no dependencies.

- `SECRET_RULES` and `findSecrets(file, line)`: the rules the release scanner
  (core/release, "Shipping safely") blocks a push with. Jev's fixed diff check
  (core/jev `checkDiff`) uses the same function, so a diff Jev passes is one the
  push check passes too.
- `redactSecrets(text)`: hides every secret it can recognise in anything that
  leaves Perfect Planner (Jev requests) or that agents write (relay questions
  and answers, progress notes, release reasons). It covers whole PEM private-key
  blocks, the scanner's rules, `Authorization: Bearer/Basic` headers,
  `scheme://user:password@host`, `mysql -pX` and `--password x`, npm tokens,
  `NAME=value`, `NAME: value` and `"NAME": "value"` for secret names
  (`isSecretName`), and long high-entropy runs. Names stay so a reader still
  sees what was there; values that are code (calls, member access, types,
  environment references) are left alone.
- `looksSecret(text)`: true when `redactSecrets` would hide something.

Redaction is deliberately broader than detection: hiding a harmless word costs
little, a leaked key costs a rotation.
