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
- `GET /v1/me` — perfil (header)
- `GET /v1/me/pops` — puntos de venta del usuario (dirección, imagen de fondo, dock)
- `GET|POST /v1/pops/:popId/articles` — listar / crear (costos, listas extra, stock inicial)
- `POST /v1/pops/:popId/articles/image` — foto WebP
- `GET|PATCH|DELETE /v1/pops/:popId/articles/:articleId` — detalle / editar / borrar
- `GET|POST /v1/pops/:popId/price-lists` — listas de precios
- `PATCH|DELETE /v1/pops/:popId/price-lists/:listId` — renombrar / borrar (no la principal)
- `GET|POST /v1/pops/:popId/categories` — categorías de artículos
- `PATCH /v1/pops/:popId/categories/layout` — orden y visibilidad en venta
- `GET|PATCH|DELETE /v1/pops/:popId/categories/:categoryId` — detalle (incluye articleCount)
- `GET|POST|PATCH|DELETE /v1/pops/:popId/dock` — dock del menú (preferencia del usuario)
- `GET /v1/pops/:popId/expense-categories` — gastos
- `GET|POST /v1/pops/:popId/recipes` — listar / crear recetas (ingredientes y listas extra)
- `POST /v1/pops/:popId/recipes/image` — foto WebP
- `GET /v1/pops/:popId/recipes/ingredients` — buscar ingredientes (`?q=` o `?ids=`)
- `GET|PATCH|DELETE /v1/pops/:popId/recipes/:recipeId` — detalle / editar / borrar
- `GET|POST /v1/pops/:popId/recipe-categories` — categorías de recetas
- `PATCH /v1/pops/:popId/recipe-categories/layout` — orden y visibilidad en menú
- `GET|PATCH|DELETE /v1/pops/:popId/recipe-categories/:categoryId` — detalle (incluye recipeCount)
- `GET|POST /v1/pops/:popId/comanda-stations` — estaciones de comanda
- `GET|PATCH|DELETE /v1/pops/:popId/comanda-stations/:stationId` — detalle (incluye categoryCount)
- `GET /v1/pops/:popId/service-categories` — servicios
- `GET /v1/pops/:popId/suppliers` — proveedores activos (id, nombre). `?q=` busca por nombre o CUIT

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
