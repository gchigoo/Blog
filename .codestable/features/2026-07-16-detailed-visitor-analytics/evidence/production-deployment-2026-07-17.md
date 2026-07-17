# Production deployment evidence — 2026-07-17

## Release

- Target: RN2.5G, host `racknerd-c39ff87`, project `/root/Blog`.
- Git: `master` at `dcd15818f49f9ba0cf2bd8a2ccb3d3f40ae50797`.
- Runtime: Node.js `24.18.0`, PM2 `blog=online`, Nginx `active`.
- Deployment backups: two SQLite backups under `/root/Blog/backups/` plus root-only host config backups under `/root/deploy-backups/`.
- Remote named evidence: `/root/deploy-evidence/detailed-visitor-analytics-20260717/`.

## GeoLite2 City bootstrap and weekly updater

| Check | Production result |
|---|---|
| Precondition | live MMDB absent before bootstrap |
| Bootstrap service | `Result=success`, `ExecMainStatus=0`, status result `bootstrap` |
| Verifier | passed City metadata and fixed lookup; dataset epoch `1784007174` |
| SHA-256 | `e2765534f9fc6e0bcda4c46d8bc58bfac5feea6ca2d5581219e53c99cd3b073d` |
| Live file | `root:root:0644`, 65,864,808 bytes |
| Second run | status result `no-op`; checksum unchanged |
| Timer | `blog-geoip-update.timer` enabled and active; next Sunday 03:30 UTC plus configured jitter |
| Distro timer | `geoipupdate.timer` disabled so only the project wrapper can promote data |
| Secret boundary | MaxMind credentials exist only in root-owned `0600 /etc/GeoIP.conf`; no credential value is present in this repository or evidence |

Production does not change the server clock to force a missed-run. `Persistent=true`, the installed/enabled timer state and the Linux integration suite provide the missed-run evidence. Lock conflict, failed download/candidate preservation and rollback remain covered by the Linux updater integration test; production adds real bootstrap promotion and real no-op I/O evidence.

## HTTP, trusted IP and client detail smoke

- Cloudflare home request: HTTP 200, `Cache-Control: private, no-store`, `Cf-Cache-Status: DYNAMIC`, event token and `/js/analytics-context.js` present.
- Browser context POST: HTTP 204; stored event changed to `contextSource=combined` with screen width 1920 and timezone `Asia/Shanghai`.
- Encoded tag: `/tag/%E5%B7%A5%E5%85%B7` returned HTTP 200 and rendered `工具`.
- Nginx exact context location: 17,000-byte JSON request returned HTTP 413.
- Direct-origin request with spoofed `X-Forwarded-For: 198.51.100.1`: spoofed value was not stored; the trusted client address matched the Cloudflare-path observation.
- IPv4-mapped IPv6 production-app smoke: `::ffff:198.51.100.2` normalized to IPv4 `198.51.100.2` with `ipFamily=4`.
- GeoIP lookup resolved the real smoke address to country/subdivision/city fields.
- Parser evidence: Chrome 138 on Windows, Safari 18.5 on macOS and Firefox 140 on Linux were persisted with versions.

The raw real smoke IP remains in the production analytics database and the root-only remote evidence, but is intentionally not committed to the public repository.

## Admin read path

- Authenticated `/admin/analytics`: HTTP 200, `Cache-Control: no-store`, readable `/tag/工具` visible.
- Authenticated `/api/admin/analytics/events`: HTTP 200, `Cache-Control: no-store`, raw encoded path retained and `displayPath=/tag/工具` returned.
- Authenticated `/api/admin/analytics`: HTTP 200, `Cache-Control: no-store`, overview `byPage` returned the same raw/display pair.

## Final service state

- PM2: `online`.
- Nginx: `active` and `nginx -t` successful.
- GeoIP timer: `enabled` and `active`.
- Analytics detail configuration: enabled with 30-day retention and canonical production MMDB/status paths.
- Remote worktree: only the pre-existing host-specific `ecosystem.config.js` override remains modified; repository source is at the release commit.
