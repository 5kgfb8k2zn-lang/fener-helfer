#!/usr/bin/env bash
# Richtet den Fener-Helfer komplett bei Cloudflare ein bzw. aktualisiert ihn.
# Benötigt diese Umgebungsvariablen:
#   CLOUDFLARE_API_TOKEN   – Cloudflare-Token mit Rechten: Workers Scripts (Bearbeiten), D1 (Bearbeiten)
#   CLOUDFLARE_ACCOUNT_ID  – Konto-ID aus dem Cloudflare-Dashboard
#   API_FOOTBALL_KEY       – Schlüssel von api-football.com (nur beim ersten Mal nötig)
#   NTFY_TOPIC             – Kanalname der ntfy-App (nur beim ersten Mal nötig)
set -euo pipefail
cd "$(dirname "$0")"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN fehlt}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID fehlt}"
W="npx --yes wrangler@4"

# Datenbank anlegen, falls es sie noch nicht gibt, und ihre ID eintragen
ID=$($W d1 list --json | python3 -c 'import sys,json; print(next((d["uuid"] for d in json.load(sys.stdin) if d["name"]=="fener"), ""))')
if [ -z "$ID" ]; then
  $W d1 create fener >/dev/null
  ID=$($W d1 list --json | python3 -c 'import sys,json; print(next(d["uuid"] for d in json.load(sys.stdin) if d["name"]=="fener"))')
fi
sed "s/^database_name = \"fener\"$/database_name = \"fener\"\ndatabase_id = \"$ID\"/" wrangler.toml > .wrangler.deploy.toml

$W deploy --config .wrangler.deploy.toml

# Geheime Werte setzen (nur wenn übergeben)
if [ -n "${API_FOOTBALL_KEY:-}" ]; then printf '%s' "$API_FOOTBALL_KEY" | $W secret put API_KEY --config .wrangler.deploy.toml; fi
if [ -n "${NTFY_TOPIC:-}" ]; then printf '%s' "$NTFY_TOPIC" | $W secret put NTFY_TOPIC --config .wrangler.deploy.toml; fi
rm -f .wrangler.deploy.toml
echo "Fertig. Die Adresse steht oben (…workers.dev)."
