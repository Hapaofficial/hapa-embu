# HAPA permanent deployment guide

## Local permanent copy on Mac
1. Keep the full `HAPA_DEPLOY_READY_v0_3` folder in Documents.
2. Install Node.js LTS.
3. Double-click `START_HAPA_MAC.command`.
4. Open `http://localhost:8080`.
5. Use `BACKUP_DATA_MAC.command` to create data backups.

## GitHub
1. Create an empty private repository named `hapa-embu`.
2. Upload the full contents of this folder.
3. Keep the repository private while the platform is under development.
4. Every future version should be committed into this repository.

## Cloud deployment
This package contains:
- `Dockerfile`
- `render.yaml`
- `railway.json`
- health endpoint `/api/health`

It can be deployed to a Docker-compatible Node.js host. The current JSON database is acceptable for demonstrations only. Before real public use, replace it with PostgreSQL.

## Production requirements
- domain and HTTPS
- PostgreSQL
- SMS OTP login
- Google Maps and live driver tracking
- M-Pesa Daraja
- secrets stored as environment variables
- backups and monitoring
- privacy policy and terms
- Android/iOS builds
