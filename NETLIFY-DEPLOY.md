# NETLIFY-DEPLOY — paano patakbuhin ang Project Reborn sa Netlify nang walang duplicate na bot

## 1. Paano gumagana ngayon (nakita sa code)
- Build: TanStack Start + Nitro (`NITRO_PRESET=netlify`). Lahat ng `src/routes/api/public/*` ay nagiging server function ng Netlify.
- Lahat ng bot/API logic ay nasa `src/server/bot/*` at nilo-load ng `/api/public/bot/$fn` sa pamamagitan ng `registry.ts`.
- 24/7 na bots: **isang** tawag kada minuto sa `/api/public/cron/tick`. Dati, ang tumatawag ay ang Lovable managed schedule `bot-office-tick`.
- Facebook webhook: `/api/public/bot/fb-webhook` (kung ano ang URL na nirehistro mo sa Meta).
- Ang database key (`SUPABASE_SERVICE_ROLE_KEY`) ay hawak lang ng Lovable. Kaya ang lumang Netlify copy ay UI lang
  (`VITE_BOT_API_BASE` → Lovable site ang sumasagot sa data).

## 2. Dalawang mode (pumili ng isa)
| | MODE A — proxy (default, walang masisira) | MODE B — standalone (Netlify ang lahat) |
|---|---|---|
| UI | Netlify | Netlify |
| API/bots/webhook/cron | Lovable site | **Netlify** |
| Kailangan | wala na | **sarili mong Supabase project** + service role key |
| `VITE_BOT_API_BASE` | naka-set sa `netlify.toml` | **burahin** ang linya |
| Netlify cron | hindi tumatakbo | tumatakbo (`netlify/functions/cron-tick.mts`) |

Ang MODE B ay posible lang kung hawak mo ang service role key ng database. Kung Lovable Cloud ang database at hindi mo makuha ang key,
MODE A ang gamitin (o ilipat muna ang data sa sarili mong Supabase).

## 3. Anti-duplicate na guard (nasa code na)
1. `ACTIVE_DEPLOYMENT_URL` = ang **iisang** site na pwedeng magpatakbo ng cron at webhook. Kapag wala, **walang tatakbo** (fail-closed).
2. Netlify deploy previews/branch deploys ay hindi kailanman tumatakbo (`CONTEXT` ≠ `production`).
3. `CRON_SECRET` ang password ng tick. Ang Lovable's `LOVABLE_CRON_SECRET` ay tinatanggap pa rin, kaya hindi nagbabago ang Lovable.
4. Isang tick lang kada minuto sa lahat ng deployment (lock sa `bot_state`, key `cron_tick:<minute>`, walang migration).
5. `fb-webhook` sa hindi-aktibong site: GET → 403, POST → 200 `skipped`.
6. `NETLIFY_CRON_ENABLED=true` ang opt-in ng Netlify cron. `BOT_JOBS_ENABLED=false` ang emergency stop.
Hindi apektado ng guard ang mga user-driven na route (admin-db, publish-now, generate-post, caption-writer, boss-chat…).

## 4. Mga file changes
**Bago:** `src/server/deployment-guard.ts` · `netlify/functions/cron-tick.mts` · `src/test/deployment-guard.test.ts` · `.env.example` · `NETLIFY-DEPLOY.md`
**Binago:** `netlify.toml` · `src/routes/api/public/cron.tick.ts` · `src/routes/api/public/bot.$fn.ts` · `src/lib/lovable-error-reporting.ts` (off lang kapag `VITE_DEPLOY_TARGET=netlify`) · `.gitignore`
**HUWAG GALAWIN:** `src/server.ts`, `src/start.ts`, `src/routeTree.gen.ts`, `src/integrations/supabase/*` (generated), `drizzle/`, `supabase/`,
`@lovable.dev/vite-tanstack-config` at `nitro` sa `package.json` (ito ang build engine), `vite.config.ts`.

