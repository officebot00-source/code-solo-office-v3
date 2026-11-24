<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Project rules (Code Ai Office)
- App screens live in `src/components/app/` and their logic in `src/lib/app/`, ported from the original Vite app; keep them there so they never clash with template/shadcn files (`ui-kit.tsx` is the app's own UI kit, not `src/components/ui`).
- The office (`/`) and `/go/$campaignId/$variant` use `ssr: false`: the 3D scene, voice and saved password are browser-only.
- Single-tenant app with no user accounts: access is a shared server password (`APP_PASSCODE` secret) sent as `x-app-passcode`; no table is readable with the public key; every read (named queries, `op: read`) and every write goes through `/api/public/bot/admin-db` and the other bot routes, and screens poll. The one realtime exception is the Shared Brain screen: it listens to a Realtime BROADCAST channel (`brain-sync`, constants in `src/lib/app/brainChannel.ts`) that carries only a ping (kind + rule id, never rule text) sent by the server; it then reloads through admin-db. Do NOT use Postgres-changes subscriptions on office tables (they would need read grants). Never add read or write grants/policies for anon/authenticated on office tables.
- Server logic is the original backend functions ported to `src/server/bot/*` (same names), loaded on demand by `/api/public/bot/$fn`; each handler verifies its own caller (password, scheduled service bearer, or Facebook signature). Keep them as Request→Response handlers so the original code stays recognisable.
- One managed schedule (`bot-office-tick`, every minute) calls `/api/public/cron/tick`, which runs the bots on the cadence in `CRON_JOBS` (registry.ts); change cadence there, not by adding more schedules.
- `integration_secrets`, `comment_replies`, `bot_state`, `watchdog_issues` are server-only tables (no anon/authenticated grants).
- tsconfig keeps `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes` off to match the ported code's original compiler settings.
- Copies hosted outside Lovable (Netlify) set `VITE_BOT_API_BASE` to the Lovable-published site so `botFnUrl` calls its bot routes: only the Lovable server holds the database key; keep bot routes CORS-open and password-checked.
- The AI Caption & Hashtag writer (`caption-writer` bot route) uses the Lovable AI Gateway SDK (workspace credits, no user key); the other AI features keep the user's own key from API Settings. Platform limits for captions live in `src/lib/app/caption.ts` so server, screen and tests share them.
