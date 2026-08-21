# rootsy-api

API Hono de Rootsy. El browser no pega acá: solo `rootsy-web` (BFF).

## Local

```bash
cp .env.example .env
# completar SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET, ROOTSY_API_SECRET
npm install
npm run dev
```

Queda en `http://localhost:8787`.

- `GET /health` — público, sin secret ni JWT
- `GET /v1/pops/:popId/mesas/layout?siteId=` — privado

Rutas privadas piden:

1. `x-rootsy-api-secret: <ROOTSY_API_SECRET>`
2. `Authorization: Bearer <access token de Supabase del usuario>`

Sin cualquiera de las dos → `401`.

## Qué le falta a rootsy-web

En `.env.local` (no commitear):

```
ROOTSY_API_URL=http://localhost:8787
ROOTSY_API_SECRET=<el mismo secret que acá>
```

`ROOTSY_API_URL` y `ROOTSY_API_SECRET` son solo de servidor. No van al browser.
