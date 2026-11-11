# Эксплуатация и приватность / Operations and privacy

## Что хранится / What is stored

Файлы и текст пользователей не записываются на сервер. Сигнализация временно содержит параметры соединений, включая SDP. Если настроен `PAIRING_STORE`, сохраняются связи между хешированными идентификаторами браузеров. Если задан `DIAGNOSTICS_DIR`, включён журнал технических событий. Не публикуйте эти файлы.

File/text contents are not persisted on the application server. Signaling temporarily holds connection metadata including SDP. `PAIRING_STORE` persists relationships between hashed browser identities. `DIAGNOSTICS_DIR` enables the technical journal. These records are private operational data, not repository assets.

`telemetry.mjs` accepts an allowlist of fields: event timestamps, opaque transfer/session identifiers, shortened peer labels, browser/OS categories, route/candidate types, byte counts, timings, speeds and error categories. Unknown fields are discarded, including raw URLs, file names, text, raw SDP and full IP addresses. This does not prevent the reverse proxy, TURN service or hosting provider from recording IP addresses separately.

Default journal retention is **seven UTC calendar days**, capped at **256 MiB**, with approximately **8 MiB segments**. Rotation can make boundary days incomplete. This bound applies to the transfer journal, not all logs or pairing records on the VPS. Without `DIAGNOSTICS_DIR`, disk journaling is disabled. Use filesystem permissions and normal backups for required pairing records; do not back up secrets into Git.

## Отчёты / Reports

Run scripts as the service user or another authorized operator with access to the same data paths. Paths below match the deployment templates. Dates are examples.

```sh
DIAGNOSTICS_DIR=/var/lib/isend/diagnostics node scripts/daily-stats.mjs   --from 2026-11-01 --to 2026-11-07 --json

DIAGNOSTICS_DIR=/var/lib/isend/diagnostics node scripts/transfer-log.mjs   --from 2026-11-07T18:00:00+03:00 --to 2026-11-07T18:30:00+03:00   --context --json

DIAGNOSTICS_DIR=/var/lib/isend/diagnostics node scripts/test-devices.mjs invite   --hours 24 --uses 16 --origin https://send.example.com
```

The last command prints a private enrollment link for marking your own test browsers. Keep it private. If you configured `ANALYTICS_AUDIENCE_FILE`, supply the same value to these commands. Use `--help` for reporting options.

Уникальный браузер не равен человеку. `internal` — отмеченные тестовые устройства, `unmarked` — неотмеченные, но не обязательно новые посетители; `mixed` — передачи между этими группами. Уникальные браузеры разных дней нельзя просто суммировать. Передачи объединяются по идентификатору, чтобы не считать отправителя и получателя дважды.

Daily reports use Moscow calendar days; journal retention uses UTC dates. Daily unique browsers are not people. `internal` identifies marked test browsers, `unmarked` is not proof of external/organic traffic, and `mixed` combines an internal and unmarked endpoint. Transfer IDs deduplicate sender/receiver events. Missing events, blockers and abrupt page closure can undercount activity.

## Maintenance / Обслуживание

- Check `/healthz`, systemd status, server disk usage and TURN bandwidth. Avoid logging Authorization headers, browser identity headers or signaling bodies.
- Restart the application after a new build; static assets are held in memory. A restart interrupts signaling and clears transient state, so prefer low-traffic updates and keep a rollback release.
- Renew TLS certificates for HTTPS and TURN. Configure certificate permissions without making private keys world-readable.
- TURN consumes bandwidth in both directions. A small website VPS does not imply unlimited relay capacity. Set quotas and monitor provider billing.
- Browser data, pairs and journals are separate from source code; preserve or remove them deliberately during maintenance.
- This source has not undergone an independent security audit. Do not publish vulnerabilities together with keys or private user data.