## 5. Environment variables
Tingnan ang `.env.example` (may section A, MODE A, MODE B). Minimum sa MODE B:
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_PASSCODE`,
`ACTIVE_DEPLOYMENT_URL`, `CRON_SECRET`, `NETLIFY_CRON_ENABLED=true`. (+ `FB_APP_SECRET`/`FB_VERIFY_TOKEN` kung gamit ang Facebook bot.)

## 6. Paglipat ng cron sa Netlify (MODE B) — sunod-sunod, para walang overlap
1. Sa Netlify: i-set ang mga variable sa itaas, **burahin** ang `VITE_BOT_API_BASE` sa `netlify.toml`, mag-deploy. Naka-off pa rin ang cron (wala pang `NETLIFY_CRON_ENABLED`) hanggang i-set mo.
2. **Sa Lovable:** i-pause/alisin ang schedule `bot-office-tick` (hilingin sa Lovable chat). *Hindi ito kayang gawin ng code na ito;
   hangga't tumatakbo ito, tatamaan pa rin ng lumang Lovable ang database.* Kung na-publish na sa Lovable ang bagong code, i-set din doon ang `ACTIVE_DEPLOYMENT_URL` (parehong value) para mag-skip ito.
3. Saka i-set ang `NETLIFY_CRON_ENABLED=true` → redeploy.
4. Tingnan: Netlify → Logs → Functions → `cron-tick` (`tick -> 200 {"ok":true,"ran":[...]}`).
5. Facebook: Meta → Webhooks → ilagay ang `https://<site>.netlify.app/api/public/bot/fb-webhook`, verify token = `FB_VERIFY_TOKEN`. Iisang callback URL lang ang dapat.
6. Kung may Python `fb_webhook_server.py` o ibang server na tumatakbo pa, patayin ito (parehong comment ang sasagutin).

## 7. Magdagdag ng bagong function/bot sa hinaharap
- Bagong API route: gumawa ng `src/routes/api/public/<pangalan>.ts` (walang pagbabago sa `netlify.toml`).
- Bagong bot: `src/server/bot/<pangalan>.ts` (Request→Response) + isang linya sa `LOADERS` ng `registry.ts`; kung scheduled, idagdag sa `CRON_JOBS`. Huwag gumawa ng bagong schedule: iisa lang ang tick.
- Kung background work na galing sa labas (webhook), gamitin ang `checkActiveDeployment(request)` sa unahan ng handler, tulad ng `bot.$fn.ts`.

## 8. Ano ang i-ZIP / i-upload
**Isama:** `src/`, `public/`, `netlify/`, `docs/`, `drizzle/`, `supabase/`, `python/`, `video-editor-service/`, `package.json`, `bun.lock`, `bunfig.toml`,
`netlify.toml`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.js`, `drizzle.config.ts`, `components.json`, `.prettierrc`, `.prettierignore`, `.gitignore`,
`.env.example`, `README.md`, `AGENTS.md`, `NETLIFY-DEPLOY.md`, `.lovable/` (para hindi masira ang Lovable sync).
**HUWAG isama:** `node_modules/`, `.git/`, `dist/`, `.output/`, `.netlify/`, `.nitro/`, `.tanstack/`, `.vinxi/`, `.env` o anumang file na may totoong secret, `*.log`, `.DS_Store`.
Dapat nasa ugat ng ZIP (o repo) ang `package.json` at `netlify.toml` — hindi nakabaon sa sub-folder.

**Mahalaga:** hindi nagbi-build ang Netlify mula sa ZIP na ina-upload sa dashboard (drag-and-drop ay para sa tapos nang static files; walang server functions).
Dalawang tamang paraan:
1. **Git (inirerekomenda):** i-push ang laman ng ZIP sa GitHub at i-connect sa Netlify. Gumamit ng **hiwalay na repo/branch** para sa Netlify — ang branch na konektado sa Lovable ay nagsi-sync pabalik sa Lovable.
2. **Netlify CLI:** `npx netlify-cli deploy --build --prod` mula sa folder (nagba-build sa computer mo at ina-upload pati ang functions).
