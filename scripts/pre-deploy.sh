#!/bin/bash
# =============================================================================
# pre-deploy.sh — Backup automático antes de hacer deploy en Render
#
# Este script exporta la BD actual desde el servidor en Render, descarga
# el backup.json y lo commitea al repo para que sobreviva al deploy.
#
# USO:
#   1. Asegúrate de tener las variables correctas abajo (DASHBOARD_URL, ADMIN_EMAIL, etc.)
#   2. Ejecuta:  bash scripts/pre-deploy.sh
#   3. Si todo sale bien, haz:  git push origin master
#
# ⚠️ REQUISITOS: curl, python3, git, una terminal con acceso al repo
# =============================================================================

set -e

# ─── CONFIG ──────────────────────────────────────────────────────────────────
DASHBOARD_URL="${DASHBOARD_URL:-https://ot-dashboard-9mn9.onrender.com}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@sistema.com}"

# Si no hay variable de entorno, preguntar
if [ -z "$ADMIN_PASSWORD" ]; then
  echo -n "🔑 Contraseña de admin para $ADMIN_EMAIL: "
  read -s ADMIN_PASSWORD
  echo ""
fi

# ─── PASO 1: Login ──────────────────────────────────────────────────────────
echo "🔐 Iniciando sesión como $ADMIN_EMAIL..."
LOGIN_RESPONSE=$(curl -s -X POST "$DASHBOARD_URL/api/auth" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")

TOKEN=$(echo "$LOGIN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")

if [ -z "$TOKEN" ] || [ "$TOKEN" = "None" ]; then
  echo "❌ Error de autenticación. Verifica credenciales."
  echo "Respuesta: $LOGIN_RESPONSE"
  exit 1
fi
echo "✅ Sesión iniciada correctamente"

# ─── PASO 2: Exportar backup en el servidor ─────────────────────────────────
echo "📤 Exportando backup desde el servidor..."
EXPORT_RESPONSE=$(curl -s -X POST "$DASHBOARD_URL/api/exportar-backup" \
  -H "Authorization: Bearer $TOKEN")
echo "   Respuesta: $EXPORT_RESPONSE"

# ─── PASO 3: Descargar backup ───────────────────────────────────────────────
echo "📥 Descargando backup..."
BACKUP_DIR="$(dirname "$0")/../data"
mkdir -p "$BACKUP_DIR"
curl -s -X GET "$DASHBOARD_URL/api/exportar-backup" \
  -H "Authorization: Bearer $TOKEN" -o "$BACKUP_DIR/backup.json"

# Validar que el backup tenga datos
VALID=$(python3 -c "
import json
with open('$BACKUP_DIR/backup.json') as f:
    d = json.load(f)
tables = [k for k in d.keys() if k != 'error']
print(f'Tables: {len(tables)}')
if tables:
    for t in tables:
        print(f'  {t}: {len(d.get(t,[]))} registros')
else:
    print('  ⚠️ Backup vacio')
")

echo "📊 Estado del backup:"
echo "$VALID"

# ─── PASO 4: Commit del backup ──────────────────────────────────────────────
echo ""
echo "📦 Cambios en backup.json:"
cd "$(dirname "$0")/.."
git diff --stat data/backup.json

echo ""
echo "¿Hacer commit y push del backup? (s/n)"
echo "Si respondes 's', se hará commit y push automáticamente."
echo "Si respondes 'n', solo se descargó el backup — haz commit manual."
read -r CONFIRM

if [ "$CONFIRM" = "s" ] || [ "$CONFIRM" = "S" ]; then
  git add data/backup.json
  TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M UTC')
  git commit -m "🤖 backup pre-deploy $TIMESTAMP"
  echo "🚀 Haciendo push a master..."
  git push origin master
  echo "✅ Backup subido y deploy iniciado en Render"
else
  echo "ℹ️ Backup descargado en data/backup.json. Haz commit manual cuando quieras."
  echo "   Ejemplo:  git add data/backup.json && git commit -m 'backup' && git push"
fi
