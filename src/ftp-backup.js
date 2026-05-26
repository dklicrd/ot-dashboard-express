/**
 * FTP Backup — sincronización de backup con servidor DKLIC
 *
 * Render free tier no tiene disco persistente, así que guardamos
 * el backup en un servidor FTP (hosting DKLIC) y lo descargamos
 * al iniciar la app.
 *
 * Configurar env vars (opcional, tienen valores por defecto):
 *   FTP_HOST=dklicrd.com
 *   FTP_USER=dklic-ftp@dklicrd.com
 *   FTP_PASS=Hermes@2026
 *   FTP_BACKUP_PATH=/backups/ot-dashboard/backup.json
 */

const path = require('path');
const fs = require('fs');
const ftp = require('basic-ftp');

const FTP_HOST = process.env.FTP_HOST || 'dklicrd.com';
const FTP_USER = process.env.FTP_USER || 'dklic-ftp@dklicrd.com';
const FTP_PASS = process.env.FTP_PASS || 'Hermes@2026';
const FTP_BACKUP_DIR = process.env.FTP_BACKUP_DIR || '/backups/ot-dashboard';
const FTP_BACKUP_FILE = 'backup.json';

const LOCAL_BACKUP = path.join(__dirname, '..', 'data', 'backup.json');

/**
 * Conecta al servidor FTP y retorna el cliente
 */
async function conectarFTP() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  client.timeout = 15000;
  await client.access({
    host: FTP_HOST,
    user: FTP_USER,
    password: FTP_PASS,
    secure: false
  });
  return client;
}

/**
 * Descarga backup.json desde FTP al servidor local
 * Retorna true si se descargó exitosamente
 */
async function descargarBackupFTP() {
  let client;
  try {
    console.log(`📥 Conectando a FTP: ${FTP_HOST}...`);
    client = await conectarFTP();
    
    // Verificar si el directorio y archivo existen
    try {
      await client.ensureDir(FTP_BACKUP_DIR);
    } catch(e) {
      console.log('📁 Creando directorio en FTP...');
      // Si no existe, lo creamos
    }
    
    const list = await client.list(FTP_BACKUP_DIR);
    const hasFile = list.some(item => item.name === FTP_BACKUP_FILE);
    
    if (!hasFile) {
      console.log('⚠️ No hay backup en FTP');
      return false;
    }
    
    console.log(`📥 Descargando ${FTP_HOST}${FTP_BACKUP_DIR}/${FTP_BACKUP_FILE}...`);
    await client.downloadTo(LOCAL_BACKUP + '.ftp', path.join(FTP_BACKUP_DIR, FTP_BACKUP_FILE));
    
    client.close();
    
    if (fs.existsSync(LOCAL_BACKUP + '.ftp')) {
      const size = fs.statSync(LOCAL_BACKUP + '.ftp').size;
      if (size > 0) {
        fs.renameSync(LOCAL_BACKUP + '.ftp', LOCAL_BACKUP);
        console.log(`✅ Backup descargado desde FTP (${size} bytes)`);
        return true;
      }
      fs.unlinkSync(LOCAL_BACKUP + '.ftp');
    }
    
    return false;
  } catch (e) {
    console.error('⚠️ Error descargando backup desde FTP:', e.message);
    try { if (fs.existsSync(LOCAL_BACKUP + '.ftp')) fs.unlinkSync(LOCAL_BACKUP + '.ftp'); } catch(ex) {}
    return false;
  } finally {
    if (client) try { client.close(); } catch(e) {}
  }
}

/**
 * Sube backup.json al servidor FTP
 */
async function subirBackupFTP() {
  let client;
  try {
    if (!fs.existsSync(LOCAL_BACKUP)) {
      console.log('⚠️ No hay backup local para subir a FTP');
      return false;
    }

    const size = fs.statSync(LOCAL_BACKUP).size;
    console.log(`📤 Conectando a FTP: ${FTP_HOST}...`);
    
    client = await conectarFTP();
    await client.ensureDir(FTP_BACKUP_DIR);
    
    console.log(`📤 Subiendo backup (${size} bytes)...`);
    await client.uploadFrom(LOCAL_BACKUP, path.join(FTP_BACKUP_DIR, FTP_BACKUP_FILE));
    client.close();
    
    console.log('✅ Backup subido a FTP exitosamente');
    return true;
  } catch (e) {
    console.error('❌ Error subiendo backup a FTP:', e.message);
    return false;
  } finally {
    if (client) try { client.close(); } catch(e) {}
  }
}

/**
 * Intenta restaurar backup desde FTP si el local no está disponible
 */
async function restaurarSiNecesario() {
  // Si ya hay backup local con datos, no descargar
  if (fs.existsSync(LOCAL_BACKUP)) {
    try {
      const content = JSON.parse(fs.readFileSync(LOCAL_BACKUP, 'utf-8'));
      const tableCount = Object.keys(content).length;
      if (tableCount > 0) {
        console.log(`📦 Backup local encontrado (${tableCount} tablas), no necesita FTP`);
        return false;
      }
    } catch(e) {
      console.log('⚠️ Backup local inválido, intentando FTP...');
    }
  }

  return await descargarBackupFTP();
}

module.exports = { descargarBackupFTP, subirBackupFTP, restaurarSiNecesario };
