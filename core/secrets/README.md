# core/secrets

One secret detector for the whole core, with no dependencies.

- `SECRET_RULES` and `findSecrets(file, line)`: the rules the release scanner
  (core/release, "Shipping safely") blocks a push with.
- `detectSecrets(file, line)`: Jev's fixed diff check (core/jev `checkDiff`).
  It is the scanner's rules plus every format redaction knows, tuned not to
  flag ordinary code: the secret word must end the name (`passwordLabel`,
  `tokenType` and `TOKEN_KEY = "auth.session.token"` pass), bare identifiers
  count only on `NAME=value` lines and in config files, and quoted values in
  source keep the scanner's minimum lengths.
- `redactSecrets(text)`: hides every secret it can recognise in anything that
  leaves Perfect Planner (Jev requests) or that agents write (relay questions
  and answers, progress notes, release reasons). It covers whole PEM private-key
  blocks, the scanner's rules, `Authorization: Bearer/Basic` headers,
  `scheme://<user>:<password>@<host>`, `mysql -p<password>` and `--password <password>`, npm tokens,
  `NAME=value`, `NAME: value` and `"NAME": "value"` for secret names
  (`isSecretName`), and long high-entropy runs. Names stay so a reader still
  sees what was there; values that are code (calls, member access, types,
  environment references) are left alone.
  It also hides cookie values and long high-entropy runs, which the diff check
  leaves alone so fixtures do not reject a diff.
- `looksSecret(text)`: true when `redactSecrets` would hide something;
  `redactionSpans(line)` says what and why.

Redaction is deliberately broader than detection: hiding a harmless word costs
little, a leaked key costs a rotation.
