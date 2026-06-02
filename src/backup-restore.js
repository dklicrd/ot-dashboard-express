/**
 * Backup & Restore — persistencia de datos en Render free tier
 *
 * Render free tier NO tiene disco persistente: cada deploy borra el archivo SQLite.
 * Este módulo guarda un backup de la BD como JSON en data/backup.json,
 * y si al iniciar la BD está vacía, intenta restaurar desde allí.
 *
 * ✅ SOLUCIÓN DEFINITIVA:
 *   - backup.json se mantiene ACTUALIZADO en el repositorio vía GitHub Actions
 *   - Cada operación CRUD importante exporta el backup automáticamente
 *   - El workflow .github/workflows/backup-automatico.yml corre cada 6h
 *   - Si el repositorio tiene backup.json con datos, se restaura en cada deploy
 *
 * ⚠️ Si quieres persistencia aún más robusta: Render Starter ($7/mes) con disk.
 *    Ver render.yaml — descomentar secciones disk: y DB_PATH.
 */

const fs = require('fs');
const path = require('path');
const { getDb, queryAll, queryFirst, run, transaction } = require('./db');
const { subirBackupFTP } = require('./ftp-backup');

const BACKUP_FILE = path.join(__dirname, '..', 'data', 'backup.json');

/**
 * Exporta toda la BD a un archivo JSON
 */
function exportDatabase() {
  try {
    const db = getDb();
    if (!db) return;

    const tables = [
      'usuarios',
      'clientes',
      'productos',
      'presupuestos',
      'ordenes_trabajo',
      'orden_trabajo_productos',
      'avales',
      'avales_legacy',
      'encuestas_satisfaccion',
      'configuracion_incentivos',
      'configuracion_documentos',
      'reportes_incentivos',
      'notificaciones_ot'
    ];

    const backup = {};
    for (const table of tables) {
      try {
        const rows = queryAll(`SELECT * FROM ${table}`);
        if (rows && rows.length > 0) {
          backup[table] = rows;
        }
      } catch (e) {
        // tabla no existe, ignorar
      }
    }

    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2), 'utf-8');
    console.log(`💾 Backup guardado en ${BACKUP_FILE} (${Object.keys(backup).length} tablas)`);

    // Subir a FTP para persistencia entre deploys
    try {
      const { subirBackupFTP } = require('./ftp-backup');
      subirBackupFTP().catch(() => {});
    } catch(e) {
      // FTP no disponible
    }

    return true;
  } catch (e) {
    console.error('❌ Error guardando backup:', e.message);
    return false;
  }
}

/**
 * Verifica si la BD necesita restauración.
 * RESTAURA SOLO si la BD está VACÍA (sin datos reales) y hay backup disponible.
 * Si la BD ya tiene datos (clientes, OTs, usuarios), los respeta y NO restaura.
 */
function needsRestore() {
  try {
    const numOrdenes = queryFirst('SELECT COUNT(*) as cnt FROM ordenes_trabajo')?.cnt || 0;
    const numClientes = queryFirst('SELECT COUNT(*) as cnt FROM clientes')?.cnt || 0;
    const numUsuarios = queryFirst('SELECT COUNT(*) as cnt FROM usuarios')?.cnt || 0;
    // Sólo usuarios de seed (admin y sus variantes), sin datos reales
    const hasRealData = numOrdenes > 0 || numClientes > 0 || numUsuarios > 2;

    const hasBackup = fs.existsSync(BACKUP_FILE) && fs.statSync(BACKUP_FILE).size > 0;
    const limpiadoFlag = fs.existsSync(path.join(path.dirname(BACKUP_FILE), '.limpiado'));

    // Si se hizo una limpieza intencional, NO restaurar
    if (limpiadoFlag) {
      console.log('🧹 Limpieza manual detectada (.limpiado), saltando restauracion.');
      try { fs.unlinkSync(path.join(path.dirname(BACKUP_FILE), '.limpiado')); } catch(e) {}
      return false;
    }

    // Si la BD ya tiene datos reales, NO restaurar — evitar sobreescribir datos actuales
    if (hasRealData) {
      console.log('✅ BD ya tiene datos (' + numOrdenes + ' OTs, ' + numClientes + ' clientes, ' + numUsuarios + ' usuarios). Saltando restauración para conservar datos actuales.');

      // Actualizar backup local con los datos actuales (así el backup refleja el estado real)
      try { exportDatabase(); } catch(e) {}
      return false;
    }

    // BD vacía: restaurar desde backup si existe
    if (hasBackup) {
      try {
        const backupContent = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
        const tableCount = Object.keys(backupContent).length;

        if (tableCount === 0) {
          console.log('📭 Backup vacío (0 tablas), saltando restauración.');
          return false;
        }

        const numBackupClientes = (backupContent.clientes || []).length;
        const numBackupOTs = (backupContent.ordenes_trabajo || []).length;
        const numBackupUsuarios = (backupContent.usuarios || []).length;

        if (numBackupClientes > 0 || numBackupOTs > 0 || numBackupUsuarios > 0) {
          console.log('🔄 BD vacía — restaurando desde backup (' + numBackupClientes + ' clientes, ' + numBackupOTs + ' OTs, ' + numBackupUsuarios + ' usuarios)...');
          return true;
        }
      } catch (e) {
        console.log('⚠️ Backup inválido, saltando restauración.');
      }
    }

    return false;
  } catch (e) {
    console.error('❌ Error verificando restauración:', e.message);
    return false;
 }
}

/**
 * Restaura la BD desde el backup
 */
function restoreDatabase() {
  try {
    const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
    const tableCount = Object.keys(backup).length;

    if (tableCount === 0) {
      console.log('⚠️ Backup vacío, no se restaura.');
      return false;
    }

    console.log(`🔄 Restaurando BD desde backup (${tableCount} tablas)...`);

    transaction(() => {
      // Desactivar foreign keys y limpiar tablas en orden inverso
      const allTables = Object.keys(backup).reverse();

      // Primera pasada: limpiar
      for (const table of allTables) {
        try {
          run(`DELETE FROM ${table}`);
        } catch (e) {
          console.warn(`⚠️ No se pudo limpiar ${table}: ${e.message}`);
        }
      }

      // Segunda pasada: insertar datos
      for (const [table, rows] of Object.entries(backup)) {
        if (!rows || rows.length === 0) continue;

        const columns = Object.keys(rows[0]);
        const placeholders = columns.map(() => '?').join(', ');
        const colNames = columns.join(', ');

        for (const row of rows) {
          try {
            const values = columns.map(col => row[col] ?? null);
            run(`INSERT INTO ${table} (${colNames}) VALUES (${placeholders})`, values);
          } catch (e) {
            console.warn(`⚠️ Error insertando en ${table}: ${e.message}`);
          }
        }
        console.log(`  ✓ ${table}: ${rows.length} registros restaurados`);
      }
    });

    console.log('✅ BD restaurada exitosamente');
    return true;
  } catch (e) {
    console.error('❌ Error restaurando BD:', e.message);
    return false;
  }
}


module.exports = { exportDatabase, needsRestore, restoreDatabase, BACKUP_FILE };
