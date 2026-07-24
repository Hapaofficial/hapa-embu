# HAPA Embu v0.5 — Root Ready

This package is prepared so the application files can live directly in the GitHub repository root.

## Render settings

- Root Directory: leave empty
- Build Command: `npm install`
- Start Command: `npm start`

## Upload to GitHub

Open this folder and upload its CONTENTS to the repository root. Do not upload the ZIP file itself and do not create another HAPA_ROOT_READY_v0_5 folder inside the repository.

Expected repository root:

- package.json
- server/
- apps/
- database/
- docs/
- render.yaml
- Dockerfile

## Local start

```bash
npm install
npm start
```

Health check: `/api/health`
