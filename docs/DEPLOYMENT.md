# Развёртывание / Deployment

## По-русски

Нужны VPS с Node.js 22.13+ (рекомендуется 24 LTS), HTTPS-домен и обратный прокси. TURN устанавливается отдельно, на тот же VPS или другой сервер. Большой диск для пользовательских файлов не нужен: они проходят между браузерами, а TURN только пересылает трафик. Нужны место под приложение, ограниченные журналы и запас пропускной способности.

Ниже — пошаговый пример для Linux с systemd/nginx. Это шаблоны, а не установщик: замените `send.example.com`, `turn.example.com`, пути сертификатов и создайте новый секрет TURN. Если на VPS уже есть сайт, добавляйте отдельный virtual host и сервис, не заменяйте общую конфигурацию и не сбрасывайте firewall. Производственные пароли и ключи храните вне репозитория.

## 1. Build the application

On a build machine or the VPS, with Node.js and npm already installed:

```sh
git clone https://github.com/alexdv124/isend.tech.git
cd isend.tech
npm ci
npm run typecheck
npm run build
npm test
```

Build before tests: server integration tests load `dist/`. The production HTTP server uses Node built-ins; after building, `node_modules` is not needed to run it. Preserve the source checkout separately for rebuilding.

For a local run, use `npm start` and open `http://127.0.0.1:8788`. Optional configuration is loaded explicitly:

```sh
cp .env.example .env
# Edit .env locally. Never commit credentials.
node --env-file=.env server.mjs
```

## 2. Install a separate service

The following assumes a NEW `/opt/isend` installation on a Debian-like system. Run from the built checkout. Use a non-root service account; keep release code owned by the administrator.

```sh
sudo useradd --system --home /var/lib/isend --shell /usr/sbin/nologin isend
sudo install -d -m 755 /opt/isend/releases/v28
sudo cp -R dist /opt/isend/releases/v28/
sudo cp server.mjs analytics.mjs audience.mjs discovery.mjs pairing.mjs telemetry.mjs text-signals.mjs /opt/isend/releases/v28/
sudo ln -s /opt/isend/releases/v28 /opt/isend/current
sudo install -d -m 700 /etc/isend
sudo install -m 600 deploy/isend.env.example /etc/isend/isend.env
sudo install -m 644 deploy/isend.service.example /etc/systemd/system/isend.service
```

Edit `/etc/isend/isend.env`: set your public HTTPS origin and, optionally, TURN credentials. The root-owned environment file is read by systemd before the service drops privileges. Adjust `ExecStart` to your actual Node binary. The service creates `/var/lib/isend` for persistent metadata. Do not run the app by symlinking only `server.mjs`; keep the complete release directory together.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now isend
curl --fail http://127.0.0.1:8788/healthz
sudo systemctl status isend
```

## 3. Add HTTPS

Point DNS to your VPS and obtain a valid certificate for your hostname. On an existing server, use its established ACME/certificate renewal setup. For a new host, first configure an HTTP-only ACME virtual host, obtain the certificate, then enable the HTTPS block in `deploy/nginx.conf.example`. That template cannot start until the referenced certificate files exist.

Install the completed template as a **new** virtual host using your distribution's include convention. Test with `sudo nginx -t`, then reload nginx. Do not replace the global nginx configuration or an existing site's virtual host.

`TRUST_PROXY=loopback` assumes a trusted local reverse proxy overwrites `X-Forwarded-For` with `$remote_addr`. If a CDN or additional proxy is in front, the example would group visitors by that proxy's address. Configure real-client-IP handling for explicitly trusted proxy ranges before enabling IP-based discovery. Do not trust arbitrary client-supplied forwarding headers.

The 24 KiB HTTP request limit is intentional: API messages contain signaling and diagnostics, not files. Large file transfers do not require increasing nginx's upload limit.

## 4. Optional TURN relay

Without TURN, direct WebRTC still works for many network combinations, but restrictive NAT/firewalls can prevent a connection. TURN can run on the same VPS or a separate host. Use a DNS-only hostname for TURN; a normal HTTP/CDN proxy does not relay it.

1. Install coturn from your distribution. Use [the official configuration reference](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf) for options supported by your installed version.
2. Make a private copy of `deploy/turnserver.conf.example`; replace hostnames, certificate paths and the shared secret. Generate the secret with `openssl rand -hex 32`. Do not paste it into issues, commits or screenshots.
3. Use the **same** secret as `TURN_AUTH_SECRET` in `/etc/isend/isend.env`. Set `TURN_URLS` to your `turn:` / `turns:` addresses. The browser receives short-lived derived credentials; the shared secret stays on the servers.
4. Obtain a certificate for `turn.example.com`. Make the certificate/key readable by the coturn service account with restricted permissions, and arrange a renewal hook to update/reload coturn. Do not make private keys world-readable.
5. If the VPS is behind NAT, configure `external-ip` and port forwarding for that host. Extend private-address deny rules for your network and IPv6. Review the sample quotas for your expected concurrency.
6. Open **3478 UDP/TCP**, **5349 TCP** and the configured **49160–49359 UDP** relay range in both the VPS and provider firewalls. Preserve SSH access and existing rules. HTTPS separately requires 443/TCP; ACME HTTP commonly needs 80/TCP. No blanket firewall reset is needed.
7. Enable/start the coturn service using your distribution's unit/config paths, then restart isend after updating its environment.

The template starts with bounded allocation quotas, not a promise of production capacity. Relay traffic costs bandwidth in both directions. Size the port range, quotas and provider limits together; monitor usage. Neither coturn nor its config is bundled into the application process.

As an alternative, `server.mjs` supports `CF_TURN_KEY_ID` plus `CF_TURN_API_TOKEN` for Cloudflare TURN credentials. Configure one complete provider setup; do not mix partial configurations.

## 5. Verify and update

- Open the HTTPS site in two independent browser profiles/devices; test discovery, code pairing, text and a small file.
- Test direct LAN transfer and transfer across networks. For a relay check, use a controlled network that blocks the direct path and verify the displayed route; a same-Wi-Fi success does not test TURN.
- Test a file above 512 MiB on a receiver with `showSaveFilePicker` and check the final saved file. Keep the receiving tab open until completion.
- Review browser diagnostics and service logs without publishing private data. See [operator reports](OPERATIONS.md).

For updates, build/test a new release directory, retain the old one for rollback, switch `/opt/isend/current`, and restart only the isend service. Keep `/var/lib/isend` and environment files outside releases. Restarting clears transient signaling state; choose an appropriate maintenance window. Frontend and backend revisions are separate.

These templates are not an automatic deployment script and have not been executed against a fresh Linux VPS as part of publishing this source. Review paths and host-specific network settings before use.
