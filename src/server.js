const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { getDb, queryAll, queryFirst, run, transaction } = require('./db');
const multer = require('multer');
const upload = multer({
  dest: path.join(__dirname, '..', 'public', 'uploads', 'presupuestos'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo PDFs e imágenes'), false);
    }
  }
});
const { initDatabase, verificarYRestaurarBackup } = require('./init-db');
const { authMiddleware, adminOnly, superAdminOnly, generarToken, verificarToken } = require('./auth');
const { exportDatabase } = require('./backup-restore');
const { generarAvalPDF } = require('./pdf');
const { v4: uuidv4 } = require('uuid');
const { enviarEmail, enviarNotificacionOT, enviarNotificacionAval, enviarEmailConfirmacionOT, enviarNotificacionCambioFecha } = require('./email');

const app = express();
const PORT = process.env.PORT || 3000;
const DEPLOY_VERSION = 'v' + Date.now();

console.log('🚀 OT Dashboard ' + DEPLOY_VERSION);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Inicializar BD
async function start() {
  try {
    await getDb();
    await initDatabase();
  } catch (e) {
    console.error('⚠️ Error inicializando BD (el servidor intentará arrancar de todas formas):', e.message);
    console.error(e.stack);
  }

  try {
    app.listen(PORT, () => {
      console.log(`🌐 Servidor corriendo en http://localhost:${PORT}`);
      // Iniciar cron de encuestas
      iniciarCronEncuestas();
    });
  } catch (e) {
    console.error('Error iniciando servidor:', e.message);
    process.exit(1);
  }
}

// ============ HELPERS ============
function generarNumeroOT(db) {
  const year = new Date().getFullYear();
  const row = queryFirst("SELECT COUNT(*) as cnt FROM ordenes_trabajo WHERE strftime('%Y', creado_en) = ?", [String(year)]);
  const count = row?.cnt || 0;
  return `OT-${year}-${String(count + 1).padStart(4, '0')}`;
}

function generarNumeroAval() {
  const year = new Date().getFullYear();
  const row = queryFirst("SELECT COUNT(*) as cnt FROM avales WHERE strftime('%Y', creado_en) = ?", [String(year)]);
  const count = row?.cnt || 0;
  return `AV-NUEVO-${year}-${String(count + 1).padStart(4, '0')}`;
}

// ═══════════════════════════════════════════════
// HELPERS: Días hábiles y encuestas
// ═══════════════════════════════════════════════
function sumarDiasHabiles(fechaStr, dias) {
  const fecha = new Date(fechaStr + 'T12:00:00-04:00');
  if (isNaN(fecha.getTime())) return fechaStr;
  let contados = 0;
  while (contados < dias) {
    fecha.setDate(fecha.getDate() + 1);
    const diaSem = fecha.getDay();
    if (diaSem !== 0 && diaSem !== 6) contados++;
  }
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Calcular días hábiles entre dos fechas
function diasHabilesEntre(fechaInicio, fechaFin) {
  const inicio = new Date(fechaInicio + 'T12:00:00-04:00');
  const fin = new Date(fechaFin + 'T12:00:00-04:00');
  if (isNaN(inicio.getTime()) || isNaN(fin.getTime())) return 0;
  let count = 0;
  const current = new Date(inicio);
  while (current <= fin) {
    const diaSem = current.getDay();
    if (diaSem !== 0 && diaSem !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

// Generar token único para encuesta pública
function generarTokenEncuesta() {
  const crypto = require('crypto');
  return crypto.randomBytes(16).toString('hex');
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============ PRECIOS ============
const PRECIOS_PROYECTO_NUEVO = {
  cerradura: 150,
  caja_fuerte: 60,
  control_acceso: 300,
  ahorro_energia: 105
};
const PRECIOS_MANTENIMIENTO = {
  cerradura: 82.50,
  caja_fuerte: 30,
  ahorro_energia: 37.50
};

// Cache de precios desde BD (refresca cada 60s o en exportDatabase)
let _preciosCache = null;
let _preciosCacheTime = 0;
const PRECIOS_CACHE_TTL = 60000; // 60 segundos

function getPreciosFromDB() {
  try {
    const now = Date.now();
    if (_preciosCache && (now - _preciosCacheTime) < PRECIOS_CACHE_TTL) {
      return _preciosCache;
    }

    // Cargar precios desde la nueva tabla categorias_servicio (configurable)
    const result = {};

    try {
      const tipos = queryAll('SELECT * FROM tipos_servicio WHERE activo = 1');
      for (const tipo of tipos) {
        const cats = queryAll('SELECT key, precio FROM categorias_servicio WHERE tipo_servicio_id = ? AND activo = 1', [tipo.id]);
        const precios = {};
        for (const c of cats) {
          precios[c.key] = c.precio;
        }
        result[tipo.nombre] = precios;
      }
    } catch (e2) {
      console.error('Error leyendo categorias_servicio:', e2.message);
    }

    // Fallback a valores hardcodeados si no hay datos en BD
    if (Object.keys(result).length === 0) {
      _preciosCache = {
        proyecto_nuevo: { ...PRECIOS_PROYECTO_NUEVO },
        mantenimiento: { ...PRECIOS_MANTENIMIENTO }
      };
      _preciosCacheTime = now;
      return _preciosCache;
    }

    _preciosCache = result;
    _preciosCacheTime = now;
    return _preciosCache;
  } catch (e) {
    console.error('Error leyendo precios de BD:', e.message);
    _preciosCache = {
      proyecto_nuevo: { ...PRECIOS_PROYECTO_NUEVO },
      mantenimiento: { ...PRECIOS_MANTENIMIENTO }
    };
    _preciosCacheTime = now;
    return _preciosCache;
  }
}

// Invalidar cache de precios (llamar después de guardar config)
function invalidarPreciosCache() {
  _preciosCache = null;
  _preciosCacheTime = 0;
}

// ==================== API: AUTH ====================
app.post('/api/auth', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    await getDb();
    let user = queryFirst('SELECT * FROM usuarios WHERE email = ? AND activo = 1', [email]);

    if (!user) {
      // Si es admin, crearlo automaticamente con password forzada
      if (email === 'admin@sistema.com') {
        const hashFijo = bcrypt.hashSync('3806.Adm', 10);
        run('INSERT INTO usuarios (nombre, email, password, rol, activo) VALUES (?, ?, ?, ?, 1)',
          ['Administrador', 'admin@sistema.com', hashFijo, 'superadmin']);
        user = queryFirst('SELECT * FROM usuarios WHERE email = ?', ['admin@sistema.com']);
        console.log('👤 Admin recreado en login');
      } else {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
    }

    // Forzar password de admin por si el backup trajo un hash viejo
    if (user.email === 'admin@sistema.com') {
      const hashFijo = bcrypt.hashSync('3806.Adm', 10);
      run('UPDATE usuarios SET password = ? WHERE id = ?', [hashFijo, user.id]);
      user.password = hashFijo;
    }

    let valid = false;
    if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$') || user.password.startsWith('$2y$')) {
      valid = await bcrypt.compare(password, user.password);
    } else {
      valid = password === user.password;
      // Upgrade legacy password
      if (valid) {
        const hashed = await bcrypt.hash(password, 10);
        run('UPDATE usuarios SET password = ? WHERE id = ?', [hashed, user.id]);
      }
    }

    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = generarToken({ userId: user.id, nombre: user.nombre, email: user.email, rol: user.rol });
    res.json({
      token,
      user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol, telefono: user.telefono }
    });
  } catch (e) {
    console.error('Auth error:', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/auth', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ==================== API: USUARIOS ====================
app.get('/api/usuarios', authMiddleware, adminOnly, (req, res) => {
  const usuarios = queryAll('SELECT id, nombre, email, rol, telefono, activo FROM usuarios ORDER BY nombre');
  res.json({ usuarios });
});

app.post('/api/usuarios', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nombre, email, password, rol, telefono } = req.body;
    if (!nombre || !email || !password || !rol) {
      return res.status(400).json({ error: 'Campos requeridos faltantes' });
    }
    if (!['admin', 'tecnico', 'servicio_cliente'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    if (rol === 'admin' && req.user.rol === 'superadmin') { /* allow admin creation */ }

    const hashed = await bcrypt.hash(password, 10);
    run('INSERT INTO usuarios (nombre, email, password, rol, telefono) VALUES (?, ?, ?, ?, ?)',
      [nombre.trim(), email.trim().toLowerCase(), hashed, rol, telefono || null]);
    try { exportDatabase(); } catch(e) { console.error("Backup error:", e.message); }
    res.status(201).json({ message: 'Usuario creado' });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'El email ya existe' });
    }
    console.error('Error creating user:', e);
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

// ==================== API: ACTUALIZAR USUARIO ============ 
app.put('/api/usuarios/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { nombre, email, password, rol, telefono } = req.body;
    if (!nombre || !email || !rol) {
      return res.status(400).json({ error: 'Nombre, email y rol requeridos' });
    }
    if (!['admin', 'tecnico', 'servicio_cliente', 'superadmin'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    if (password && password.length >= 6) {
      const hashed = await bcrypt.hash(password, 10);
      run('UPDATE usuarios SET nombre=?, email=?, password=?, rol=?, telefono=? WHERE id=?',
        [nombre.trim(), email.trim().toLowerCase(), hashed, rol, telefono || null, id]);
    } else {
      run('UPDATE usuarios SET nombre=?, email=?, rol=?, telefono=? WHERE id=?',
        [nombre.trim(), email.trim().toLowerCase(), rol, telefono || null, id]);
    }
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
    res.json({ message: 'Usuario actualizado' });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'El email ya existe' });
    }
    console.error('Error updating user:', e);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

app.delete('/api/usuarios/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.userId) {
      return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
    }
    run('UPDATE usuarios SET activo = 0 WHERE id = ?', [id]);
    res.json({ message: 'Usuario desactivado' });
    try { exportDatabase(); } catch(e) { console.error("Backup error:", e.message); }
  } catch (e) {
    console.error('Error deleting user:', e);
    res.status(500).json({ error: 'Error al eliminar usuario' });
  }
});

// ==================== API: AUTH / PASSWORD ====================
app.put('/api/auth/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Contraseña actual y nueva requeridas' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const user = queryFirst('SELECT * FROM usuarios WHERE id = ?', [req.user.userId]);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    let valid = false;
    if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$') || user.password.startsWith('$2y$')) {
      valid = await bcrypt.compare(currentPassword, user.password);
    } else {
      valid = currentPassword === user.password;
    }
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    const hashed = await bcrypt.hash(newPassword, 10);
    run('UPDATE usuarios SET password = ? WHERE id = ?', [hashed, req.user.userId]);

    res.json({ message: 'Contraseña actualizada correctamente' });
    try { exportDatabase(); } catch(e) { console.error("Backup error:", e.message); }
  } catch (e) {
    console.error('Error changing password:', e);
    res.status(500).json({ error: 'Error al cambiar contraseña' });
  }
});

// ==================== API: CLIENTES ====================
app.get('/api/clientes', authMiddleware, (req, res) => {
  const search = req.query.search;
  let clientes;
  if (search) {
    clientes = queryAll('SELECT * FROM clientes WHERE nombre LIKE ? OR telefono LIKE ? OR email LIKE ? ORDER BY nombre LIMIT 20',
      [`%${search}%`, `%${search}%`, `%${search}%`]);
  } else {
    clientes = queryAll('SELECT * FROM clientes ORDER BY nombre');
  }
  res.json({ clientes });
});

app.post('/api/clientes', authMiddleware, adminOnly, (req, res) => {
  try {
    const { nombre, telefono, email, direccion, cedula_rnc, tipo, referencias_ubicacion } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });

    run('INSERT INTO clientes (nombre, telefono, email, direccion, cedula_rnc, tipo, referencias_ubicacion) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [nombre.trim(), telefono || null, email || null, direccion || null, cedula_rnc || null, tipo || 'particular', referencias_ubicacion || null]);
    try { exportDatabase(); } catch(e) { console.error("Backup error:", e.message); }
    res.status(201).json({ message: 'Cliente creado' });
  } catch (e) {
    console.error('Error creating client:', e);
    res.status(500).json({ error: 'Error al crear cliente' });
  }
});

// ==================== API: PRODUCTOS ====================
app.get('/api/productos', authMiddleware, (req, res) => {
  const incluirInactivos = req.query.todos === '1';
  let productos;
  if (incluirInactivos) {
    productos = queryAll('SELECT * FROM productos ORDER BY activo DESC, nombre');
  } else {
    productos = queryAll('SELECT * FROM productos WHERE activo = 1 ORDER BY nombre');
  }
  res.json({ productos });
});

app.post('/api/productos', authMiddleware, adminOnly, (req, res) => {
  try {
    const { nombre, categoria, descripcion } = req.body;
    if (!nombre || !categoria) {
      return res.status(400).json({ error: 'Nombre y categoría requeridos' });
    }
    const validCategories = ['cerradura', 'puerta', 'control_acceso', 'caja_fuerte', 'ahorro_energia', 'otro'];
    if (!validCategories.includes(categoria)) {
      return res.status(400).json({ error: 'Categoría inválida' });
    }
    run('INSERT INTO productos (nombre, categoria, descripcion) VALUES (?, ?, ?)',
      [nombre.trim(), categoria, descripcion || null]);
    try { exportDatabase(); } catch(e) { console.error("Backup error:", e.message); }
    res.status(201).json({ message: 'Producto creado' });
  } catch (e) {
    console.error('Error creating producto:', e);
    res.status(500).json({ error: 'Error al crear producto' });
  }
});

app.put('/api/productos/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { nombre, categoria, descripcion, activo } = req.body;
    if (!nombre || !categoria) {
      return res.status(400).json({ error: 'Nombre y categoría requeridos' });
    }
    const validCategories = ['cerradura', 'puerta', 'control_acceso', 'caja_fuerte', 'ahorro_energia', 'otro'];
    if (!validCategories.includes(categoria)) {
      return res.status(400).json({ error: 'Categoría inválida' });
    }
    run('UPDATE productos SET nombre=?, categoria=?, descripcion=?, activo=? WHERE id=?',
      [nombre.trim(), categoria, descripcion || null, activo !== undefined ? (activo ? 1 : 0) : 1, id]);
    res.json({ message: 'Producto actualizado' });
    try { exportDatabase(); } catch(e) { console.error("Backup error:", e.message); }
  } catch (e) {
    console.error('Error updating producto:', e);
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
});

app.delete('/api/productos/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    run('UPDATE productos SET activo = 0 WHERE id = ?', [id]);
    res.json({ message: 'Producto desactivado' });
  } catch (e) {
    console.error('Error deleting producto:', e);
    res.status(500).json({ error: 'Error al desactivar producto' });
  }
});

// ==================== API: PRESUPUESTOS ====================
app.get('/api/presupuestos', authMiddleware, (req, res) => {
  const presupuestos = queryAll(`
    SELECT p.*, c.nombre as cliente_nombre
    FROM presupuestos p
    LEFT JOIN clientes c ON p.cliente_id = c.id
    ORDER BY p.creado_en DESC
  `);
  res.json({ presupuestos });
});

app.post('/api/presupuestos', authMiddleware, adminOnly, (req, res) => {
  try {
    const { cliente_id, nombre_proyecto, aprobado } = req.body;
    if (!nombre_proyecto) return res.status(400).json({ error: 'Nombre del proyecto requerido' });
    run('INSERT INTO presupuestos (cliente_id, nombre_proyecto, aprobado) VALUES (?, ?, ?)',
      [cliente_id || null, nombre_proyecto, aprobado ? 1 : 0]);
    try { exportDatabase(); } catch(e) { console.error("Backup error:", e.message); }
    res.status(201).json({ message: 'Presupuesto creado' });
  } catch (e) {
    console.error('Error creating presupuesto:', e);
    res.status(500).json({ error: 'Error al crear presupuesto' });
  }
});

// ==================== API: ÓRDENES DE TRABAJO ====================
app.get('/api/ordenes', authMiddleware, (req, res) => {
  const estado = req.query.estado;
  let sql = `
    SELECT ot.*, c.nombre as cliente_nombre, c.telefono as cliente_telefono, c.email as cliente_email,
           u.nombre as tecnico_nombre, p.nombre_proyecto,
           (SELECT a.id FROM avales a WHERE a.orden_trabajo_id = ot.id LIMIT 1) as aval_id,
           (SELECT a.estado FROM avales a WHERE a.orden_trabajo_id = ot.id LIMIT 1) as aval_estado,
           (SELECT e.id FROM encuestas_satisfaccion e WHERE e.orden_trabajo_id = ot.id LIMIT 1) as encuesta_id
    FROM ordenes_trabajo ot
    JOIN clientes c ON ot.cliente_id = c.id
    LEFT JOIN usuarios u ON ot.tecnico_id = u.id
    LEFT JOIN presupuestos p ON ot.presupuesto_id = p.id
    WHERE 1=1
  `;
  const params = [];

  if (estado) {
    const estados = estado.split(',');
    sql += ' AND ot.estado IN (' + estados.map(() => '?').join(',') + ')';
    params.push(...estados);
  }
  if (req.user.rol === 'tecnico') { sql += ' AND ot.tecnico_id = ?'; params.push(req.user.userId); }

  sql += ' ORDER BY ot.creado_en DESC LIMIT 100';

  const ordenes = queryAll(sql, params);

  // Attach productos to each order
  for (const ot of ordenes) {
    const prods = queryAll(`
      SELECT p.id, p.nombre, p.categoria, otp.cantidad
      FROM orden_trabajo_productos otp
      JOIN productos p ON otp.producto_id = p.id
      WHERE otp.orden_trabajo_id = ?
    `, [ot.id]);
    ot.productos = prods;

    // Get average evaluation if encuesta exists
    if (ot.encuesta_id) {
      const encuesta = queryFirst(`
        SELECT tiempo_entrega, desempeno_equipo, presentacion_equipo, calidad_productos, calidad_entrenamientos
        FROM encuestas_satisfaccion WHERE id = ?
      `, [ot.encuesta_id]);
      if (encuesta) {
        const avg = (encuesta.tiempo_entrega + encuesta.desempeno_equipo + encuesta.presentacion_equipo + encuesta.calidad_productos + encuesta.calidad_entrenamientos) / 5;
        ot.evaluacion_promedio = avg;
      }
    }
  }

  res.json({ ordenes });
});

app.post('/api/ordenes', authMiddleware, (req, res) => {
  try {
    const num = generarNumeroOT();
    const body = req.body;

    // Validar fecha programada obligatoria
    if (!body.fecha_programada) {
      return res.status(400).json({ error: 'La fecha programada es obligatoria' });
    }

    let montoCalculado = 0;

    if (body.tipo_servicio === 'garantia' || body.tipo_servicio === 'levantamiento' || body.tipo_servicio === 'vtc') {
      // Garantia y levantamiento monto 0
    } else {
    // Calculate monto_total from precios fijos
    if (body.productos && Array.isArray(body.productos)) {
      const tipo = body.tipo_servicio || 'proyecto_nuevo';
      const preciosData = getPreciosFromDB();
      const precios = tipo === 'mantenimiento' ? preciosData.mantenimiento : preciosData.proyecto_nuevo;
      for (const p of body.productos) {
        if (p.cantidad > 0) {
          var cat = p.categoria || '';
          if (!cat && p.producto_id) {
            var prod = queryFirst('SELECT categoria FROM productos WHERE id = ?', [p.producto_id]);
            cat = prod?.categoria || '';
          }
          var precio = precios[cat] || 0;
          montoCalculado += precio * p.cantidad;
        }
      }
    }
    }

    run(`INSERT INTO ordenes_trabajo (numero_ot, cliente_id, tipo_servicio, descripcion, presupuesto_aprobado,
      monto_total, tecnico_id, estado, fuente, notas, creada_por, fecha_programada, presupuesto_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [num, body.cliente_id, body.tipo_servicio, body.descripcion || null,
       body.presupuesto_aprobado ? 1 : 0, montoCalculado, body.tecnico_id || null,
       body.estado || 'pendiente', (body.fuente === 'presupuesto' || body.fuente === 'garantia' || body.fuente === 'levantamiento' || body.fuente === 'vtc' ? 'manual' : body.fuente || 'manual'), body.notas || null,
       req.user.userId, body.fecha_programada || null, body.presupuesto_id || null]);

    // Get the inserted OT id
    const otRow = queryFirst('SELECT id FROM ordenes_trabajo WHERE numero_ot = ?', [num]);

    // Insert productos if provided
    if (body.productos && Array.isArray(body.productos) && otRow) {
      for (const p of body.productos) {
        if (p.cantidad > 0) {
          var pid = p.producto_id || 0;
          // If no producto_id but has categoria, create or find product by categoria
          // If no pid but has categoria, create the product on the fly
          if (!pid && p.categoria) {
            run('INSERT OR IGNORE INTO productos (nombre, categoria, descripcion) VALUES (?, ?, ?)',
              [p.categoria, p.categoria, 'Creado automaticamente desde OT']);
            var prodNuevo = queryFirst('SELECT id FROM productos WHERE categoria = ?', [p.categoria]);
            pid = prodNuevo ? prodNuevo.id : 0;
          }
          if (pid > 0) {
            run('INSERT INTO orden_trabajo_productos (orden_trabajo_id, producto_id, cantidad) VALUES (?, ?, ?)',
              [otRow.id, pid, p.cantidad]);
          }
        }
      }
    }

    // Si la OT se crea con tecnico asignado y estado pendiente, generar tokens (sin enviar email por ahora)
    if (otRow && body.tecnico_id && (body.estado || 'pendiente') === 'pendiente') {
      var tokenConfirmar = uuidv4();
      var tokenCambio = uuidv4();
      var expiraEn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];

      run("INSERT INTO confirmacion_tokens (token, tipo, orden_trabajo_id, tecnico_id, expira_en) VALUES (?, 'confirmar_fecha', ?, ?, ?)",
        [tokenConfirmar, otRow.id, body.tecnico_id, expiraEn]);
      run("INSERT INTO confirmacion_tokens (token, tipo, orden_trabajo_id, tecnico_id, expira_en) VALUES (?, 'solicitar_cambio', ?, ?, ?)",
        [tokenCambio, otRow.id, body.tecnico_id, expiraEn]);
      // Enviar email en segundo plano (con catch para no romper la creacion)
      enviarEmailConfirmacionOT(otRow.id, tokenConfirmar, tokenCambio).catch(function(e) {
        console.error('Error enviando email confirmacion OT', num, ':', e.message);
      });
    }

    res.status(201).json({ numero_ot: num, monto_incentivo: montoCalculado, message: 'OT creada' });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error creating OT:', e);
    res.status(500).json({ error: 'Error al crear OT: ' + e.message });
  }
});

app.put('/api/ordenes', authMiddleware, (req, res) => {
  try {
    const b = req.body;
    run(`UPDATE ordenes_trabajo SET cliente_id=?, tipo_servicio=?, descripcion=?, monto_total=?, tecnico_id=?,
      estado=?, notas=?, fecha_programada=?, presupuesto_id=?, actualizado_en=datetime('now', '-04:00') WHERE id=?`,
      [b.cliente_id, b.tipo_servicio, b.descripcion, b.monto_total, b.tecnico_id,
       b.estado, b.notas, b.fecha_programada, b.presupuesto_id || null, b.id]);

    // Update productos if provided (remove old, insert new)
    if (b.productos && Array.isArray(b.productos)) {
      run('DELETE FROM orden_trabajo_productos WHERE orden_trabajo_id = ?', [b.id]);
      for (const p of b.productos) {
        if (p.producto_id && p.cantidad > 0) {
          run('INSERT INTO orden_trabajo_productos (orden_trabajo_id, producto_id, cantidad) VALUES (?, ?, ?)',
            [b.id, p.producto_id, p.cantidad]);
        }
      }
    }

    res.json({ success: true });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error updating OT:', e);
    res.status(500).json({ error: 'Error al actualizar OT' });
  }
});

// ==================== API: DELETE ORDEN DE TRABAJO ====================
app.delete('/api/ordenes/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = req.params.id;
    const ot = queryFirst('SELECT id, presupuesto_id FROM ordenes_trabajo WHERE id = ?', [id]);
    if (!ot) {
      return res.status(404).json({ error: 'OT no encontrada' });
    }
    // Eliminar registros relacionados
    run('DELETE FROM orden_trabajo_productos WHERE orden_trabajo_id = ?', [id]);
    run('DELETE FROM avales WHERE orden_trabajo_id = ?', [id]);
    run('DELETE FROM encuestas_satisfaccion WHERE orden_trabajo_id = ?', [id]);
    // Eliminar presupuesto si solo esta OT lo referenciaba
    if (ot.presupuesto_id) {
      const otrasOTs = queryFirst('SELECT COUNT(*) as cnt FROM ordenes_trabajo WHERE presupuesto_id = ? AND id != ?', [ot.presupuesto_id, id]);
      if (otrasOTs?.cnt === 0) {
        run('DELETE FROM presupuestos WHERE id = ?', [ot.presupuesto_id]);
      }
    }
    // Eliminar la OT
    run('DELETE FROM ordenes_trabajo WHERE id = ?', [id]);

    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
    res.json({ success: true, message: 'OT eliminada' });
  } catch (e) {
    console.error('Error eliminando OT:', e);
    res.status(500).json({ error: 'Error al eliminar OT' });
  }
});

// ============ ESTADO DE OT - TRANSICIONES ============
const TRANSICIONES_ESTADO = {
  'pendiente': ['en_curso', 'cancelada'],
  'en_curso': ['cancelada'], // 'aval_entregado' se maneja desde flujo de avales
  'aval_entregado': ['completada', 'cancelada'],
};

// ==================== API: ORDEN DE TRABAJO POR ID (detalle completo) ====================
app.get('/api/ordenes/:id', authMiddleware, (req, res) => {
  try {
    const id = Number(req.params.id);
    const ot = queryFirst(`
      SELECT ot.*, c.nombre as cliente_nombre, c.telefono as cliente_telefono,
             c.email as cliente_email, c.direccion as cliente_direccion,
             c.cedula_rnc as cliente_cedula_rnc, c.tipo as cliente_tipo,
             u.id as tecnico_id, u.nombre as tecnico_nombre, u.telefono as tecnico_telefono,
             p.nombre_proyecto, p.aprobado as presupuesto_aprobado,
             cr.nombre as creado_por_nombre
      FROM ordenes_trabajo ot
      JOIN clientes c ON ot.cliente_id = c.id
      LEFT JOIN usuarios u ON ot.tecnico_id = u.id
      LEFT JOIN presupuestos p ON ot.presupuesto_id = p.id
      LEFT JOIN usuarios cr ON ot.creada_por = cr.id
      WHERE ot.id = ?
    `, [id]);

    if (!ot) return res.status(404).json({ error: 'OT no encontrada' });

    // Productos con precios
    const productos = queryAll(`
      SELECT p.id, p.nombre, p.categoria, p.descripcion as producto_descripcion,
             otp.cantidad
      FROM orden_trabajo_productos otp
      JOIN productos p ON otp.producto_id = p.id
      WHERE otp.orden_trabajo_id = ?
    `, [id]);

    // Calcular precios unitarios según tipo de servicio
    const preciosCfg = getPreciosFromDB();
    const precios = ot.tipo_servicio === 'mantenimiento' ? preciosCfg.mantenimiento : preciosCfg.proyecto_nuevo;
    const productosConPrecio = productos.map(p => ({
      ...p,
      precio_unitario: precios[p.categoria] || 0,
      subtotal: (precios[p.categoria] || 0) * p.cantidad
    }));

    // Aval asociado
    const aval = queryFirst(`
      SELECT a.*, u.nombre as tecnico_nombre
      FROM avales a
      LEFT JOIN usuarios u ON a.tecnico_id = u.id
      WHERE a.orden_trabajo_id = ?
    `, [id]);

    // Encuesta asociada
    const encuesta = queryFirst(`
      SELECT * FROM encuestas_satisfaccion WHERE orden_trabajo_id = ?
    `, [id]);

    // Desglose por categoría
    const desglose = {};
    let montoCalculado = 0;
    for (const p of productosConPrecio) {
      const cat = p.categoria || 'otro';
      if (!desglose[cat]) desglose[cat] = { cantidad: 0, subtotal: 0 };
      desglose[cat].cantidad += p.cantidad;
      desglose[cat].subtotal += p.subtotal;
      montoCalculado += p.subtotal;
    }

    res.json({
      orden: {
        ...ot,
        productos: productosConPrecio,
        desglose,
        monto_calculado: Math.round(montoCalculado * 100) / 100
      },
      aval: aval || null,
      encuesta: encuesta ? {
        ...encuesta,
        promedio: encuesta.tiempo_entrega && encuesta.desempeno_equipo ?
          Math.round((encuesta.tiempo_entrega + encuesta.desempeno_equipo + encuesta.presentacion_equipo + encuesta.calidad_productos + encuesta.calidad_entrenamientos) / 5 * 10) / 10 : null
      } : null
    });
  } catch (e) {
    console.error('Error fetching OT detail:', e);
    res.status(500).json({ error: 'Error al obtener detalle de OT' });
  }
});

app.put('/api/ordenes/:id/estado', authMiddleware, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado: nuevoEstado } = req.body;

    const ot = queryFirst('SELECT * FROM ordenes_trabajo WHERE id = ?', [id]);
    if (!ot) return res.status(404).json({ error: 'OT no encontrada' });

    const transicionesPermitidas = TRANSICIONES_ESTADO[ot.estado] || [];
    if (!transicionesPermitidas.includes(nuevoEstado)) {
      return res.status(400).json({
        error: `Transición no permitida: ${ot.estado} → ${nuevoEstado}. Permitidas: ${transicionesPermitidas.join(', ') || 'ninguna'}`
      });
    }

    // Validaciones adicionales
    if (nuevoEstado === 'en_curso') {
      if (ot.tecnico_id === null) {
        return res.status(400).json({ error: 'La OT debe tener un tecnico asignado para iniciarse' });
      }
      run("UPDATE ordenes_trabajo SET estado=?, fecha_inicio=datetime('now', '-04:00'), actualizado_en=datetime('now', '-04:00') WHERE id=?", [nuevoEstado, id]);
      // Enviar notificaciones por email al iniciar OT
      enviarNotificacionOT(id).then(result => {
        console.log('Email OT notificacion:', result?.success ? 'enviado' : 'fallo');
      }).catch(e => console.error('Error enviando email OT:', e.message));
      res.json({ message: 'Estado actualizado', email: 'enviando' });
    } else if (nuevoEstado === 'cancelada') {
      // Si la OT tiene avales activos, marcarlos como rechazados
      if (ot.estado === 'aval_entregado') {
        const avalesActivos = queryAll("SELECT id FROM avales WHERE orden_trabajo_id = ? AND estado IN ('pendiente', 'firmado_cliente')", [id]);
        for (const av of avalesActivos) {
          run("UPDATE avales SET estado='rechazado', productos_admin='[]', confirmado_por=?, fecha_confirmacion_admin=datetime('now', '-04:00'), observaciones=COALESCE(observaciones, '') || ' | Motivo: OT cancelada' WHERE id=?",
            [req.user.userId, av.id]);
        }
      }
      run("UPDATE ordenes_trabajo SET estado=?, actualizado_en=datetime('now', '-04:00') WHERE id=?", [nuevoEstado, id]);
      try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
      return res.json({ success: true, nuevoEstado });
    } else if (nuevoEstado === 'completada' && ot.estado === 'en_curso') {
      // Solo admin/superadmin pueden completar directo (sin aval)
      if (req.user.rol !== 'admin' && req.user.rol !== 'superadmin') {
        return res.status(403).json({ error: 'Solo administradores pueden completar OTs directamente' });
      }
      run("UPDATE ordenes_trabajo SET estado=?, fecha_fin=datetime('now', '-04:00'), actualizado_en=datetime('now', '-04:00') WHERE id=?", [nuevoEstado, id]);
      // Notificar completada
      enviarNotificacionOT(id).then(result => {
        console.log('Email OT completada:', result?.success ? 'enviado' : 'fallo');
      }).catch(e => console.error('Error enviando email OT completada:', e.message));
      res.json({ message: 'OT completada directamente', completada_directo: true });
    } else {
      run("UPDATE ordenes_trabajo SET estado=?, actualizado_en=datetime('now', '-04:00') WHERE id=?", [nuevoEstado, id]);
      res.json({ message: 'Estado actualizado' });
    }

    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
    res.json({ success: true, nuevoEstado });
  } catch (e) {
    console.error('Error actualizando estado OT:', e);
    res.status(500).json({ error: 'Error al actualizar estado' });
  }
});

// ==================== API: AVALES (NUEVO FLUJO - entrega técnica) ====================

// GET /api/avales — listar (nuevo flujo)
app.get('/api/avales', authMiddleware, (req, res) => {
  const otId = req.query.orden_trabajo_id;
  const listarNuevos = req.query.nuevo === '1';

  if (!listarNuevos) {
    // Por defecto respondemos con el nuevo flujo
  }

  let sql;
  const params = [];

  if (listarNuevos || !req.query.orden_trabajo_id) {
    sql = `
      SELECT a.*, ot.numero_ot, c.nombre as cliente_nombre, c.telefono as cliente_telefono,
             u.nombre as tecnico_nombre
      FROM avales a
      JOIN ordenes_trabajo ot ON a.orden_trabajo_id = ot.id
      JOIN clientes c ON ot.cliente_id = c.id
      LEFT JOIN usuarios u ON a.tecnico_id = u.id
      WHERE 1=1
    `;
  } else {
    // Legacy query (used by existing views)
    sql = `
      SELECT a.*, ot.numero_ot, c.nombre as cliente_nombre, c.telefono as cliente_telefono
      FROM avales_legacy a
      JOIN ordenes_trabajo ot ON a.orden_trabajo_id = ot.id
      JOIN clientes c ON ot.cliente_id = c.id
      WHERE 1=1
    `;
  }

  if (otId) { sql += ' AND a.orden_trabajo_id = ?'; params.push(Number(otId)); }
  if (req.user.rol === 'tecnico' && listarNuevos) { sql += ' AND a.tecnico_id = ?'; params.push(req.user.userId); }

  sql += ' ORDER BY a.creado_en DESC';

  res.json({ avales: queryAll(sql, params) });
});

// GET /api/avales/:id — detalle con productos
app.get('/api/avales/:id', authMiddleware, (req, res) => {
  try {
    const id = Number(req.params.id);
    const aval = queryFirst('SELECT * FROM avales WHERE id = ?', [id]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });

    const productos = queryAll(`
      SELECT ap.*, p.nombre as producto_nombre, p.categoria
      FROM aval_productos ap
      JOIN productos p ON ap.producto_id = p.id
      WHERE ap.aval_id = ?
    `, [id]);

    const ot = queryFirst(`
      SELECT ot.*, c.nombre as cliente_nombre
      FROM ordenes_trabajo ot
      JOIN clientes c ON ot.cliente_id = c.id
      WHERE ot.id = ?
    `, [aval.orden_trabajo_id]);

    const tecnico = queryFirst('SELECT id, nombre FROM usuarios WHERE id = ?', [aval.tecnico_id]);

    res.json({ aval, productos, ot, tecnico });
  } catch (e) {
    console.error('Error getting aval:', e);
    res.status(500).json({ error: 'Error al obtener aval' });
  }
});

// POST /api/avales — técnico entrega aval
app.post('/api/avales', authMiddleware, async (req, res) => {
  try {
    const body = req.body;

    // Validate
    if (!body.orden_trabajo_id) {
      return res.status(400).json({ error: 'orden_trabajo_id requerido' });
    }
    if (!body.cliente_nombre) {
      return res.status(400).json({ error: 'cliente_nombre requerido' });
    }

    const ot = queryFirst('SELECT * FROM ordenes_trabajo WHERE id = ?', [body.orden_trabajo_id]);
    if (!ot) return res.status(404).json({ error: 'OT no encontrada' });

    // Solo técnico asignado puede entregar aval
    if (req.user.rol === 'tecnico' && ot.tecnico_id !== req.user.userId) {
      return res.status(403).json({ error: 'No eres el técnico asignado a esta OT' });
    }

    if (ot.rol === 'admin' && ot.tecnico_id !== req.user.userId && req.user.rol === 'tecnico') {
      return res.status(403).json({ error: 'No eres el técnico asignado a esta OT' });
    }

    // OT must be en_curso
    if (ot.estado !== 'en_curso') {
      return res.status(400).json({ error: 'La OT debe estar en curso para entregar aval', estado_actual: ot.estado, ot_id: ot.id, ot_numero: ot.numero_ot });
    }

    // Check no existing aval
    const existingAval = queryFirst('SELECT id FROM avales WHERE orden_trabajo_id = ?', [body.orden_trabajo_id]);
    if (existingAval) {
      return res.status(400).json({ error: 'Esta OT ya tiene un aval registrado' });
    }

    const tecnicoId = body.tecnico_id || req.user.userId;

    // Generar número de aval: AV-OT-{OTnumero}
    const numeroAval = 'AV-' + ot.numero_ot;

    // Generar token público único
    const crypto = require('crypto');
    const tokenPublico = crypto.randomBytes(16).toString('hex');

    // Guardar productos como JSON para auditoría
    const productosTecnico = JSON.stringify(body.productos || []);

    // Nuevos campos v2
    const trabajoCompletado = body.trabajo_completado !== undefined ? (body.trabajo_completado ? 1 : 0) : 1;
    const detalleTrabajoReal = body.detalle_trabajo_real || null;

    transaction(() => {
      const avalId = queryFirst(`
        INSERT INTO avales (orden_trabajo_id, tecnico_id, numero_aval, token_publico, cliente_nombre, cliente_contacto, cliente_cedula,
          cliente_telefono, cliente_email, observaciones, productos_tecnico, estado, trabajo_completado, detalle_trabajo_real)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)
        RETURNING id
      `, [
        body.orden_trabajo_id, tecnicoId, numeroAval, tokenPublico, body.cliente_nombre, body.cliente_contacto || null,
        body.cliente_cedula || null, body.cliente_telefono || null, body.cliente_email || null,
        body.observaciones || null, productosTecnico, trabajoCompletado, detalleTrabajoReal
      ]);

      // Insert individual product records
      if (body.productos && Array.isArray(body.productos)) {
        for (const p of body.productos) {
          run('INSERT INTO aval_productos (aval_id, producto_id, cantidad_reportada, comentario) VALUES (?, ?, ?, ?)',
            [avalId.id, p.producto_id, p.cantidad || 0, p.comentario || null]);
        }
      }

      // Cambiar estado de OT a aval_entregado
      run("UPDATE ordenes_trabajo SET estado='aval_entregado', actualizado_en=datetime('now', '-04:00') WHERE id=?",
        [body.orden_trabajo_id]);
    });

    res.status(201).json({ message: 'Aval creado correctamente', aval_id: avalId.id, numero_aval: numeroAval, token_publico: tokenPublico });

    // Cosas post-response: backup y notificaciones (no deben romper el flujo)
    setImmediate(() => {
      try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
      if (avalId && avalId.id) {
        enviarNotificacionAval(avalId.id).catch(err => console.error('Notif aval error:', err));
      }
    });
  } catch (e) {
    console.error('Error creating aval de entrega:', e.stack || e.message || e);
    if (!res.headersSent) res.status(500).json({ error: 'Error al registrar aval' });
  }
});

// PUT /api/avales/:id/confirmar — admin confirma aval
app.put('/api/avales/:id/confirmar', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body;

    const aval = queryFirst('SELECT * FROM avales WHERE id = ?', [id]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });
    if (aval.estado !== 'pendiente' && aval.estado !== 'firmado_cliente') {
      return res.status(400).json({ error: 'El aval ya fue confirmado o rechazado' });
    }

    const productosAdmin = JSON.stringify(body.productos || []);

    transaction(() => {
      // Update aval_productos with confirmed quantities
      if (body.productos && Array.isArray(body.productos)) {
        for (const p of body.productos) {
          if (p.producto_id) {
            run('UPDATE aval_productos SET cantidad_confirmada = ?, comentario = COALESCE(?, comentario) WHERE aval_id = ? AND producto_id = ?',
              [p.cantidad_confirmada !== undefined ? p.cantidad_confirmada : null, p.comentario || null, id, p.producto_id]);
          }
        }
      }

      // Update aval — incluir campos v2 (skip_survey)
      const skipSurvey = body.skip_survey ? 1 : 0;
      const skipSurveyPct = body.skip_survey_pct !== undefined ? body.skip_survey_pct : null;
      const skipSurveyMotivo = body.skip_survey_motivo || null;

      run(`UPDATE avales SET estado='confirmado', fecha_confirmacion_admin=datetime('now', '-04:00'),
        confirmado_por=?, productos_admin=?, skip_survey=?, skip_survey_pct=?, skip_survey_motivo=? WHERE id=?`,
        [req.user.userId, productosAdmin, skipSurvey, skipSurveyPct, skipSurveyMotivo, id]);

      // Change OT to completada
      run("UPDATE ordenes_trabajo SET estado='completada', fecha_fin=datetime('now', '-04:00'), actualizado_en=datetime('now', '-04:00') WHERE id=?",
        [aval.orden_trabajo_id]);

      // Crear encuesta automática SOLO si no es skip_survey
      if (!skipSurvey) {
        const hoy = new Date().toISOString().split('T')[0];
        const fechaLimite = sumarDiasHabiles(hoy, 3);
        const tokenEnc = generarTokenEncuesta();
        const numeroEncuesta = 'ENC-OT-' + ot.numero_ot;
        // Asegurar columna numero_encuesta
        try { run("ALTER TABLE encuestas_satisfaccion ADD COLUMN numero_encuesta TEXT"); } catch(e) {}
        run(`INSERT INTO encuestas_satisfaccion (orden_trabajo_id, aval_id, estado, fecha_limite, realizada_por, token_publico, numero_encuesta)
          VALUES (?, ?, 'pendiente', ?, ?, ?, ?)`,
          [aval.orden_trabajo_id, id, fechaLimite, req.user.userId, tokenEnc, numeroEncuesta]);
      }
    });

    const encuestaId = !skipSurvey ? queryFirst('SELECT id FROM encuestas_satisfaccion WHERE orden_trabajo_id = ? AND aval_id = ?', [aval.orden_trabajo_id, id])?.id : null;

    res.json({
      message: skipSurvey ? 'Aval confirmado sin encuesta (conformidad verbal). OT completada.' : 'Aval confirmado. OT marcada como completada.',
      pendingSurvey: !skipSurvey,
      skipSurvey: !!skipSurvey,
      skipSurveyPct: skipSurveyPct,
      encuestaId: encuestaId,
      fechaLimite: encuestaId ? queryFirst('SELECT fecha_limite FROM encuestas_satisfaccion WHERE id = ?', [encuestaId])?.fecha_limite : null
    });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error confirmando aval:', e);
    res.status(500).json({ error: 'Error al confirmar aval' });
  }
});

// PUT /api/avales/:id/rechazar — admin rechaza aval por calidad
app.put('/api/avales/:id/rechazar', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body;
    const aval = queryFirst('SELECT * FROM avales WHERE id = ?', [id]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });
    if (aval.estado !== 'pendiente' && aval.estado !== 'firmado_cliente') {
      return res.status(400).json({ error: 'El aval no puede ser rechazado en su estado actual' });
    }

    const motivoRechazo = body.motivo || 'Calidad del servicio insuficiente';

    transaction(() => {
      // Guardar historial de reconsideración si ya hay uno
      var historialReconsideracion = [];
      try {
        if (aval.historial_reconsideracion) historialReconsideracion = JSON.parse(aval.historial_reconsideracion);
        if (!Array.isArray(historialReconsideracion)) historialReconsideracion = [];
      } catch(e) { historialReconsideracion = []; }

      historialReconsideracion.push({
        tipo: 'rechazo_calidad',
        motivo: motivoRechazo,
        rechazado_por: req.user.userId,
        fecha: new Date().toISOString()
      });

      run(`UPDATE avales SET estado='rechazado_calidad',
        historial_reconsideracion=?, confirmado_por=?, fecha_confirmacion_admin=datetime('now', '-04:00')
        WHERE id=?`,
        [JSON.stringify(historialReconsideracion), req.user.userId, id]);

      // OT pasa a en_revision (alerta ROJA)
      run("UPDATE ordenes_trabajo SET estado='en_revision', actualizado_en=datetime('now', '-04:00') WHERE id=?",
        [aval.orden_trabajo_id]);
    });

    res.json({ message: 'Aval rechazado por calidad. OT en revisión (alerta ROJA).', estado_aval: 'rechazado_calidad', estado_ot: 'en_revision' });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error rechazando aval:', e);
    res.status(500).json({ error: 'Error al rechazar aval' });
  }
});

// PUT /api/avales/:id/subir-firma — admin sube foto de firma fisica
const avalUpload = multer({
  dest: path.join(__dirname, '..', 'public', 'uploads', 'avales', 'firmas'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo imágenes'), false);
    }
  }
});
app.put('/api/avales/:id/subir-firma', authMiddleware, adminOnly, avalUpload.single('firma'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const aval = queryFirst('SELECT * FROM avales WHERE id = ?', [id]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });
    if (aval.estado === 'confirmado' || aval.estado === 'rechazado') {
      return res.status(400).json({ error: 'Aval ya procesado' });
    }
    if (!req.file) return res.status(400).json({ error: 'Archivo de firma requerido' });

    const ext = path.extname(req.file.originalname) || '.png';
    const firmaDir = path.join(__dirname, '..', 'public', 'uploads', 'avales', 'firmas');
    if (!fs.existsSync(firmaDir)) fs.mkdirSync(firmaDir, { recursive: true });
    const filename = 'firma_' + id + ext;
    const destPath = path.join(firmaDir, filename);
    fs.renameSync(req.file.path, destPath);
    const firmaUrl = '/uploads/avales/firmas/' + filename;

    run(`UPDATE avales SET firma_cliente_data=?, estado='firmado_cliente', fecha_firma_cliente=datetime('now', '-04:00') WHERE id=?`,
      [JSON.stringify({ tipo: 'foto', url: firmaUrl }), id]);

    res.json({ message: 'Firma subida correctamente', firma_url: firmaUrl });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error subiendo firma:', e);
    res.status(500).json({ error: 'Error al subir firma' });
  }
});

// PUT /api/avales/:id/reconsiderar — admin/líder aprueba reconsideración
app.put('/api/avales/:id/reconsiderar', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    const aval = queryFirst('SELECT * FROM avales WHERE id = ?', [id]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });
    if (aval.estado !== 'rechazado_calidad') {
      return res.status(400).json({ error: 'Solo avales rechazados por calidad pueden ser reconsiderados' });
    }

    var historialReconsideracion = [];
    try {
      if (aval.historial_reconsideracion) historialReconsideracion = JSON.parse(aval.historial_reconsideracion);
      if (!Array.isArray(historialReconsideracion)) historialReconsideracion = [];
    } catch(e) { historialReconsideracion = []; }

    historialReconsideracion.push({
      tipo: 'reconsideracion_aprobada',
      resuelto_por: req.user.userId,
      nuevo_motivo: req.body.nuevo_motivo || 'Correcciones realizadas',
      fecha: new Date().toISOString()
    });

    transaction(() => {
      run(`UPDATE avales SET estado='pendiente',
        historial_reconsideracion=?, fecha_confirmacion_admin=NULL, confirmado_por=NULL
        WHERE id=?`,
        [JSON.stringify(historialReconsideracion), id]);

      // OT vuelve a aval_entregado
      run("UPDATE ordenes_trabajo SET estado='aval_entregado', actualizado_en=datetime('now', '-04:00') WHERE id=?",
        [aval.orden_trabajo_id]);
    });

    res.json({ message: 'Aval reconsiderado. OT vuelve a aval_entregado.', estado: 'pendiente' });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error reconsiderando aval:', e);
    res.status(500).json({ error: 'Error al reconsiderar aval' });
  }
});

// PUT /api/avales/:id/reabrir — admin reabre OT completada
app.put('/api/avales/:id/reabrir', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    const aval = queryFirst('SELECT * FROM avales WHERE id = ?', [id]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });
    if (aval.estado !== 'confirmado') {
      return res.status(400).json({ error: 'Solo avales confirmados pueden ser reabiertos' });
    }

    // Verificar que no tenga encuesta completada
    const encuestaExistente = queryFirst("SELECT id, estado FROM encuestas_satisfaccion WHERE aval_id = ? AND estado = 'completada'", [id]);
    if (encuestaExistente) {
      return res.status(400).json({ error: 'Esta OT ya tiene encuesta completada. Debes crear una nueva OT de garantía.' });
    }

    transaction(() => {
      // Marcar aval como reemplazado
      run(`UPDATE avales SET estado='reemplazado', reapertura_penalizado=1 WHERE id=?`, [id]);

      // OT vuelve a en_curso
      run("UPDATE ordenes_trabajo SET estado='en_curso', fecha_fin=NULL, actualizado_en=datetime('now', '-04:00') WHERE id=?",
        [aval.orden_trabajo_id]);
    });

    res.json({ message: 'OT reabierta con penalidad del 50%. Crea un nuevo aval al completar.', reapertura_penalizado: true });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error reabriendo OT:', e);
    res.status(500).json({ error: 'Error al reabrir OT' });
  }
});

// GET /api/avales/:id/pdf — genera PDF (PDFKit) o HTML para imprimir
app.get('/api/avales/:id/pdf', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const aval = queryFirst(`
      SELECT a.*, ot.numero_ot, ot.descripcion, u.nombre as tecnico_nombre
      FROM avales a
      JOIN ordenes_trabajo ot ON a.orden_trabajo_id = ot.id
      LEFT JOIN usuarios u ON a.tecnico_id = u.id
      WHERE a.id = ?
    `, [id]);

    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });

    const productos = queryAll(`
      SELECT ap.*, p.nombre as producto_nombre
      FROM aval_productos ap
      JOIN productos p ON ap.producto_id = p.id
      WHERE ap.aval_id = ?
    `, [id]);

    // HTML mode (legacy)
    if (req.query.html === 'true') {
      const prodRows = productos.map(p => `
      <tr>
        <td style="border:1px solid #ddd;padding:8px">${p.producto_nombre}</td>
        <td style="border:1px solid #ddd;padding:8px;text-align:center">${p.cantidad_reportada}</td>
        <td style="border:1px solid #ddd;padding:8px;text-align:center">${p.cantidad_confirmada !== null ? p.cantidad_confirmada : '-'}</td>
        <td style="border:1px solid #ddd;padding:8px">${p.comentario || ''}</td>
      </tr>
    `).join('');

      const estadoLabel = aval.estado === 'confirmado' ? '✅ CONFIRMADO' : aval.estado === 'rechazado' ? '❌ RECHAZADO' : '⏳ PENDIENTE';

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Aval #${id}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 20px; }
  .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #2563eb; padding-bottom: 15px; }
  .header h1 { color: #2563eb; margin: 0; font-size: 24px; }
  .header h2 { color: #666; margin: 5px 0 0; font-size: 16px; font-weight: normal; }
  .section { margin-bottom: 20px; }
  .section h3 { background: #f3f4f6; padding: 8px 12px; margin: 0 0 10px; font-size: 14px; color: #374151; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #2563eb; color: white; padding: 10px; text-align: left; font-size: 13px; }
  td { padding: 8px; border-bottom: 1px solid #eee; }
  .label { font-weight: bold; color: #374151; width: 200px; }
  .status { font-size: 18px; font-weight: bold; text-align: center; padding: 15px; border: 2px solid #2563eb; border-radius: 8px; margin: 20px 0; }
  .footer { text-align: center; color: #999; font-size: 12px; margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px; }
  @media print { body { margin: 0; } }
</style></head><body>
<div class="header">
  <h1>AVAL DE INSTALACION</h1>
  <h2>OT: ${aval.numero_ot}</h2>
</div>
<div class="status">${estadoLabel}</div>
<div class="section">
  <h3>DATOS DEL CLIENTE</h3>
  <table><tr><td class="label">Nombre:</td><td>${aval.cliente_nombre}</td></tr>
  <tr><td class="label">Contacto:</td><td>${aval.cliente_contacto || '-'}</td></tr>
  <tr><td class="label">Cedula:</td><td>${aval.cliente_cedula || '-'}</td></tr>
  <tr><td class="label">Telefono:</td><td>${aval.cliente_telefono || '-'}</td></tr>
  <tr><td class="label">Email:</td><td>${aval.cliente_email || '-'}</td></tr></table>
</div>
<div class="section">
  <h3>TECNICO ASIGNADO</h3>
  <p>${aval.tecnico_nombre}</p>
</div>
<div class="section">
  <h3>PRODUCTOS INSTALADOS</h3>
  <table><thead><tr><th>Producto</th><th>Cant. Reportada</th><th>Cant. Confirmada</th><th>Comentario</th></tr></thead>
  <tbody>${prodRows}</tbody></table>
</div>
${aval.observaciones ? '<div class="section"><h3>OBSERVACIONES</h3><p>' + aval.observaciones + '</p></div>' : ''}
<div class="section">
  <h3>FECHAS</h3>
  <table><tr><td class="label">Fecha Entrega Tecnico:</td><td>${aval.fecha_entrega_tecnico}</td></tr>
  ${aval.fecha_confirmacion_admin ? '<tr><td class="label">Fecha Confirmacion Admin:</td><td>' + aval.fecha_confirmacion_admin + '</td></tr>' : ''}</table>
</div>
${aval.firma_cliente_data ? '<div class="section"><h3>FIRMA DEL CLIENTE</h3><p>' + aval.cliente_nombre + '</p></div>' : ''}
<div class="footer">Documento generado por OT Dashboard - ${new Date().toLocaleDateString('es-DO')}</div>
</body></html>`;

      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }

    // --- PDF nativo con PDFKit ---
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: {
      Title: 'Aval ' + aval.numero_aval,
      Author: 'OT Dashboard'
    }});

    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => {
      const pdfData = Buffer.concat(buffers);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="aval-' + aval.numero_aval + '.pdf"');
      res.send(pdfData);
    });

    const lm = 50;
    const pw = doc.page.width - 100;
    const blue = '#2563eb';

    doc.rect(0, 0, doc.page.width, 120).fill(blue);
    doc.fillColor('#ffffff').fontSize(24).font('Helvetica-Bold').text('AVAL DE SERVICIO', lm, 30, { align: 'center' })
      .fontSize(11).font('Helvetica').text('OT: ' + (aval.numero_ot || ''), lm, 65, { align: 'center' })
      .fontSize(10).text('Aval: ' + (aval.numero_aval || '#'), lm, 90, { align: 'center' });

    let y = 145;

    // Cliente
    doc.fillColor('#1f2937').fontSize(14).font('Helvetica-Bold').text('DATOS DEL CLIENTE', lm, y);
    y += 25;

    function df(label, value, x, yp, w) {
      doc.fillColor('#6b7280').fontSize(9).font('Helvetica').text(label, x, yp);
      doc.fillColor('#1f2937').fontSize(10).font('Helvetica').text(value || '-', x + (label.length > 8 ? 90 : 60), yp, { width: w || 200 });
    }
    df('Nombre:', aval.cliente_nombre, lm, y, 200);
    df('Contacto:', aval.cliente_contacto, lm + 280, y, 150);
    y += 18;
    df('Cedula:', aval.cliente_cedula, lm, y, 200);
    df('Telefono:', aval.cliente_telefono, lm + 280, y, 150);
    y += 18;
    df('Email:', aval.cliente_email, lm, y, 400);
    y += 35;

    // Tecnico
    doc.fillColor('#1f2937').fontSize(14).font('Helvetica-Bold').text('TECNICO ASIGNADO', lm, y);
    y += 22;
    doc.fillColor('#374151').fontSize(10).font('Helvetica').text(aval.tecnico_nombre || '', lm, y);
    y += 30;

    // Productos
    doc.fillColor('#1f2937').fontSize(14).font('Helvetica-Bold').text('PRODUCTOS INSTALADOS', lm, y);
    y += 25;

    doc.rect(lm, y, pw, 20).fill(blue);
    doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
    doc.text('Producto', lm + 5, y + 5);
    doc.text('Cant.', lm + 250, y + 5, { width: 40, align: 'center' });
    doc.text('Conf.', lm + 295, y + 5, { width: 40, align: 'center' });
    doc.text('Comentario', lm + 340, y + 5);
    y += 20;

    productos.forEach((p, i) => {
      if (y > 710) { doc.addPage(); y = 50; }
      if (i % 2 === 0) doc.rect(lm, y, pw, 18).fill('#f9fafb');
      doc.fillColor('#374151').fontSize(9).font('Helvetica');
      doc.text(p.producto_nombre, lm + 5, y + 4);
      doc.text(String(p.cantidad_reportada), lm + 250, y + 4, { width: 40, align: 'center' });
      doc.text(p.cantidad_confirmada !== null ? String(p.cantidad_confirmada) : '-', lm + 295, y + 4, { width: 40, align: 'center' });
      doc.text(p.comentario || '', lm + 340, y + 4, { width: 200 });
      y += 18;
    });

    y += 20;

    if (aval.observaciones) {
      if (y > 660) { doc.addPage(); y = 50; }
      doc.fillColor('#1f2937').fontSize(14).font('Helvetica-Bold').text('OBSERVACIONES', lm, y);
      y += 22;
      doc.fillColor('#374151').fontSize(10).font('Helvetica').text(aval.observaciones, lm, y, { width: pw });
      y += doc.y - y + 15;
    }

    if (y > 620) { doc.addPage(); y = 50; }
    doc.fillColor('#1f2937').fontSize(14).font('Helvetica-Bold').text('FECHAS', lm, y);
    y += 22;
    df('Entrega:', aval.fecha_entrega_tecnico, lm, y, pw);
    y += 18;
    if (aval.fecha_confirmacion_admin) { df('Confirmacion:', aval.fecha_confirmacion_admin, lm, y, pw); y += 18; }
    if (aval.fecha_firma_cliente) { df('Firma Cliente:', aval.fecha_firma_cliente, lm, y, pw); y += 18; }

    y = Math.max(y + 30, 580);
    doc.moveTo(lm, y).lineTo(lm + pw, y).strokeColor('#d1d5db').stroke();
    y += 25;
    doc.fillColor('#1f2937').fontSize(12).font('Helvetica-Bold').text('ACEPTACION DEL SERVICIO', lm, y, { align: 'center' });
    y += 20;
    doc.fillColor('#6b7280').fontSize(9).font('Helvetica').text('Declaro haber recibido el servicio descrito, a mi entera satisfaccion.', lm, y, { width: pw, align: 'center' });
    y += 40;

    doc.moveTo(lm, y).lineTo(lm + 200, y).strokeColor('#374151').stroke();
    doc.fillColor('#1f2937').fontSize(10).font('Helvetica-Bold').text('Firma del Cliente', lm, y + 5);
    doc.fillColor('#6b7280').fontSize(8).font('Helvetica').text(aval.cliente_nombre || '', lm, y + 18);

    doc.moveTo(lm + 300, y).lineTo(lm + 500, y).strokeColor('#374151').stroke();
    doc.fillColor('#1f2937').fontSize(10).font('Helvetica-Bold').text('Firma del Tecnico', lm + 300, y + 5);
    doc.fillColor('#6b7280').fontSize(8).font('Helvetica').text(aval.tecnico_nombre || '', lm + 300, y + 18);

    y += 45;
    const et = aval.estado === 'confirmado' ? 'ESTADO: CONFIRMADO' : aval.estado === 'rechazado' ? 'ESTADO: RECHAZADO' : 'ESTADO: ' + aval.estado.toUpperCase();
    doc.rect(lm, y, pw, 22).fill(aval.estado === 'confirmado' ? '#16a34a' : aval.estado === 'rechazado' ? '#dc2626' : '#f59e0b');
    doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold').text(et, lm, y + 5, { align: 'center' });

    const fy = doc.page.height - 50;
    doc.rect(0, fy, doc.page.width, 50).fill(blue);
    doc.fillColor('#ffffff').fontSize(8).font('Helvetica').text('Documento generado electronicamente', lm, fy + 10, { align: 'center' });
    doc.fontSize(7).text('Aval: ' + (aval.numero_aval || '') + ' | OT: ' + (aval.numero_ot || ''), lm, fy + 25, { align: 'center' });
    doc.fontSize(7).text('Generado: ' + new Date().toLocaleString('es-DO'), lm, fy + 38, { align: 'center' });

    doc.end();
  } catch (e) {
    console.error('Error generating aval PDF:', e);
    res.status(500).json({ error: 'Error al generar PDF' });
  }
});
// ==================== API: AVALES (legacy - existing flow) ====================
app.get('/api/avales-legacy', authMiddleware, (req, res) => {
  const otId = req.query.orden_trabajo_id;
  let sql = `
    SELECT a.*, ot.numero_ot, c.nombre as cliente_nombre
    FROM avales_legacy a
    JOIN ordenes_trabajo ot ON a.orden_trabajo_id = ot.id
    JOIN clientes c ON ot.cliente_id = c.id
    WHERE 1=1
  `;
  const params = [];
  if (otId) { sql += ' AND a.orden_trabajo_id = ?'; params.push(Number(otId)); }
  if (req.user.rol === 'tecnico') { sql += ' AND ot.tecnico_id = ?'; params.push(req.user.userId); }
  sql += ' ORDER BY a.creado_en DESC';

  const avales = queryAll(sql, params) || [];
  // Forzar estado a pendiente para pruebas
  const corregidos = avales.map(a => ({ ...a, estado: 'pendiente' }));

  res.json({ avales: corregidos });
});

app.post('/api/avales-legacy', authMiddleware, adminOnly, async (req, res) => {
  try {
    const body = req.body;
    const ot = queryFirst(
      `SELECT ot.*, c.nombre as cliente_nombre, c.telefono, c.direccion, c.cedula_rnc, c.tipo as tipo_cliente
       FROM ordenes_trabajo ot JOIN clientes c ON ot.cliente_id = c.id WHERE ot.id = ?`,
      [body.orden_trabajo_id]);
    if (!ot) return res.status(404).json({ error: 'OT no encontrada' });

    const numAval = 'AV-' + ot.numero_ot;

    const pdfBuffer = await generarAvalPDF({
      numero_aval: numAval, numero_ot: ot.numero_ot, cliente: ot.cliente_nombre,
      telefono: ot.telefono, direccion: ot.direccion, cedula_rnc: ot.cedula_rnc,
      tipo_cliente: ot.tipo_cliente, descripcion_trabajo: body.descripcion_trabajo || ot.descripcion || '',
      materiales: body.materiales || '', costo_total: body.costo_total ?? ot.monto_total ?? 0,
      forma_pago: body.forma_pago || '', garantia: body.garantia || '',
      observaciones: body.observaciones || '', fecha: new Date().toLocaleDateString('es-DO'),
    });

    const pdfDir = path.join(__dirname, '..', 'public', 'uploads', 'avales');
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
    const pdfFilename = `${numAval}.pdf`;
    fs.writeFileSync(path.join(pdfDir, pdfFilename), pdfBuffer);

    run(`INSERT INTO avales_legacy (orden_trabajo_id, numero_aval, descripcion_trabajo, materiales, costo_total,
      forma_pago, garantia, observaciones, estado, archivo_pdf_generado)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`,
      [body.orden_trabajo_id, numAval, body.descripcion_trabajo || ot.descripcion, body.materiales || null,
       body.costo_total ?? ot.monto_total ?? 0, body.forma_pago || null, body.garantia || null,
       body.observaciones || null, `/uploads/avales/${pdfFilename}`]);

    // Copiar productos al aval
    const avalReg = queryFirst('SELECT id FROM avales_legacy WHERE numero_aval = ?', [numAval]);
    if (avalReg && body.productos) {
      for (const p of body.productos) {
        run('INSERT INTO aval_productos (aval_id, producto_id, cantidad_reportada, cantidad_confirmada) VALUES (?, ?, ?, ?)',
          [avalReg.id, p.producto_id, p.cantidad_ot || 0, p.cantidad || 0]);
      }
    } else if (avalReg) {
      // Si no viene productos en body, copiar de la OT
      const prodOT = queryAll('SELECT producto_id, cantidad FROM orden_trabajo_productos WHERE orden_trabajo_id = ?', [body.orden_trabajo_id]);
      for (const p of prodOT) {
        run('INSERT INTO aval_productos (aval_id, producto_id, cantidad_reportada, cantidad_confirmada) VALUES (?, ?, ?, ?)',
          [avalReg.id, p.producto_id, p.cantidad, p.cantidad]);
      }
}

    // Enviar email al técnico
    const tecnico = ot.tecnico_id ? queryFirst('SELECT * FROM usuarios WHERE id = ?', [ot.tecnico_id]) : null;
    if (tecnico && tecnico.email) {
      const dashboardUrl = process.env.DASHBOARD_URL || `http://localhost:${PORT}`;
      const emailResult = await enviarEmail({
        to: tecnico.email,
        subject: `Nuevo Aval de Servicio - ${numAval}`,
        html: `<h2>Nuevo Aval de Servicio</h2>
          <p>Hola <strong>${tecnico.nombre}</strong>,</p>
          <p>Se ha generado un nuevo Aval para la OT <strong>${ot.numero_ot}</strong>.</p>
          <p><strong>Cliente:</strong> ${ot.cliente_nombre}<br><strong>Aval:</strong> ${numAval}</p>
          <p><a href="${dashboardUrl}/" style="background:#2563eb;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;">Ver en Dashboard</a></p>`,
        attachments: [{ filename: pdfFilename, content: pdfBuffer, contentType: 'application/pdf' }],
      });

      if (emailResult.success) {
        run("UPDATE avales_legacy SET estado='enviado', fecha_envio_tecnico=datetime('now', '-04:00') WHERE numero_aval=?", [numAval]);
      }
    }

    res.status(201).json({ numero_aval: numAval, pdf_url: `/uploads/avales/${pdfFilename}`, message: 'Aval creado' });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error creating aval legacy:', e);
    res.status(500).json({ error: 'Error al crear aval' });
  }
});

// Obtener aval legacy con productos
app.get('/api/avales-legacy/:id', authMiddleware, (req, res) => {
  try {
    const id = Number(req.params.id);
    console.log('DEBUG aval-legacy GET by id=' + id + ' (user=' + req.user.email + ')');
    const aval = queryFirst(
      `SELECT a.*, ot.numero_ot, c.nombre as cliente_nombre,
              c.telefono as cliente_telefono, c.email, c.direccion as cliente_direccion,
              c.cedula_rnc as cliente_cedula
       FROM avales_legacy a
       JOIN ordenes_trabajo ot ON a.orden_trabajo_id = ot.id
       JOIN clientes c ON ot.cliente_id = c.id
       WHERE a.id = ?`, [id]);
    if (!aval) {
      console.error('DEBUG aval-legacy: aval ' + id + ' no encontrado en BD');
      return res.status(404).json({ error: 'Aval no encontrado' });
    }

    const productos = queryAll(
      `SELECT ap.*, p.nombre as producto_nombre, p.categoria, p.codigo_producto
       FROM aval_productos ap
       JOIN productos p ON ap.producto_id = p.id
       WHERE ap.aval_id = ?`, [req.params.id]) || [];

    const ot = queryFirst('SELECT numero_ot, cliente_nombre FROM ordenes_trabajo ot JOIN clientes c ON ot.cliente_id = c.id WHERE ot.id = ?', [aval.orden_trabajo_id]);

    // Forzar estado a pendiente
    aval.estado = 'pendiente';

    res.json({ aval, productos, ot });
  } catch (e) {
    console.error('Error getting aval legacy:', e);
    res.status(500).json({ error: 'Error al obtener aval' });
  }
});

// Confirmar aval 100% (sin cambios)
app.put('/api/avales-legacy/:id/confirmar', authMiddleware, async (req, res) => {
  try {
    const aval = queryFirst('SELECT * FROM avales_legacy WHERE id = ?', [req.params.id]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });

    run("UPDATE avales_legacy SET estado='confirmado', confirmado_en=datetime('now', '-04:00') WHERE id=?", [req.params.id]);

    res.json({ message: 'Aval confirmado al 100%', estado: 'confirmado' });
    try { exportDatabase(); } catch(e) { /* ignore */ }
  } catch (e) {
    console.error('Error confirming aval:', e);
    res.status(500).json({ error: 'Error al confirmar aval' });
  }
});

// Actualizar cantidades de productos y recalcular bono
app.put('/api/avales-legacy/:id/productos', authMiddleware, async (req, res) => {
  try {
    const aval = queryFirst('SELECT * FROM avales_legacy WHERE id = ?', [req.params.id]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });

    const { productos } = req.body;
    if (!Array.isArray(productos) || productos.length === 0) {
      return res.status(400).json({ error: 'Se requiere array de productos' });
    }

    for (const p of productos) {
      run('UPDATE aval_productos SET cantidad_confirmada=? WHERE aval_id=? AND producto_id=?',
        [p.cantidad, req.params.id, p.producto_id]);
      run('UPDATE orden_trabajo_productos SET cantidad=? WHERE orden_trabajo_id=? AND producto_id=?',
        [p.cantidad, aval.orden_trabajo_id, p.producto_id]);
    }

    // Recalcular bono
    const prodOT = queryAll(
      'SELECT otp.cantidad, p.precio_venta as precio FROM orden_trabajo_productos otp JOIN productos p ON otp.producto_id=p.id WHERE otp.orden_trabajo_id=?',
      [aval.orden_trabajo_id]);
    const subtotal = prodOT.reduce((sum, p) => sum + (p.cantidad * (p.precio || 0)), 0);
    const bono = Math.round(subtotal * 0.05);

    run('UPDATE ordenes_trabajo SET bono_tecnico=?, monto_total=?, actualizado_en=datetime("now", "-04:00") WHERE id=?',
      [bono, subtotal, aval.orden_trabajo_id]);

    run("UPDATE avales_legacy SET estado='confirmado', confirmado_en=datetime('now', '-04:00') WHERE id=?", [req.params.id]);

    res.json({ message: 'Productos actualizados y bono recalculado', bono_tecnico: bono, monto_total: subtotal });
    try { exportDatabase(); } catch(e) { /* ignore */ }
  } catch (e) {
    console.error('Error updating productos:', e);
    res.status(500).json({ error: 'Error al actualizar productos' });
  }
});

app.put('/api/avales-legacy', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id, archivo_firmado, respuestas_digitales } = req.body;
    if (!id) return res.status(400).json({ error: 'ID requerido' });

    let pdfPath = null;
    if (archivo_firmado && archivo_firmado.startsWith('data:')) {
      const matches = archivo_firmado.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (matches) {
        const ext = matches[1].includes('pdf') ? '.pdf' : '.jpg';
        const filename = `firmado_${Date.now()}${ext}`;
        const buffer = Buffer.from(matches[2], 'base64');
        const firmadoDir = path.join(__dirname, '..', 'public', 'uploads', 'avales');
        fs.writeFileSync(path.join(firmadoDir, filename), buffer);
        pdfPath = `/uploads/avales/${filename}`;
      }
    }

    run(`UPDATE avales_legacy SET archivo_pdf_firmado=COALESCE(?, archivo_pdf_firmado), respuestas_digitales=?,
      estado='completado', fecha_firma_cliente=datetime('now', '-04:00'),
      fecha_completado=datetime('now', '-04:00'), actualizado_en=datetime('now', '-04:00') WHERE id=?`,
      [pdfPath, respuestas_digitales || '{}', id]);

    res.json({ success: true });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error updating aval legacy:', e);
    res.status(500).json({ error: 'Error al actualizar aval' });
  }
});

// ==================== API: ENCUESTAS ====================
const PONDERACIONES = {
  tiempo_entrega: 1.5,
  desempeno_equipo: 1.5,
  conocimientos_tecnicos: 1.5,
  presentacion_equipo: 1.0,
  calidad_productos: 1.0,
  calidad_entrenamientos: 1.0,
};

function calcPorcentaje(r) {
  let sumaPond = 0, sumaPesos = 0;
  for (const [k, p] of Object.entries(PONDERACIONES)) {
    sumaPond += (r[k] || 3) * p;
    sumaPesos += p;
  }
  sumaPond += (r.satisfaccion_general || 3) * 1.0;
  sumaPesos += 1.0;
  return Math.round((sumaPond / sumaPesos / 5) * 100);
}

app.get('/api/encuestas', authMiddleware, (req, res) => {
  const otId = req.query.orden_trabajo_id;
  const estadoFiltro = req.query.estado;
  let sql = `
    SELECT e.*, ot.numero_ot, c.nombre as cliente_nombre,
      c.telefono as cliente_telefono, c.email as cliente_email,
      a.numero_aval, a.cliente_nombre as aval_cliente_nombre, a.cliente_telefono as aval_cliente_telefono
    FROM encuestas_satisfaccion e
    JOIN ordenes_trabajo ot ON e.orden_trabajo_id = ot.id
    JOIN clientes c ON ot.cliente_id = c.id
    LEFT JOIN avales a ON e.aval_id = a.id
    WHERE 1=1
  `;
  const params = [];
  if (otId) { sql += ' AND e.orden_trabajo_id = ?'; params.push(Number(otId)); }
  if (estadoFiltro) { sql += ' AND e.estado = ?'; params.push(estadoFiltro); }
  sql += ' ORDER BY e.creado_en DESC';

  const encuestas = queryAll(sql, params);
  const ahora = new Date().toISOString().split('T')[0];

  const encuestasConDatos = encuestas.map(e => {
    // Calcular estado dinámico si no se ha respondido
    let estadoCalculado = e.estado;
    if (e.fecha_encuesta) {
      estadoCalculado = 'completada';
    } else if (e.fecha_limite && e.fecha_limite < ahora) {
      estadoCalculado = 'expirada';
    } else {
      estadoCalculado = 'pendiente';
    }

    let dias_restantes = 0;
    if (e.fecha_limite) {
      const lim = new Date(e.fecha_limite + 'T12:00:00-04:00');
      const hoy = new Date();
      const diffTime = lim.getTime() - hoy.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      dias_restantes = diffDays;
    }

    return {
      ...e,
      estado: estadoCalculado,
      dias_restantes: dias_restantes
    };
  });

  res.json({ encuestas: encuestasConDatos });
});

app.post('/api/encuestas', authMiddleware, async (req, res) => {
  try {
    const b = req.body;
    const respuestas = {
      satisfaccion_general: Math.min(5, Math.max(1, b.satisfaccion_general || 3)),
      tiempo_entrega: Math.min(5, Math.max(1, b.tiempo_entrega || 3)),
      desempeno_equipo: Math.min(5, Math.max(1, b.desempeno_equipo || 3)),
      presentacion_equipo: Math.min(5, Math.max(1, b.presentacion_equipo || 3)),
      calidad_productos: Math.min(5, Math.max(1, b.calidad_productos || 3)),
      conocimientos_tecnicos: Math.min(5, Math.max(1, b.conocimientos_tecnicos || 3)),
      calidad_entrenamientos: Math.min(5, Math.max(1, b.calidad_entrenamientos || 3)),
    };
    const pct = calcPorcentaje(respuestas);

    run(`INSERT INTO encuestas_satisfaccion (orden_trabajo_id, aval_legacy_id, satisfaccion_general,
      tiempo_entrega, desempeno_equipo, presentacion_equipo, calidad_productos,
      conocimientos_tecnicos, calidad_entrenamientos, recomendaria, observaciones,
      porcentaje_final, realizada_por, fecha_encuesta, estado)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-04:00'), 'completada')`,
      [b.orden_trabajo_id, b.aval_legacy_id || null, respuestas.satisfaccion_general,
       respuestas.tiempo_entrega, respuestas.desempeno_equipo, respuestas.presentacion_equipo,
       respuestas.calidad_productos, respuestas.conocimientos_tecnicos, respuestas.calidad_entrenamientos,
       b.recomendaria ? 1 : 0, b.observaciones || null, pct, req.user.userId]);

    // Enviar email
    const ot = queryFirst(
      `SELECT ot.*, c.nombre as cliente_nombre, c.email as cliente_email
       FROM ordenes_trabajo ot JOIN clientes c ON ot.cliente_id = c.id WHERE ot.id = ?`,
      [b.orden_trabajo_id]);

    if (ot) {
      const recipients = [];
      if (ot.cliente_email) recipients.push(ot.cliente_email);
      const admin = queryFirst("SELECT email FROM usuarios WHERE rol = 'admin' LIMIT 1");
      if (admin?.email) recipients.push(admin.email);
      const tecnico = ot.tecnico_id ? queryFirst("SELECT email FROM usuarios WHERE id = ?", [ot.tecnico_id]) : null;
      if (tecnico?.email) recipients.push(tecnico.email);
      const sc = queryFirst("SELECT email FROM usuarios WHERE rol = 'servicio_cliente' LIMIT 1");
      if (sc?.email) recipients.push(sc.email);

      if (recipients.length > 0) {
        await enviarEmail({
          to: [...new Set(recipients)], // dedup
          subject: `Encuesta de Satisfacción - OT ${ot.numero_ot} (${pct}%)`,
          html: `<h2>Resultado de Encuesta</h2>
            <p><strong>Cliente:</strong> ${ot.cliente_nombre}</p>
            <p><strong>OT:</strong> ${ot.numero_ot}</p>
            <p><strong>Resultado:</strong> ${pct}% de satisfacción</p>
            <table border="1" cellpadding="8" style="border-collapse:collapse">
              <tr><td>Satisfacción General</td><td>${respuestas.satisfaccion_general}/5</td></tr>
              <tr><td>Tiempo de Entrega (x1.5)</td><td>${respuestas.tiempo_entrega}/5</td></tr>
              <tr><td>Desempeño del Equipo (x1.5)</td><td>${respuestas.desempeno_equipo}/5</td></tr>
              <tr><td>Presentación del Equipo</td><td>${respuestas.presentacion_equipo}/5</td></tr>
              <tr><td>Calidad de Productos</td><td>${respuestas.calidad_productos}/5</td></tr>
              <tr><td>Conocimientos Técnicos (x1.5)</td><td>${respuestas.conocimientos_tecnicos}/5</td></tr>
              <tr><td>Calidad de Entrenamientos</td><td>${respuestas.calidad_entrenamientos}/5</td></tr>
            </table>
            ${b.observaciones ? `<p><strong>Observaciones:</strong> ${b.observaciones}</p>` : ''}`,
        });
      }
    }

    res.status(201).json({ porcentaje_final: pct, message: 'Encuesta registrada' });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error creating encuesta:', e);
    res.status(500).json({ error: 'Error al registrar encuesta' });
  }
});

// ═══════════════════════════════════════════════
// ENDPOINT: Contactar encuesta expirada
// ═══════════════════════════════════════════════
app.put('/api/encuestas/:id/contactar', authMiddleware, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { tipo, notas } = req.body || {};

    const encuesta = queryFirst('SELECT * FROM encuestas_satisfaccion WHERE id = ?', [id]);
    if (!encuesta) return res.status(404).json({ error: 'Encuesta no encontrada' });

    // Registrar intento de contacto en tabla contactos_encuesta
    run('INSERT INTO contactos_encuesta (encuesta_id, contacto_por, tipo, notas) VALUES (?, ?, ?, ?)',
      [id, req.user.userId, tipo || 'telefono', notas || null]);

    // Incrementar intentos
    const nuevosIntentos = (encuesta.intentos || 0) + 1;

    // Determinar estado según intentos
    const ahora = new Date().toISOString().split('T')[0];
    let nuevoEstado = encuesta.estado;
    if (encuesta.fecha_limite && encuesta.fecha_limite < ahora) {
      nuevoEstado = 'expirada';
    } else if (nuevosIntentos >= 3 && encuesta.estado === 'pendiente') {
      // Después de 3 intentos sin éxito, pasa a admin para cierre
      nuevoEstado = 'pendiente_admin';
    }

    run(`UPDATE encuestas_satisfaccion SET
      contactado_por = ?,
      fecha_contacto = datetime('now', '-04:00'),
      notas_contacto = COALESCE(?, notas_contacto),
      intentos = ?,
      estado = ?
      WHERE id = ?`,
      [req.user.userId, notas || null, nuevosIntentos, nuevoEstado, id]);

    res.json({ message: 'Contacto registrado', intentos: nuevosIntentos, estado: nuevoEstado });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error contactando encuesta:', e);
    res.status(500).json({ error: 'Error al registrar contacto' });
  }
});

// GET /api/encuestas/:id/contactos — historial de contactos
app.get('/api/encuestas/:id/contactos', authMiddleware, (req, res) => {
  try {
    const contactos = queryAll(`
      SELECT c.*, u.nombre as contacto_por_nombre
      FROM contactos_encuesta c
      LEFT JOIN usuarios u ON u.id = c.contacto_por
      WHERE c.encuesta_id = ?
      ORDER BY c.creado_en DESC
    `, [Number(req.params.id)]);
    res.json({ contactos });
  } catch (e) {
    console.error('Error cargando contactos:', e);
    res.status(500).json({ error: 'Error al cargar contactos' });
  }
});

// PUT /api/encuestas/:id/enviar-link — marcar que se envió link al cliente
app.put('/api/encuestas/:id/enviar-link', authMiddleware, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { metodo } = req.body || {};

    run('UPDATE encuestas_satisfaccion SET email_enviado = 1 WHERE id = ?', [id]);

    // También registrar como contacto
    run('INSERT INTO contactos_encuesta (encuesta_id, contacto_por, tipo, notas) VALUES (?, ?, ?, ?)',
      [id, req.user.userId, metodo || 'whatsapp', 'Link público enviado al cliente']);

    res.json({ message: 'Link enviado' });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error enviando link:', e);
    res.status(500).json({ error: 'Error al enviar link' });
  }
});

// PUT /api/encuestas/:id/llenar-telefono — llenar encuesta telefónicamente
app.put('/api/encuestas/:id/llenar-telefono', authMiddleware, (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body;

    const encuesta = queryFirst('SELECT * FROM encuestas_satisfaccion WHERE id = ?', [id]);
    if (!encuesta) return res.status(404).json({ error: 'Encuesta no encontrada' });

    // Calcular porcentaje final ponderado
    const config = queryFirst('SELECT * FROM configuracion_incentivos WHERE id = 1') || {};
    const ponderaciones = {
      ponderacion_tiempo_entrega: config.ponderacion_tiempo_entrega || 25,
      ponderacion_desempeno: config.ponderacion_desempeno || 20,
      ponderacion_presentacion: config.ponderacion_presentacion || 15,
      ponderacion_calidad_productos: config.ponderacion_calidad_productos || 20,
      ponderacion_calidad_entrenamientos: config.ponderacion_calidad_entrenamientos || 20
    };

    const sumPond = Object.values(ponderaciones).reduce((a, b) => a + b, 0) || 100;
    const pct = (
      (Number(body.satisfaccion_general) || 5) * config.ponderacion_satisfaccion_general ||
      (Number(body.tiempo_entrega) || 5) * ponderaciones.ponderacion_tiempo_entrega +
      (Number(body.desempeno_equipo) || 5) * ponderaciones.ponderacion_desempeno +
      (Number(body.presentacion_equipo) || 5) * ponderaciones.ponderacion_presentacion +
      (Number(body.calidad_productos) || 5) * ponderaciones.ponderacion_calidad_productos +
      (Number(body.calidad_entrenamientos) || 5) * ponderaciones.ponderacion_calidad_entrenamientos
    ) / sumPond;

    run(`UPDATE encuestas_satisfaccion SET
      satisfaccion_general = ?, tiempo_entrega = ?, desempeno_equipo = ?,
      presentacion_equipo = ?, calidad_productos = ?, conocimientos_tecnicos = ?,
      calidad_entrenamientos = ?, recomendaria = ?, observaciones = ?,
      porcentaje_final = ?, realizada_por = ?, fecha_encuesta = datetime('now', '-04:00'),
      respuestas_data = ?, estado = 'completada'
      WHERE id = ?`,
      [
        Number(body.satisfaccion_general) || null,
        Number(body.tiempo_entrega) || null,
        Number(body.desempeno_equipo) || null,
        Number(body.presentacion_equipo) || null,
        Number(body.calidad_productos) || null,
        Number(body.conocimientos_tecnicos) || null,
        Number(body.calidad_entrenamientos) || null,
        Number(body.recomendaria) || null,
        body.observaciones || null,
        Math.round(pct * 100) / 100,
        req.user.userId,
        body.respuestas_data || null,
        id
      ]);

    res.json({ message: 'Encuesta completada telefónicamente', porcentaje_final: Math.round(pct * 100) / 100 });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error llenando encuesta telefónica:', e);
    res.status(500).json({ error: 'Error al llenar encuesta' });
  }
});

// GET /api/encuestas/reportes — stats y promedios
app.get('/api/encuestas/reportes', authMiddleware, (req, res) => {
  try {
    const now = new Date();
    const year = req.query.year || now.getFullYear();
    const month = req.query.month || now.getMonth() + 1;
    const periodo = year + '-' + String(month).padStart(2, '0');

    // Stats generales
    const total = queryFirst('SELECT COUNT(*) as total FROM encuestas_satisfaccion');
    const completadas = queryFirst("SELECT COUNT(*) as total FROM encuestas_satisfaccion WHERE estado = 'completada'");
    const pendientes = queryFirst("SELECT COUNT(*) as total FROM encuestas_satisfaccion WHERE estado IN ('pendiente','pendiente_admin')");
    const expiradas = queryFirst("SELECT COUNT(*) as total FROM encuestas_satisfaccion WHERE estado = 'expirada'");

    // Promedio general (solo completadas)
    const promedios = queryFirst(`
      SELECT
        AVG(satisfaccion_general) as prom_satisfaccion,
        AVG(tiempo_entrega) as prom_tiempo_entrega,
        AVG(desempeno_equipo) as prom_desempeno,
        AVG(presentacion_equipo) as prom_presentacion,
        AVG(calidad_productos) as prom_calidad_productos,
        AVG(calidad_entrenamientos) as prom_calidad_entrenamientos,
        AVG(porcentaje_final) as prom_porcentaje
      FROM encuestas_satisfaccion WHERE estado = 'completada'
    `);

    // Por periodo
    const porPeriodo = queryAll(`
      SELECT
        strftime('%Y-%m', fecha_encuesta) as periodo,
        COUNT(*) as total,
        AVG(porcentaje_final) as prom_porcentaje
      FROM encuestas_satisfaccion
      WHERE estado = 'completada' AND fecha_encuesta IS NOT NULL
      GROUP BY periodo
      ORDER BY periodo DESC
      LIMIT 12
    `);

    res.json({
      totals: { total: total?.total || 0, completadas: completadas?.total || 0, pendientes: pendientes?.total || 0, expiradas: expiradas?.total || 0 },
      promedios,
      porPeriodo
    });
  } catch (e) {
    console.error('Error cargando reportes encuestas:', e);
    res.status(500).json({ error: 'Error al cargar reportes' });
  }
});

// ═══════════════════════════════════════════════
// ENDPOINTS PÚBLICOS: Encuesta pública (sin auth)
// ═══════════════════════════════════════════════

// GET /encuesta-publica/:token — servir página pública
app.get('/encuesta-publica/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'encuesta-publico.html'));
});

// GET /api/encuestas/public/:token — datos públicos (sin auth)
app.get('/api/encuestas/public/:token', (req, res) => {
  try {
    const encuesta = queryFirst(`
      SELECT e.id, e.orden_trabajo_id, e.token_publico, e.fecha_limite, e.estado,
        ot.numero_ot, ot.descripcion,
        c.nombre as cliente_nombre, c.direccion as cliente_direccion,
        a.numero_aval, a.cliente_nombre as aval_cliente_nombre
      FROM encuestas_satisfaccion e
      JOIN ordenes_trabajo ot ON e.orden_trabajo_id = ot.id
      JOIN clientes c ON ot.cliente_id = c.id
      LEFT JOIN avales a ON e.aval_id = a.id
      WHERE e.token_publico = ?
    `, [req.params.token]);

    if (!encuesta) return res.status(404).json({ error: 'Encuesta no encontrada' });
    if (encuesta.estado === 'completada') return res.status(400).json({ error: 'Esta encuesta ya fue completada', yaCompletada: true });

    res.json({ encuesta });
  } catch (e) {
    console.error('Error fetching public encuesta:', e);
    res.status(500).json({ error: 'Error al obtener encuesta' });
  }
});

// POST /api/encuestas/public/:token/responder — cliente responde (sin auth)
app.post('/api/encuestas/public/:token/responder', (req, res) => {
  try {
    const encuesta = queryFirst('SELECT id, estado FROM encuestas_satisfaccion WHERE token_publico = ?', [req.params.token]);
    if (!encuesta) return res.status(404).json({ error: 'Encuesta no encontrada' });
    if (encuesta.estado === 'completada') return res.status(400).json({ error: 'Encuesta ya completada' });

    const b = req.body;
    const respuestas = {
      satisfaccion_general: Math.min(5, Math.max(1, b.satisfaccion_general || 3)),
      tiempo_entrega: Math.min(5, Math.max(1, b.tiempo_entrega || 3)),
      desempeno_equipo: Math.min(5, Math.max(1, b.desempeno_equipo || 3)),
      presentacion_equipo: Math.min(5, Math.max(1, b.presentacion_equipo || 3)),
      calidad_productos: Math.min(5, Math.max(1, b.calidad_productos || 3)),
      conocimientos_tecnicos: Math.min(5, Math.max(1, b.conocimientos_tecnicos || 3)),
      calidad_entrenamientos: Math.min(5, Math.max(1, b.calidad_entrenamientos || 3)),
      recomendaria: b.recomendaria ? 1 : 0,
      observaciones: b.observaciones || null
    };
    const pct = calcPorcentaje(respuestas);

    run(`UPDATE encuestas_satisfaccion SET
      satisfaccion_general = ?,
      tiempo_entrega = ?,
      desempeno_equipo = ?,
      presentacion_equipo = ?,
      calidad_productos = ?,
      conocimientos_tecnicos = ?,
      calidad_entrenamientos = ?,
      recomendaria = ?,
      observaciones = ?,
      porcentaje_final = ?,
      fecha_encuesta = datetime('now', '-04:00'),
      estado = 'completada'
      WHERE id = ?`,
      [respuestas.satisfaccion_general, respuestas.tiempo_entrega,
       respuestas.desempeno_equipo, respuestas.presentacion_equipo,
       respuestas.calidad_productos, respuestas.conocimientos_tecnicos,
       respuestas.calidad_entrenamientos, respuestas.recomendaria,
       respuestas.observaciones, pct, encuesta.id]);

    // Enviar email de confirmación
    const datosEnc = queryFirst(`
      SELECT e.*, ot.numero_ot, c.nombre as cliente_nombre
      FROM encuestas_satisfaccion e
      JOIN ordenes_trabajo ot ON e.orden_trabajo_id = ot.id
      JOIN clientes c ON ot.cliente_id = c.id
      WHERE e.id = ?
    `, [encuesta.id]);

    if (datosEnc) {
      const admins = queryAll("SELECT email FROM usuarios WHERE rol IN ('admin','superadmin') AND email IS NOT NULL");
      const recipients = admins.map(a => a.email).filter(Boolean);
      const sc = queryFirst("SELECT email FROM usuarios WHERE rol = 'servicio_cliente' LIMIT 1");
      if (sc?.email) recipients.push(sc.email);

      if (recipients.length > 0) {
        enviarEmail({
          to: recipients,
          subject: `✅ Encuesta completada por cliente - OT ${datosEnc.numero_ot} (${pct}%)`,
          html: `<h2>Encuesta completada por el cliente</h2>
            <p><strong>OT:</strong> ${datosEnc.numero_ot}</p>
            <p><strong>Resultado:</strong> ${pct}% de satisfacción</p>
            <table border="1" cellpadding="8" style="border-collapse:collapse">
              <tr><td>Satisfacción General</td><td>${respuestas.satisfaccion_general}/5</td></tr>
              <tr><td>Tiempo de Entrega</td><td>${respuestas.tiempo_entrega}/5</td></tr>
              <tr><td>Desempeño del Equipo</td><td>${respuestas.desempeno_equipo}/5</td></tr>
              <tr><td>Presentación del Equipo</td><td>${respuestas.presentacion_equipo}/5</td></tr>
              <tr><td>Calidad de Productos</td><td>${respuestas.calidad_productos}/5</td></tr>
              <tr><td>Conocimientos Técnicos</td><td>${respuestas.conocimientos_tecnicos}/5</td></tr>
              <tr><td>Calidad de Entrenamientos</td><td>${respuestas.calidad_entrenamientos}/5</td></tr>
            </table>
            ${respuestas.observaciones ? `<p><strong>Observaciones:</strong> ${respuestas.observaciones}</p>` : ''}`
        }).catch(err => console.error('Error email confirmación encuesta:', err));
      }
    }

    res.json({ message: 'Encuesta completada. ¡Gracias por tu opinión!', porcentaje: pct });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error responding to public encuesta:', e);
    res.status(500).json({ error: 'Error al guardar respuestas' });
  }
});

// ==================== API: CONFIGURACIÓN ====================
app.get('/api/config', authMiddleware, adminOnly, (req, res) => {
  const config = queryFirst('SELECT * FROM configuracion_incentivos WHERE id = 1');
  res.json({ config });
});

app.put('/api/config', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body;
    const allowedFields = [
      'ponderacion_tiempo_entrega', 'ponderacion_desempeno', 'ponderacion_conocimientos',
      'ponderacion_presentacion', 'ponderacion_calidad_productos', 'ponderacion_calidad_entrenamientos',
      'valor_cerradura', 'valor_control_acceso', 'valor_caja_fuerte', 'valor_ahorro_energia',
      'mant_cerradura', 'mant_caja_fuerte', 'mant_ahorro_energia',
    ];

    const sets = [];
    const params = [];
    for (const field of allowedFields) {
      if (b[field] !== undefined) {
        const val = Number(b[field]);
        if (isNaN(val) || val < 0) continue;
        sets.push(`${field} = ?`);
        params.push(val);
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No hay campos válidos para actualizar' });
    }

    sets.push("actualizado_en = datetime('now', '-04:00')");
    run(`UPDATE configuracion_incentivos SET ${sets.join(', ')} WHERE id = 1`, params);

    // Invalidar cache de precios
    invalidarPreciosCache();

    const config = queryFirst('SELECT * FROM configuracion_incentivos WHERE id = 1');
    res.json({ message: 'Configuración actualizada', config });
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
  } catch (e) {
    console.error('Error updating config:', e);
    res.status(500).json({ error: 'Error al actualizar configuración' });
  }
});


// ==================== API: TIPOS DE SERVICIO (configurables) ====================

// GET /api/tipos-servicio — lista todos los tipos activos con sus categorías (requiere auth)
app.get('/api/tipos-servicio', authMiddleware, (req, res) => {
  try {
    const data = getTiposServicio();
    res.json({ tipos_servicio: data });
  } catch (e) {
    console.error('Error cargando tipos_servicio:', e);
    res.status(500).json({ error: 'Error al cargar tipos de servicio' });
  }
});

// GET /api/public/tipos-servicio — endpoint público (sin auth) para poblar selects del frontend
app.get('/api/public/tipos-servicio', (req, res) => {
  try {
    const data = getTiposServicio();
    res.json({ tipos_servicio: data });
  } catch (e) {
    console.error('Error cargando tipos_servicio public:', e);
    res.status(500).json({ error: 'Error al cargar tipos de servicio' });
  }
});

// Helper para obtener tipos con categorías
function getTiposServicio() {
  const tipos = queryAll('SELECT * FROM tipos_servicio WHERE activo = 1 ORDER BY id');
  for (const t of tipos) {
    t.categorias = queryAll('SELECT * FROM categorias_servicio WHERE tipo_servicio_id = ? AND activo = 1 ORDER BY id', [t.id]);
  }
  return tipos;
}

// POST /api/tipos-servicio — crear nuevo tipo de servicio
app.post('/api/tipos-servicio', authMiddleware, (req, res) => {
  try {
    const { nombre, label } = req.body;
    if (!nombre || !label) return res.status(400).json({ error: 'nombre y label son requeridos' });
    const result = run('INSERT INTO tipos_servicio (nombre, label) VALUES (?, ?)', [nombre, label]);
    res.json({ message: 'Tipo de servicio creado', id: result.lastInsertRowid });
  } catch (e) {
    console.error('Error creando tipo_servicio:', e);
    res.status(500).json({ error: 'Error al crear tipo de servicio' });
  }
});

// PUT /api/tipos-servicio/:id — actualizar tipo de servicio
app.put('/api/tipos-servicio/:id', authMiddleware, (req, res) => {
  try {
    const { nombre, label, activo } = req.body;
    const sets = [];
    const params = [];
    if (nombre !== undefined) { sets.push('nombre = ?'); params.push(nombre); }
    if (label !== undefined) { sets.push('label = ?'); params.push(label); }
    if (activo !== undefined) { sets.push('activo = ?'); params.push(activo); }
    if (sets.length === 0) return res.status(400).json({ error: 'No hay campos para actualizar' });
    params.push(req.params.id);
    run(`UPDATE tipos_servicio SET ${sets.join(', ')} WHERE id = ?`, params);
    res.json({ message: 'Tipo de servicio actualizado' });
  } catch (e) {
    console.error('Error actualizando tipo_servicio:', e);
    res.status(500).json({ error: 'Error al actualizar tipo de servicio' });
  }
});

// DELETE /api/tipos-servicio/:id — desactivar tipo de servicio (baja lógica)
app.delete('/api/tipos-servicio/:id', authMiddleware, (req, res) => {
  try {
    run('UPDATE tipos_servicio SET activo = 0 WHERE id = ?', [req.params.id]);
    // Desactivar también sus categorías
    run('UPDATE categorias_servicio SET activo = 0 WHERE tipo_servicio_id = ?', [req.params.id]);
    res.json({ message: 'Tipo de servicio desactivado' });
  } catch (e) {
    console.error('Error eliminando tipo_servicio:', e);
    res.status(500).json({ error: 'Error al eliminar tipo de servicio' });
  }
});

// POST /api/tipos-servicio/:id/categorias — agregar categoría a un tipo
app.post('/api/tipos-servicio/:id/categorias', authMiddleware, (req, res) => {
  try {
    const { key, label, icon, precio } = req.body;
    if (!key || !label) return res.status(400).json({ error: 'key y label son requeridos' });
    const result = run('INSERT INTO categorias_servicio (tipo_servicio_id, key, label, icon, precio) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, key, label, icon || '📦', precio || 0]);
    // Invalidar cache de precios
    invalidarPreciosCache();
    res.json({ message: 'Categoría agregada', id: result.lastInsertRowid });
  } catch (e) {
    console.error('Error creando categoria:', e);
    res.status(500).json({ error: 'Error al crear categoría' });
  }
});

// PUT /api/tipos-servicio/:tipoId/categorias/:catId — actualizar categoría
app.put('/api/tipos-servicio/:tipoId/categorias/:catId', authMiddleware, (req, res) => {
  try {
    const { key, label, icon, precio, activo } = req.body;
    const sets = [];
    const params = [];
    if (key !== undefined) { sets.push('key = ?'); params.push(key); }
    if (label !== undefined) { sets.push('label = ?'); params.push(label); }
    if (icon !== undefined) { sets.push('icon = ?'); params.push(icon); }
    if (precio !== undefined) { sets.push('precio = ?'); params.push(parseFloat(precio) || 0); }
    if (activo !== undefined) { sets.push('activo = ?'); params.push(activo); }
    if (sets.length === 0) return res.status(400).json({ error: 'No hay campos para actualizar' });
    params.push(req.params.catId);
    run(`UPDATE categorias_servicio SET ${sets.join(', ')} WHERE id = ?`, params);
    invalidarPreciosCache();
    res.json({ message: 'Categoría actualizada' });
  } catch (e) {
    console.error('Error actualizando categoria:', e);
    res.status(500).json({ error: 'Error al actualizar categoría' });
  }
});

// DELETE /api/tipos-servicio/:tipoId/categorias/:catId — desactivar categoría
app.delete('/api/tipos-servicio/:tipoId/categorias/:catId', authMiddleware, (req, res) => {
  try {
    run('UPDATE categorias_servicio SET activo = 0 WHERE id = ?', [req.params.catId]);
    invalidarPreciosCache();
    res.json({ message: 'Categoría desactivada' });
  } catch (e) {
    console.error('Error eliminando categoria:', e);
    res.status(500).json({ error: 'Error al eliminar categoría' });
  }
});

// ==================== API: CONFIGURACIÓN DE DOCUMENTOS ====================
app.get('/api/config/documentos', authMiddleware, (req, res) => {
  const cfg = queryFirst('SELECT * FROM configuracion_documentos WHERE id = 1');
  delete cfg.id;
  res.json({ configuracion: cfg });
});

app.put('/api/config/documentos', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body;
    const allowedFields = [
      'nombre_empresa', 'eslogan', 'direccion', 'telefono', 'email', 'website',
      'logo_base64', 'pie_pagina', 'color_primario'
    ];

    const sets = [];
    const params = [];
    for (const field of allowedFields) {
      if (b[field] !== undefined) {
        sets.push(`${field} = ?`);
        params.push(b[field]);
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    sets.push("actualizado_en = datetime('now', '-04:00')");
    run(`UPDATE configuracion_documentos SET ${sets.join(', ')} WHERE id = 1`, params);

    const cfg = queryFirst('SELECT * FROM configuracion_documentos WHERE id = 1');
    delete cfg.id;
    res.json({ message: 'Configuración de documentos actualizada', configuracion: cfg })
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); };
  } catch (e) {
    console.error('Error updating documentos config:', e);
    res.status(500).json({ error: 'Error al actualizar configuración de documentos' });
  }
});

// ==================== API: REPORTE DE BONO (NUEVO) ====================
app.get('/api/reporte/bono', authMiddleware, adminOnly, (req, res) => {
  try {
    const inicio = req.query.inicio;
    const fin = req.query.fin;

    // Default to current quarter if no dates provided
    let fInicio, fFin;
    if (inicio && fin) {
      fInicio = inicio;
      fFin = fin;
    } else {
      const now = new Date();
      const trim = Math.ceil((now.getMonth() + 1) / 3);
      const mesesInicio = (trim - 1) * 3 + 1;
      fInicio = `${now.getFullYear()}-${String(mesesInicio).padStart(2, '0')}-01`;
      fFin = `${now.getFullYear()}-${String(mesesInicio + 2).padStart(2, '0')}-31`;
    }

    // Get all completed OTs (aval confirmado) in range
    const proyectos = queryAll(`
      SELECT ot.*, c.nombre as cliente_nombre, c.id as cliente_id, p.nombre_proyecto,
             a.id as aval_id,
             a.trabajo_completado, a.detalle_trabajo_real,
             a.penalizado_foto, a.skip_survey, a.skip_survey_pct,
             a.reapertura_penalizado, a.origen,
             a.historial_reconsideracion,
             e.tiempo_entrega, e.desempeno_equipo, e.presentacion_equipo,
             e.calidad_productos, e.calidad_entrenamientos, e.porcentaje_final
      FROM ordenes_trabajo ot
      JOIN clientes c ON ot.cliente_id = c.id
      LEFT JOIN avales a ON a.orden_trabajo_id = ot.id AND a.estado = 'confirmado'
      LEFT JOIN presupuestos p ON ot.presupuesto_id = p.id
      LEFT JOIN encuestas_satisfaccion e ON e.orden_trabajo_id = ot.id
      WHERE ot.estado = 'completada'
        AND (ot.fecha_fin >= ? AND ot.fecha_fin <= ?)
    `, [fInicio, fFin]);

    // Separar OTs por origen
    const proyectosNormales = proyectos.filter(ot => !ot.origen || (ot.origen !== 'garantia' && ot.origen !== 'levantamiento'));
    const proyectosGarantia = proyectos.filter(ot => ot.origen === 'garantia' || ot.origen === 'levantamiento');

    // ════════════════════════════════════════════════════════
    // Calcular penalidades dinámicas por aval v2
    // ════════════════════════════════════════════════════════
    function calcularPenalidadAval(aval, ot) {
      var penalidades = [];
      var penalidadTotal = 0;

      // P3: Reapertura penalizada (-50%)
      if (aval && aval.reapertura_penalizado) {
        penalidades.push({ tipo: 'reapertura', porcentaje: 50, descripcion: 'OT reabierta' });
        penalidadTotal += 50;
      }

      // P2: Foto penalizada
      if (aval && aval.penalizado_foto) {
        // Si tiene encuesta negativa (< 3 de promedio), -70%; si no -50%
        const encuestaQuery = queryFirst(`
          SELECT (tiempo_entrega + desempeno_equipo + presentacion_equipo + calidad_productos + calidad_entrenamientos) / 5.0 as prom
          FROM encuestas_satisfaccion WHERE orden_trabajo_id = ? AND estado = 'completada'
        `, [ot.id]);
        const pctFoto = (encuestaQuery && encuestaQuery.prom !== null && encuestaQuery.prom < 3) ? 70 : 50;
        penalidades.push({ tipo: 'foto', porcentaje: pctFoto, descripcion: 'Foto ilegible' + (pctFoto === 70 ? ' (encuesta negativa)' : '') });
        penalidadTotal += pctFoto;
      }

      // P1: Penalidad por firma (del historial_reconsideracion)
      if (aval && aval.historial_reconsideracion) {
        try {
          var historial = JSON.parse(aval.historial_reconsideracion);
          if (Array.isArray(historial)) {
            for (var h of historial) {
              if (h.tipo === 'penalidad_firma' && h.penalidad_porcentaje) {
                penalidades.push({ tipo: 'firma', porcentaje: h.penalidad_porcentaje, descripcion: h.dias_sin_firmar + 'd sin firmar', dias: h.dias_sin_firmar });
                penalidadTotal += h.penalidad_porcentaje;
              }
            }
          }
        } catch(e) {}
      }

      // P4: Cancelada por admin (0% penalidad) — se maneja en estado cancelada
      // P5: Abandono técnico (-100%) — se maneja en estado cancelada

      // Si tiene skip_survey (confirmación express), usar el pct manual
      if (aval && aval.skip_survey) {
        // El skip_survey_pct es el % de bono asignado, no penalidad
        // Lo aplicamos como factor multiplicador al final
      }

      return { penalidades, penalidadTotal: Math.min(penalidadTotal, 100) };
    }

    // Calcular para proyectos normales con penalidades
    const proyectosData = proyectosNormales.map(ot => {
      const aval = { id: ot.aval_id, reapertura_penalizado: ot.reapertura_penalizado, penalizado_foto: ot.penalizado_foto, historial_reconsideracion: ot.historial_reconsideracion, skip_survey: ot.skip_survey, skip_survey_pct: ot.skip_survey_pct };
      const { penalidades, penalidadTotal } = calcularPenalidadAval(aval, ot);
      
      // Si tiene skip_survey (confirmación express), aplicar % manual
      let factorBono = 1; // 100% por defecto
      if (aval.skip_survey && aval.skip_survey_pct !== null) {
        factorBono = aval.skip_survey_pct / 100;
      }
      // Get confirmed products from aval
      let cerradurasNuevas = 0, cajasNuevas = 0, controlAccesoNuevo = 0, ahorroEnergiaNuevo = 0;
      let cerradurasMant = 0, cajasMant = 0, ahorroEnergiaMant = 0;

      if (ot.aval_id) {
        const productosConfirmados = queryAll(`
          SELECT ap.cantidad_confirmada, p.nombre, p.categoria
          FROM aval_productos ap
          JOIN productos p ON ap.producto_id = p.id
          WHERE ap.aval_id = ? AND ap.cantidad_confirmada IS NOT NULL
        `, [ot.aval_id]);

        for (const p of productosConfirmados) {
          if (ot.tipo_servicio === 'proyecto_nuevo') {
            if (p.categoria === 'cerradura') cerradurasNuevas += p.cantidad_confirmada;
            else if (p.categoria === 'caja_fuerte') cajasNuevas += p.cantidad_confirmada;
            else if (p.categoria === 'control_acceso') controlAccesoNuevo += p.cantidad_confirmada;
            else if (p.categoria === 'ahorro_energia') ahorroEnergiaNuevo += p.cantidad_confirmada;
          } else if (ot.tipo_servicio === 'mantenimiento') {
            if (p.categoria === 'cerradura') cerradurasMant += p.cantidad_confirmada;
            else if (p.categoria === 'caja_fuerte') cajasMant += p.cantidad_confirmada;
            else if (p.categoria === 'ahorro_energia') ahorroEnergiaMant += p.cantidad_confirmada;
          }
        }
      } else {
        // Fallback: use OT productos with cantidad
        const prods = queryAll(`
          SELECT p.categoria, otp.cantidad
          FROM orden_trabajo_productos otp
          JOIN productos p ON otp.producto_id = p.id
          WHERE otp.orden_trabajo_id = ?
        `, [ot.id]);
        for (const p of prods) {
          if (ot.tipo_servicio === 'proyecto_nuevo') {
            if (p.categoria === 'cerradura') cerradurasNuevas += p.cantidad;
            else if (p.categoria === 'caja_fuerte') cajasNuevas += p.cantidad;
            else if (p.categoria === 'control_acceso') controlAccesoNuevo += p.cantidad;
            else if (p.categoria === 'ahorro_energia') ahorroEnergiaNuevo += p.cantidad;
          } else if (ot.tipo_servicio === 'mantenimiento') {
            if (p.categoria === 'cerradura') cerradurasMant += p.cantidad;
            else if (p.categoria === 'caja_fuerte') cajasMant += p.cantidad;
            else if (p.categoria === 'ahorro_energia') ahorroEnergiaMant += p.cantidad;
          }
        }
      }

      // Calculate values using precios from DB
      const __precios = getPreciosFromDB();
      const valCerNuevo = cerradurasNuevas * __precios.proyecto_nuevo.cerradura;
      const valCajaNuevo = cajasNuevas * __precios.proyecto_nuevo.caja_fuerte;
      const valCtrlNuevo = controlAccesoNuevo * __precios.proyecto_nuevo.control_acceso;
      const valAhorroNuevo = ahorroEnergiaNuevo * __precios.proyecto_nuevo.ahorro_energia;
      const valCerMant = cerradurasMant * __precios.mantenimiento.cerradura;
      const valCajaMant = cajasMant * __precios.mantenimiento.caja_fuerte;
      const valAhorroMant = ahorroEnergiaMant * __precios.mantenimiento.ahorro_energia;

      const subtotal = valCerNuevo + valCajaNuevo + valCtrlNuevo + valAhorroNuevo +
                       valCerMant + valCajaMant + valAhorroMant;

      // Evaluation
      let evaluacion = null;
      if (ot.tiempo_entrega !== null) {
        const prom = (ot.tiempo_entrega + ot.desempeno_equipo + ot.presentacion_equipo +
                      ot.calidad_productos + ot.calidad_entrenamientos) / 5;
        evaluacion = {
          tiempo_entrega: ot.tiempo_entrega,
          desempeno: ot.desempeno_equipo,
          presentacion: ot.presentacion_equipo,
          calidad_productos: ot.calidad_productos,
          calidad_entrenamientos: ot.calidad_entrenamientos,
          promedio: prom
        };
      }

      // Deducción
      let deduccionPorcentaje = 0;
      let total = subtotal;

      // Penalidades v2
      let penalidadPorcentaje = penalidadTotal;
      let descuentoPenalidad = 0;

      // Aplicar factor de skip_survey primero
      total = total * factorBono;

      // Luego aplicar deducción por evaluación (existente)
      if (evaluacion && evaluacion.promedio < 1.0) {
        deduccionPorcentaje = 1 - evaluacion.promedio;
        total = total * (1 - deduccionPorcentaje);
      }

      // Finalmente aplicar penalidades
      if (penalidadTotal > 0) {
        descuentoPenalidad = total * (penalidadTotal / 100);
        total = total - descuentoPenalidad;
      }

      return {
        id: ot.id,
        nombre: ot.nombre_proyecto || ot.cliente_nombre,
        habitaciones: 1,
        fecha_inicio: ot.fecha_inicio,
        fecha_fin: ot.fecha_fin,
        origen: ot.origen || 'instalacion',
        proyecto_nuevo: {
          cerraduras: cerradurasNuevas,
          cajas_fuertes: cajasNuevas,
          control_acceso: controlAccesoNuevo,
          ahorro_energia: ahorroEnergiaNuevo
        },
        mantenimiento: {
          cerraduras: cerradurasMant,
          cajas_fuertes: cajasMant,
          ahorradores: ahorroEnergiaMant
        },
        valores: {
          cerraduras: valCerNuevo + valCerMant,
          cajas_fuertes: valCajaNuevo + valCajaMant,
          control_acceso: valCtrlNuevo,
          ahorro_energia: valAhorroNuevo + valAhorroMant,
          subtotal: Math.round(subtotal * 100) / 100,
          factor_bono: Math.round(factorBono * 100) / 100,
          penalidad_porcentaje: penalidadTotal,
          penalidades: penalidades
        },
        evaluacion: evaluacion,
        deduccion_porcentaje: Math.round(deduccionPorcentaje * 10000) / 10000,
        descuento_penalidad: Math.round(descuentoPenalidad * 100) / 100,
        total: Math.round(total * 100) / 100
      };
    });

    // Calcular extra 5% trimestral por garantías con ≥95% satisfacción
    let extraGarantiaPct = 0;
    let garantiasElegibles = 0;
    let garantiasTotal = 0;
    if (proyectosGarantia.length > 0) {
      for (var g of proyectosGarantia) {
        garantiasTotal++;
        const encG = queryFirst(`
          SELECT (tiempo_entrega + desempeno_equipo + presentacion_equipo + calidad_productos + calidad_entrenamientos) / 5.0 as prom
          FROM encuestas_satisfaccion WHERE orden_trabajo_id = ? AND estado = 'completada'
        `, [g.id]);
        if (encG && encG.prom !== null && encG.prom >= 4.75) {
          garantiasElegibles++;
        }
      }
      const pctSatisfaccion = garantiasTotal > 0 ? (garantiasElegibles / garantiasTotal * 100) : 0;
      if (pctSatisfaccion >= 95) {
        extraGarantiaPct = 5;
      }
    }

    // Sum totals
    let totalCerraduras = 0, totalCajas = 0, totalControlAcceso = 0, totalAhorroEnergia = 0;
    let totalBruto = 0, totalDeduccion = 0, totalPenalidad = 0;
    let sumEval = 0, countEval = 0;

    for (const p of proyectosData) {
      totalCerraduras += p.valores.cerraduras;
      totalCajas += p.valores.cajas_fuertes;
      totalControlAcceso += p.valores.control_acceso;
      totalAhorroEnergia += p.valores.ahorro_energia;
      totalBruto += p.valores.subtotal;
      totalPenalidad += (p.descuento_penalidad || 0);
      totalDeduccion += (p.valores.subtotal - p.total) - (p.descuento_penalidad || 0);
      if (p.evaluacion) {
        sumEval += p.evaluacion.promedio;
        countEval++;
      }
    }

    const evalPromedioGeneral = countEval > 0 ? Math.round((sumEval / countEval) * 100) / 100 : null;
    const porcDeduccionGeneral = totalBruto > 0 ? Math.round((totalDeduccion / totalBruto) * 10000) / 10000 : 0;
    const totalADistribuir = Math.round((totalBruto - totalDeduccion - totalPenalidad) * 100) / 100;

    // Distribución por técnico
    const distTecnicos = [
      { nombre: 'Máximo Vallejo', porcentaje: 0.30 },
      { nombre: 'Víctor De La Rosa', porcentaje: 0.28 },
      { nombre: 'Alexander De Dios', porcentaje: 0.12 },
      { nombre: 'Ángel Pérez', porcentaje: 0.12 },
      { nombre: 'Juan Samuel Encarnación', porcentaje: 0.08 },
      { nombre: 'Rosaura Nivar', porcentaje: 0.10 },
    ];

    // Aplicar extra 5% trimestral a distribución
    const distribucion = distTecnicos.map(t => ({
      tecnico: t.nombre,
      porcentaje: t.porcentaje,
      valor_bruto: Math.round(t.porcentaje * totalADistribuir * 100) / 100,
      adicionales: Math.round(t.porcentaje * totalADistribuir * extraGarantiaPct / 100 * 100) / 100,
      total: Math.round(t.porcentaje * totalADistribuir * (1 + extraGarantiaPct/100) * 100) / 100
    }));

    const resultado = {
      periodo: { inicio: fInicio, fin: fFin },
      proyectos: proyectosData,
      proyectos_garantia_count: proyectosGarantia.length,
      garantias_elegibles: garantiasElegibles,
      garantias_total: garantiasTotal,
      extra_garantia_pct: extraGarantiaPct,
      resumen: {
        total_proyectos: proyectosData.length,
        total_cerraduras: Math.round(totalCerraduras * 100) / 100,
        total_cajas_fuertes: Math.round(totalCajas * 100) / 100,
        total_control_acceso: Math.round(totalControlAcceso * 100) / 100,
        total_ahorro_energia: Math.round(totalAhorroEnergia * 100) / 100,
        evaluacion_promedio_general: evalPromedioGeneral,
        total_bruto: Math.round(totalBruto * 100) / 100,
        porcentaje_deduccion: porcDeduccionGeneral,
        total_deduccion: Math.round(totalDeduccion * 100) / 100,
        total_penalidad: Math.round(totalPenalidad * 100) / 100,
        total_a_distribuir: totalADistribuir,
        extra_garantia_pct: extraGarantiaPct,
        extra_garantia_valor: Math.round(totalADistribuir * extraGarantiaPct / 100 * 100) / 100
      },
      distribucion
    };

    res.json(resultado);
  } catch (e) {
    console.error('Error generating bono report:', e);
    res.status(500).json({ error: 'Error al generar reporte de bono' });
  }
});

// ==================== API: REPORTES (legacy / existing) ====================
app.get('/api/reportes', authMiddleware, adminOnly, (req, res) => {
  const action = req.query.action;
  if (!action) {
    return res.json({ reportes: queryAll('SELECT * FROM reportes_incentivos ORDER BY creado_en DESC') });
  }

  const anio = parseInt(req.query.anio) || new Date().getFullYear();
  const trimestre = parseInt(req.query.trimestre) || Math.ceil((new Date().getMonth() + 1) / 3);

  const config = queryFirst('SELECT * FROM configuracion_incentivos WHERE id = 1');

  const mesesInicio = (trimestre - 1) * 3 + 1;
  const fInicio = `${anio}-${String(mesesInicio).padStart(2, '0')}-01`;
  const fFin = `${anio}-${String(mesesInicio + 2).padStart(2, '0')}-31`;

  const ordenes = queryAll(`SELECT ot.*, c.nombre as cliente_nombre,
    e.tiempo_entrega, e.desempeno_equipo, e.presentacion_equipo,
    e.calidad_productos, e.calidad_entrenamientos, e.conocimientos_tecnicos, e.porcentaje_final
    FROM ordenes_trabajo ot
    JOIN clientes c ON ot.cliente_id = c.id
    LEFT JOIN encuestas_satisfaccion e ON e.orden_trabajo_id = ot.id
    WHERE ot.estado = 'completada' AND ot.fecha_fin >= ? AND ot.fecha_fin <= ?`,
    [fInicio, fFin]);

  // Acumuladores
  let totalCerraduras = 0, totalCajas = 0, totalControl = 0, totalAH = 0;
  let totalMantCer = 0, totalMantCaja = 0, totalMantAH = 0;
  let sumTE = 0, sumDE = 0, sumPR = 0, sumCP = 0, sumCE = 0, countEval = 0;

  for (const ot of ordenes) {
    if (ot.tipo_servicio === 'proyecto_nuevo') totalCerraduras++;
    if (ot.tipo_servicio === 'mantenimiento') totalMantCer++;
    if (ot.porcentaje_final) {
      sumTE += ot.tiempo_entrega || 0; sumDE += ot.desempeno_equipo || 0;
      sumPR += ot.presentacion_equipo || 0; sumCP += ot.calidad_productos || 0;
      sumCE += ot.calidad_entrenamientos || 0; countEval++;
    }
  }

  const promTE = countEval ? sumTE / countEval : 1;
  const promDE = countEval ? sumDE / countEval : 1;
  const promPR = countEval ? sumPR / countEval : 1;
  const promCP = countEval ? sumCP / countEval : 1;
  const promCE = countEval ? sumCE / countEval : 1;

  const basePond = (
    promTE * config.ponderacion_tiempo_entrega +
    promDE * config.ponderacion_desempeno +
    promPR * config.ponderacion_presentacion +
    promCP * config.ponderacion_calidad_productos +
    promCE * config.ponderacion_calidad_entrenamientos
  ) / 5;
  const evalGeneral = Math.round((basePond / 5) * 100) / 100;

  const totalBruto =
    totalCerraduras * config.valor_cerradura +
    totalCajas * config.valor_caja_fuerte +
    totalControl * config.valor_control_acceso +
    totalAH * config.valor_ahorro_energia +
    totalMantCer * config.mant_cerradura +
    totalMantCaja * config.mant_caja_fuerte +
    totalMantAH * config.mant_ahorro_energia;

  const deduccionPorc = Math.max(0, 1 - evalGeneral);
  const totalDeduccion = totalBruto * deduccionPorc;
  const totalAPagar = totalBruto - totalDeduccion;

  const tecnicos = queryAll(`SELECT u.id, u.nombre, COUNT(ot.id) as total_ots,
    AVG(e.porcentaje_final) as promedio_evaluacion
    FROM ordenes_trabajo ot
    JOIN usuarios u ON ot.tecnico_id = u.id
    LEFT JOIN encuestas_satisfaccion e ON e.orden_trabajo_id = ot.id
    WHERE ot.estado = 'completada' AND ot.fecha_fin >= ? AND ot.fecha_fin <= ? AND u.rol = 'tecnico'
    GROUP BY u.id`, [fInicio, fFin]);

  const totalPuntos = tecnicos.reduce((s, t) => s + (t.promedio_evaluacion || 0) * t.total_ots, 0);
  const distribucion = tecnicos.map(t => ({
    nombre: t.nombre,
    ots_completadas: t.total_ots,
    promedio_eval: Math.round((t.promedio_evaluacion || 0) * 100) / 100,
    puntos: Math.round((t.promedio_evaluacion || 0) * t.total_ots * 100) / 100,
    porcentaje: totalPuntos > 0
      ? Math.round(((t.promedio_evaluacion || 0) * t.total_ots / totalPuntos) * 10000) / 100
      : 0,
    valor_bruto: totalPuntos > 0
      ? Math.round((((t.promedio_evaluacion || 0) * t.total_ots / totalPuntos) * totalAPagar) * 100) / 100
      : 0,
  }));

  const resultado = {
    periodo: `${anio}-T${trimestre}`,
    anio, trimestre,
    proyectos_count: ordenes.length,
    resumen: {
      instalaciones: totalCerraduras,
      mantenimientos: totalMantCer,
      total_servicios: ordenes.length,
    },
    evaluaciones: {
      tiempo_entrega: Math.round(promTE * 100) / 100,
      desempeno: Math.round(promDE * 100) / 100,
      presentacion: Math.round(promPR * 100) / 100,
      calidad_productos: Math.round(promCP * 100) / 100,
      calidad_entrenamientos: Math.round(promCE * 100) / 100,
      evaluacion_general: evalGeneral,
    },
    totales: {
      bruto: Math.round(totalBruto * 100) / 100,
      deduccion_porc: Math.round(deduccionPorc * 10000) / 100,
      deduccion_monto: Math.round(totalDeduccion * 100) / 100,
      a_pagar: Math.round(totalAPagar * 100) / 100,
    },
    distribucion,
  };

  if (action === 'generar') {
    run('INSERT INTO reportes_incentivos (periodo, anio, trimestre, datos_json) VALUES (?, ?, ?, ?)',
      [resultado.periodo, anio, trimestre, JSON.stringify(resultado)]);
    resultado.saved = true;
  }

  res.json(resultado);
});

// ============ PÁGINA DE DETALLE DE OT (standalone, nueva pestaña) ============
app.get('/orden/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const ot = queryFirst(`
      SELECT ot.*, c.nombre as cliente_nombre, c.telefono as cliente_telefono,
             c.email as cliente_email, c.direccion as cliente_direccion,
             c.cedula_rnc as cliente_cedula_rnc, c.tipo as cliente_tipo,
             u.nombre as tecnico_nombre, u.telefono as tecnico_telefono,
             p.nombre_proyecto,
             cr.nombre as creado_por_nombre
      FROM ordenes_trabajo ot
      JOIN clientes c ON ot.cliente_id = c.id
      LEFT JOIN usuarios u ON ot.tecnico_id = u.id
      LEFT JOIN presupuestos p ON ot.presupuesto_id = p.id
      LEFT JOIN usuarios cr ON ot.creada_por = cr.id
      WHERE ot.id = ?
    `, [id]);
    if (!ot) return res.status(404).send('OT no encontrada');

    const productos = queryAll(`
      SELECT p.id, p.nombre, p.categoria, otp.cantidad
      FROM orden_trabajo_productos otp
      JOIN productos p ON otp.producto_id = p.id
      WHERE otp.orden_trabajo_id = ?
    `, [id]);

    // Cargar configuración de documentos
    const cfgDoc = queryFirst('SELECT * FROM configuracion_documentos WHERE id = 1') || {
      nombre_empresa: 'DKLIC PLUS INVESTMENT', eslogan: '', direccion: '', telefono: '',
      email: '', website: '', logo_base64: '', pie_pagina: 'Documento generado por el sistema',
      color_primario: '#1e40af'
    };

    const escHtml2 = (s) => { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };

    const preciosCfg2 = getPreciosFromDB();
    const precios = ot.tipo_servicio === 'mantenimiento' ? preciosCfg2.mantenimiento : preciosCfg2.proyecto_nuevo;
    let montoTotal = 0;
    let prodRows = '';
    let desgRows = '';

    // Si no hay productos, usar el tipo de servicio como categoría base
    if (productos.length === 0) {
      const catBase = ot.categoria_servicio || ot.tipo_servicio;
      const precioBase = precios[catBase] || 0;
      montoTotal = precioBase;
      prodRows = `<tr><td style="border:1px solid #e5e7eb;padding:8px">${escHtml2(ot.tipo_servicio)}</td><td style="border:1px solid #e5e7eb;padding:8px;text-align:center">${escHtml2(catBase)}</td><td style="border:1px solid #e5e7eb;padding:8px;text-align:center">1</td></tr>`;
    } else {
      prodRows = productos.map(p => {
        montoTotal += 0;
        return `<tr><td style="border:1px solid #e5e7eb;padding:8px">${escHtml2(p.nombre)}</td><td style="border:1px solid #e5e7eb;padding:8px;text-align:center">${p.categoria}</td><td style="border:1px solid #e5e7eb;padding:8px;text-align:center">${p.cantidad}</td></tr>`;
      }).join('');
    }

    // Aval
    const aval = queryFirst(`SELECT * FROM avales WHERE orden_trabajo_id = ?`, [id]);
    // Encuesta
    const encuesta = queryFirst(`SELECT * FROM encuestas_satisfaccion WHERE orden_trabajo_id = ?`, [id]);

    const estadoLabel = { pendiente: 'Pendiente', aprobada: 'Aprobada', en_curso: 'En Curso', aval_entregado: 'Aval Entregado', completada: 'Completada', cancelada: 'Cancelada' };
    const estadoColor = { pendiente: '#eab308', aprobada: '#22c55e', en_curso: '#3b82f6', aval_entregado: '#8b5cf6', completada: '#6b7280', cancelada: '#ef4444' };

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escHtml2(ot.numero_ot)} - Detalle OT</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  @media print { body { margin: 0.5in; } .no-print { display: none !important; } }
  body { font-family: 'Inter', system-ui, sans-serif; background: #f3f4f6; }
</style>
</head>
<body>
<div class="max-w-4xl mx-auto p-4 space-y-4">
  <div class="no-print flex justify-between items-center mb-4">
    <button onclick="window.print()" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow">🖨️ Guardar PDF</button>
    <div class="flex gap-2">
      <a href="mailto:${escHtml2(ot.cliente_email)}?subject=${encodeURIComponent('OT ' + ot.numero_ot)}&body=${encodeURIComponent('Detalle de la OT ' + ot.numero_ot + '\n\nCliente: ' + ot.cliente_nombre + '\nMonto: RD$ ' + montoTotal.toFixed(2))}" class="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow">📧 Enviar Email</a>
      <a href="https://wa.me/1${escHtml2(ot.cliente_telefono ? ot.cliente_telefono.replace(/[^\d]/g,'') : '')}?text=${encodeURIComponent('Hola ' + ot.cliente_nombre + ', aquí está el detalle de su Orden de Trabajo ' + ot.numero_ot + '.\n\nAbrir detalle: https://' + req.get('host') + '/orden/' + id + '\n\nMonto total: RD$ ' + montoTotal.toFixed(2))}" target="_blank" class="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow">💬 WhatsApp</a>
    </div>
  </div>

  <div class="bg-white rounded-2xl shadow-lg border border-gray-200 overflow-hidden">
      <div class="p-6 text-white" style="background:linear-gradient(135deg, ${cfgDoc.color_primario || '#1e40af'} 0%, ${cfgDoc.color_primario || '#1e40af'}dd 100%)">
        <div class="flex justify-between items-start gap-4">
          <div class="flex items-center gap-4">
            ${cfgDoc.logo_base64 ? `<img src="${cfgDoc.logo_base64}" class="h-16 w-auto rounded-lg bg-white/10 p-1" alt="Logo">` : ''}
            <div>
              <h2 class="text-lg font-bold opacity-90">${escHtml2(cfgDoc.nombre_empresa)}</h2>
              ${cfgDoc.eslogan ? `<p class="text-sm opacity-75">${escHtml2(cfgDoc.eslogan)}</p>` : ''}
              <h1 class="text-3xl font-bold mt-2">${escHtml2(ot.numero_ot)}</h1>
              <p class="opacity-80 mt-0.5">Orden de Trabajo</p>
            </div>
          </div>
          <div style="background:${estadoColor[ot.estado] || '#6b7280'}" class="px-4 py-1.5 rounded-full text-sm font-semibold shrink-0">${estadoLabel[ot.estado] || ot.estado}</div>
        </div>
      </div>

    <div class="p-6 space-y-6">
      <!-- DATOS DE LA OT -->
      <div class="border border-gray-200 rounded-xl overflow-hidden">
        <div class="bg-gray-50 px-4 py-2.5 border-b border-gray-200 font-semibold text-gray-700 flex items-center gap-2"><span>📋</span> Datos de la OT</div>
        <div class="p-4 grid grid-cols-2 gap-3 text-sm">
          <div><span class="text-gray-500">Tipo de Servicio:</span><br><span class="font-medium capitalize">${escHtml2(ot.tipo_servicio)}</span></div>
          <div><span class="text-gray-500">Fuente:</span><br><span class="font-medium">${escHtml2(ot.fuente || '-')}</span></div>
          ${ot.descripcion ? `<div class="col-span-2"><span class="text-gray-500">Descripción:</span><br><span class="font-medium">${escHtml2(ot.descripcion)}</span></div>` : ''}
          ${ot.notas ? `<div class="col-span-2"><span class="text-gray-500">Notas:</span><br><span class="font-medium">${escHtml2(ot.notas)}</span></div>` : ''}
          ${ot.nombre_proyecto ? `<div class="col-span-2"><span class="text-gray-500">Presupuesto:</span><br><span class="font-medium">${escHtml2(ot.nombre_proyecto)} ${ot.presupuesto_aprobado ? '(Aprobado)' : ''}</span></div>` : ''}
          <div><span class="text-gray-500">Creada por:</span><br><span class="font-medium">${escHtml2(ot.creado_por_nombre || '-')}</span></div>
        </div>
      </div>

      <!-- CLIENTE -->
      <div class="border border-gray-200 rounded-xl overflow-hidden">
        <div class="bg-gray-50 px-4 py-2.5 border-b border-gray-200 font-semibold text-gray-700 flex items-center gap-2"><span>👤</span> Cliente</div>
        <div class="p-4 grid grid-cols-2 gap-3 text-sm">
          <div><span class="text-gray-500">Nombre:</span><br><span class="font-medium">${escHtml2(ot.cliente_nombre)}</span></div>
          <div><span class="text-gray-500">Tipo:</span><br><span class="font-medium capitalize">${escHtml2(ot.cliente_tipo || '-')}</span></div>
          <div><span class="text-gray-500">Teléfono:</span><br><span class="font-medium">${escHtml2(ot.cliente_telefono || '-')}</span></div>
          <div><span class="text-gray-500">Email:</span><br><span class="font-medium">${escHtml2(ot.cliente_email || '-')}</span></div>
          <div class="col-span-2"><span class="text-gray-500">Dirección:</span><br><span class="font-medium">${escHtml2(ot.cliente_direccion || '-')}</span></div>
          <div class="col-span-2"><span class="text-gray-500">Cédula/RNC:</span><br><span class="font-medium">${escHtml2(ot.cliente_cedula_rnc || '-')}</span></div>
        </div>
      </div>

      <!-- TÉCNICO -->
      <div class="border border-gray-200 rounded-xl overflow-hidden">
        <div class="bg-gray-50 px-4 py-2.5 border-b border-gray-200 font-semibold text-gray-700 flex items-center gap-2"><span>🔧</span> Técnico Asignado</div>
        <div class="p-4 grid grid-cols-2 gap-3 text-sm">
          <div><span class="text-gray-500">Nombre:</span><br><span class="font-medium">${escHtml2(ot.tecnico_nombre || 'No asignado')}</span></div>
          <div><span class="text-gray-500">Teléfono:</span><br><span class="font-medium">${escHtml2(ot.tecnico_telefono || '-')}</span></div>
        </div>
      </div>

      <!-- PRODUCTOS -->
      <div class="border border-gray-200 rounded-xl overflow-hidden">
        <div class="bg-gray-50 px-4 py-2.5 border-b border-gray-200 font-semibold text-gray-700 flex items-center gap-2"><span>📦</span> Productos / Servicios</div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead><tr class="bg-gray-50 border-b border-gray-200">
              <th class="text-left py-2.5 px-4 font-semibold text-gray-600 text-xs uppercase">Producto</th>
              <th class="text-center py-2.5 px-4 font-semibold text-gray-600 text-xs uppercase">Categoría</th>
              <th class="text-center py-2.5 px-4 font-semibold text-gray-600 text-xs uppercase">Cant.</th>
            </tr></thead>
            <tbody>${productos.length === 0 ? '<tr><td colspan="3" class="text-center py-8 text-gray-400">Sin productos asignados</td></tr>' : prodRows}</tbody>
          </table>
        </div>
      </div>

          </table>
        </div>
      </div>

      <!-- AVAL -->
      ${aval ? `<div class="border border-gray-200 rounded-xl overflow-hidden">
        <div class="bg-gray-50 px-4 py-2.5 border-b border-gray-200 font-semibold text-gray-700 flex items-center gap-2"><span>📄</span> Aval de Instalación</div>
        <div class="p-4 flex items-center justify-between">
          <div class="text-sm">
            <span class="font-medium">Estado:</span> ${aval.estado === 'confirmado' ? '✅ Confirmado' : '⏳ Pendiente'}<br>
            ${aval.fecha_entrega_tecnico ? `<span class="text-gray-500">Entrega: ${aval.fecha_entrega_tecnico}</span>` : ''}
          </div>
          <a href="/api/avales/${aval.id}/pdf" target="_blank" class="bg-blue-100 hover:bg-blue-200 text-blue-700 px-3 py-1.5 rounded-lg text-sm font-medium">Ver Aval</a>
        </div>
      </div>` : ''}

      <!-- ENCUESTA -->
      ${encuesta ? `<div class="border border-gray-200 rounded-xl overflow-hidden">
        <div class="bg-gray-50 px-4 py-2.5 border-b border-gray-200 font-semibold text-gray-700 flex items-center gap-2"><span>⭐</span> Encuesta de Satisfacción</div>
        <div class="p-4 grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <div><span class="text-gray-500">Tiempo de Entrega:</span><br><span class="font-medium">${encuesta.tiempo_entrega}/5</span></div>
          <div><span class="text-gray-500">Desempeño del Equipo:</span><br><span class="font-medium">${encuesta.desempeno_equipo}/5</span></div>
          <div><span class="text-gray-500">Presentación del Equipo:</span><br><span class="font-medium">${encuesta.presentacion_equipo}/5</span></div>
          <div><span class="text-gray-500">Calidad de Productos:</span><br><span class="font-medium">${encuesta.calidad_productos}/5</span></div>
          <div><span class="text-gray-500">Calidad de Entrenamiento:</span><br><span class="font-medium">${encuesta.calidad_entrenamientos}/5</span></div>
          <div><span class="text-gray-500">Promedio:</span><br><span class="font-bold text-lg text-yellow-600">${((encuesta.tiempo_entrega + encuesta.desempeno_equipo + encuesta.presentacion_equipo + encuesta.calidad_productos + encuesta.calidad_entrenamientos) / 5).toFixed(1)}/5</span></div>
        </div>
        ${encuesta.comentario ? `<div class="px-4 pb-4 text-sm"><span class="text-gray-500">Comentario:</span><br><span class="italic">"${escHtml2(encuesta.comentario)}"</span></div>` : ''}
      </div>` : ''}

      <!-- TIMELINE -->
      <div class="border border-gray-200 rounded-xl overflow-hidden">
        <div class="bg-gray-50 px-4 py-2.5 border-b border-gray-200 font-semibold text-gray-700 flex items-center gap-2"><span>📅</span> Timeline</div>
        <div class="p-4">
          <div class="relative border-l-2 border-blue-200 ml-3 space-y-4">
            ${[ 
              { label: 'Creada', date: ot.creado_en },
              { label: 'Programada', date: ot.fecha_programada },
              { label: 'Iniciada', date: ot.fecha_inicio },
              { label: 'Finalizada', date: ot.fecha_fin },
              { label: 'Última actualización', date: ot.actualizado_en }
            ].filter(t => t.date).map(t => `
              <div class="relative pl-6">
                <div class="absolute -left-[11px] top-1 w-5 h-5 bg-blue-600 rounded-full border-2 border-white"></div>
                <p class="text-sm font-medium text-gray-700">${t.label}</p>
                <p class="text-xs text-gray-400">${t.date}</p>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

    </div>
  </div>

  <div class="text-center text-gray-400 text-xs pb-4">
    ${escHtml2(cfgDoc.nombre_empresa)} &bull; Generado el ${new Date().toLocaleDateString('es-DO', { year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' })}
  </div>
</div>
</body>
</html>`;

    res.send(html);
  } catch (e) {
    console.error('Error rendering OT detail page:', e);
    res.status(500).send('Error interno');
  }
});

// ============ FLUJO CONFIRMACION OT (ENDPOINTS PUBLICOS CON TOKEN) ============

// Pagina publica para cambio de fecha
app.get('/cambio-fecha', function(req, res) {
  res.sendFile(path.join(__dirname, '..', 'public', 'cambio-fecha.html'));
});

// Endpoint publico: Confirmar fecha (token de un solo uso)
app.get('/api/confirmar-ot/:token', async function(req, res) {
  try {
    await getDb();
    var token = req.params.token;
    var row = queryFirst('SELECT * FROM confirmacion_tokens WHERE token = ? AND tipo = ? AND usado = 0 AND expira_en > datetime(\'now\', \'-04:00\')', [token, 'confirmar_fecha']);

    if (!row) {
      return res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Enlace inválido</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial,sans-serif;background:#f4f4f4;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px}.card{max-width:480px;background:white;border-radius:12px;padding:32px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.1)}.icon{font-size:48px;margin-bottom:12px}h2{color:#333;margin:0 0 8px}p{color:#666;font-size:14px;line-height:1.5}</style></head><body><div class="card"><div class="icon">&#10060;</div><h2>Enlace inválido o expirado</h2><p>Este enlace de confirmaci&oacute;n ya fue usado o ha expirado. Contacta a tu administrador si necesitas ayuda.</p></div></body></html>');
    }

    // Marcar token como usado y actualizar OT
    run('UPDATE confirmacion_tokens SET usado = 1 WHERE id = ?', [row.id]);
    run("UPDATE ordenes_trabajo SET estado = 'en_curso', fecha_inicio = datetime('now', '-04:00'), actualizado_en = datetime('now', '-04:00') WHERE id = ?", [row.orden_trabajo_id]);

    var ot = queryFirst('SELECT ot.numero_ot, c.nombre as cliente_nombre FROM ordenes_trabajo ot JOIN clientes c ON ot.cliente_id = c.id WHERE ot.id = ?', [row.orden_trabajo_id]);

    // Notificar admins
    var admins = queryAll("SELECT email FROM usuarios WHERE (rol = 'admin' OR rol = 'superadmin') AND activo = 1 AND email IS NOT NULL");
    var adminEmails = admins.map(function(a) { return a.email; }).filter(Boolean);

    if (adminEmails.length > 0) {
      var dashUrl = process.env.DASHBOARD_URL || 'https://ot-dashboard-xje7.onrender.com';
      var htmlNotif = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;padding:20px"><div style="max-width:600px;margin:0 auto;background:white;border-radius:12px;padding:24px"><h2 style="color:#16a34a">&#9989; Fecha Confirmada por T&eacute;cnico</h2><p>El t&eacute;cnico ha <strong style="color:#16a34a">confirmado la fecha</strong> para la OT <strong>' + escHtml(ot.numero_ot) + '</strong>.</p><p>La OT ha pasado autom&aacute;ticamente a <strong>En Curso</strong>.</p><a href="' + escHtml(dashUrl) + '/orden/' + row.orden_trabajo_id + '" style="display:inline-block;background:#1d4ed8;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold">Ver OT</a></div></body></html>';
      enviarEmail({ to: adminEmails, subject: '✅ Fecha confirmada - OT ' + ot.numero_ot, html: htmlNotif }).catch(function(e) {
        console.error('Error notificando admins:', e.message);
      });
    }

    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }

    var cliente = ot ? escHtml(ot.cliente_nombre) : '';
    var numOT = ot ? escHtml(ot.numero_ot) : '';

    res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fecha Confirmada</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial,sans-serif;background:#f4f4f4;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px}.card{max-width:480px;background:white;border-radius:12px;padding:32px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.1)}.icon{font-size:56px;margin-bottom:12px}h2{color:#16a34a;margin:0 0 8px}p{color:#555;font-size:15px;line-height:1.5;margin:4px 0}.detail{color:#666;font-size:13px;margin-top:16px}</style></head><body><div class="card"><div class="icon">&#9989;</div><h2>&iexcl;Fecha Confirmada!</h2><p>La Orden de Trabajo <strong>' + numOT + '</strong> ha pasado a <strong>En Curso</strong>.</p><p class="detail">Cliente: ' + cliente + '<br>Los administradores han sido notificados.</p></div></body></html>');
  } catch (e) {
    console.error('Error en confirmar-ot:', e);
    res.status(500).send('Error interno');
  }
});

// Endpoint publico: Mostrar formulario de cambio de fecha (redirect a pagina)
app.get('/api/solicitar-cambio-ot/:token', async function(req, res) {
  try {
    await getDb();
    var token = req.params.token;
    var row = queryFirst('SELECT * FROM confirmacion_tokens WHERE token = ? AND tipo = ? AND usado = 0 AND expira_en > datetime(\'now\', \'-04:00\')', [token, 'solicitar_cambio']);

    if (!row) {
      return res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Enlace inválido</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial,sans-serif;background:#f4f4f4;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px}.card{max-width:480px;background:white;border-radius:12px;padding:32px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.1)}.icon{font-size:48px;margin-bottom:12px}h2{color:#333;margin:0 0 8px}p{color:#666;font-size:14px}</style></head><body><div class="card"><div class="icon">&#10060;</div><h2>Enlace inválido o expirado</h2><p>Este enlace ya fue usado o ha expirado.</p></div></body></html>');
    }

    var ot = queryFirst('SELECT ot.numero_ot, u.nombre as tecnico_nombre FROM ordenes_trabajo ot JOIN usuarios u ON ot.tecnico_id = u.id WHERE ot.id = ?', [row.orden_trabajo_id]);
    var numOT = ot ? escHtml(ot.numero_ot) : 'desconocida';

    // Redirigir a pagina publica con el token en query param
    res.redirect('/cambio-fecha.html?token=' + encodeURIComponent(token) + '&ot=' + encodeURIComponent(numOT));
  } catch (e) {
    console.error('Error en solicitar-cambio-ot:', e);
    res.status(500).send('Error interno');
  }
});

// Endpoint publico: Procesar cambio de fecha (POST)
app.post('/api/solicitar-cambio-ot/:token', async function(req, res) {
  try {
    await getDb();
    var token = req.params.token;
    var nuevaFecha = req.body.fecha;

    if (!nuevaFecha) {
      return res.status(400).json({ error: 'Fecha requerida' });
    }

    var row = queryFirst('SELECT * FROM confirmacion_tokens WHERE token = ? AND tipo = ? AND usado = 0 AND expira_en > datetime(\'now\', \'-04:00\')', [token, 'solicitar_cambio']);

    if (!row) {
      return res.status(400).json({ error: 'Token invalido o expirado' });
    }

    // Marcar token como usado y guardar fecha propuesta
    run('UPDATE confirmacion_tokens SET usado = 1, fecha_propuesta = ? WHERE id = ?', [nuevaFecha, row.id]);

    var ot = queryFirst('SELECT ot.numero_ot, u.nombre as tecnico_nombre FROM ordenes_trabajo ot JOIN usuarios u ON ot.tecnico_id = u.id WHERE ot.id = ?', [row.orden_trabajo_id]);
    var tecnicoNombre = ot ? ot.tecnico_nombre : 'Técnico';

    // Notificar a admins
    await enviarNotificacionCambioFecha(row.orden_trabajo_id, nuevaFecha, tecnicoNombre);

    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }

    res.json({ success: true, message: 'Solicitud enviada' });
  } catch (e) {
    console.error('Error procesando cambio fecha:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============ FRONTEND (SPA) ============
// Página pública de aval
app.get('/aval-publico/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'aval-publico.html'));
});

// Para SPA: servir index.html en todas las rutas excepto API y archivos estáticos
app.get(/^\/(?!api\/|uploads\/|orden\/|aval-publico\/|cambio-fecha\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});








// ============ LIMPIAR SOLO OT, AVALES, ENCUESTAS (mantiene clientes, productos, usuarios) ============
app.post('/api/limpiar-ots', authMiddleware, superAdminOnly, (req, res) => {
  try {
    transaction(() => {
      const tables = ['orden_trabajo_productos','avales_legacy','encuestas_satisfaccion','avales','aval_productos','ordenes_trabajo','presupuestos','reportes_incentivos'];
      for (const t of tables) {
        try { run('DELETE FROM ' + t); } catch(e) { console.warn('No se pudo limpiar ' + t); }
      }
      try { run('DELETE FROM sqlite_sequence WHERE name IN ("ordenes_trabajo","presupuestos","avales","avales_legacy","encuestas_satisfaccion")'); } catch(e) {}
    });
    // Exportar backup inmediatamente
    try { exportDatabase(); } catch(e) { console.error('Backup error:', e.message); }
    console.log('🧹 OTs, avales y encuestas limpiados por:', req.user.email);
    res.json({ success: true, message: 'OTs, avales y encuestas eliminados. Clientes, productos y usuarios intactos.' });
  } catch (e) {
    console.error('Error limpiando OTs:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ LIMPIEZA DE BD (admin only) ============
app.post('/api/limpiar-bd', authMiddleware, superAdminOnly, (req, res) => {
  try {
    transaction(() => {
      const tables = ['orden_trabajo_productos','avales_legacy','encuestas_satisfaccion','avales','aval_productos','ordenes_trabajo','presupuestos','reportes_incentivos','configuracion_incentivos','configuracion_documentos','productos','clientes'];
      for (const t of tables) {
        try { run('DELETE FROM ' + t); } catch(e) { console.warn('No se pudo limpiar ' + t); }
      }
      try { run('DELETE FROM usuarios WHERE email != "admin@sistema.com"'); } catch(e) {}
      try { run('DELETE FROM sqlite_sequence'); } catch(e) {}
    });
    // Tambien limpiar el backup y marcar que fue limpieza intencional
    try {
      const BACKUP_FILE = require('path').join(__dirname, '..', 'data', 'backup.json');
      require('fs').writeFileSync(BACKUP_FILE, '{}', 'utf-8');
      const LIMPIADO_FILE = require('path').join(__dirname, '..', 'data', '.limpiado');
      require('fs').writeFileSync(LIMPIADO_FILE, new Date().toISOString(), 'utf-8');
    } catch(e) { console.warn('No se pudo limpiar backup:', e.message); }
    console.log('🧹 BD limpiada por admin:', req.user.email);
    res.json({ success: true, message: 'BD limpiada. Datos demo eliminados correctamente.' });
    // Ya no reiniciamos el servidor — la BD esta limpia y el backup tambien
    // Asi evitamos el Bad Gateway y el ciclo de restauracion
  } catch (e) {
    console.error('Error limpiando BD:', e);
    res.status(500).json({ error: e.message });
  }
});


// Endpoint para forzar exportacion de backup
app.post('/api/exportar-backup', authMiddleware, adminOnly, (req, res) => {
  try {
    exportDatabase();
    res.json({ success: true, message: 'Backup exportado correctamente' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Descargar backup como JSON (accesible con X-Backup-Token desde GitHub Action)
app.get('/api/export-backup', (req, res) => {
  try {
    // Permitir acceso con token de backup (GitHub Action) o auth normal
    const backupToken = req.headers['x-backup-token'];
    const envToken = process.env.BACKUP_TOKEN || '';
    if (backupToken && envToken && backupToken === envToken) {
      // Token válido, continuar
    } else if (!req.headers.authorization) {
      return res.status(401).json({ error: 'No autorizado. Usa X-Backup-Token o Authorization header.' });
    } else {
      // Verificar auth normal
      const token = req.headers.authorization.split(' ')[1];
      const decoded = verificarToken(token);
      if (!decoded || (decoded.rol !== 'admin' && decoded.rol !== 'superadmin')) {
        return res.status(403).json({ error: 'Acceso denegado' });
      }
    }

    const BACKUP_FILE = require('path').join(__dirname, '..', 'data', 'backup.json');
    if (!require('fs').existsSync(BACKUP_FILE)) {
      return res.status(404).json({ error: 'No hay backup disponible.' });
    }
    const backup = JSON.parse(require('fs').readFileSync(BACKUP_FILE, 'utf-8'));
    res.json(backup);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Descargar backup.json como archivo (para GitHub Action que lo commitea)
app.get('/api/export-backup/download', (req, res) => {
  try {
    // Misma lógica de auth que /api/export-backup
    const backupToken = req.headers['x-backup-token'];
    const envToken = process.env.BACKUP_TOKEN || '';
    if (backupToken && envToken && backupToken === envToken) {
      // Token válido
    } else if (!req.headers.authorization) {
      return res.status(401).json({ error: 'No autorizado. Usa X-Backup-Token o Authorization header.' });
    } else {
      const token = req.headers.authorization.split(' ')[1];
      const decoded = verificarToken(token);
      if (!decoded || (decoded.rol !== 'admin' && decoded.rol !== 'superadmin')) {
        return res.status(403).json({ error: 'Acceso denegado' });
      }
    }

    const BACKUP_FILE = require('path').join(__dirname, '..', 'data', 'backup.json');
    if (!require('fs').existsSync(BACKUP_FILE)) {
      return res.status(404).json({ error: 'No hay backup disponible.' });
    }

    const backup = require('fs').readFileSync(BACKUP_FILE, 'utf-8');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="backup.json"');
    res.send(backup);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint para deploy hook — regenera backup y lo exporta
// Acepta X-Backup-Token, Authorization normal (Bearer de admin), o no requiere token
app.post('/api/deploy-hook', (req, res) => {
  try {
    const backupToken = req.headers['x-backup-token'];
    const envToken = process.env.BACKUP_TOKEN || '';
    let authorized = false;
    if (backupToken && envToken && backupToken === envToken) {
      authorized = true;
    } else if (req.headers.authorization) {
      const token = req.headers.authorization.split(' ')[1];
      const decoded = verificarToken(token);
      if (decoded && (decoded.rol === 'admin' || decoded.rol === 'superadmin')) {
        authorized = true;
      }
    }
    if (!authorized) {
      return res.status(401).json({ error: 'No autorizado. Usa X-Backup-Token o Authorization header.' });
    }
    exportDatabase();
    res.json({ success: true, message: 'Backup regenerado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mantener endpoint legacy con authMiddleware para compatibilidad
app.get('/api/exportar-backup', authMiddleware, adminOnly, (req, res) => {
  try {
    const BACKUP_FILE = require('path').join(__dirname, '..', 'data', 'backup.json');
    if (!require('fs').existsSync(BACKUP_FILE)) {
      return res.status(404).json({ error: 'No hay backup disponible.' });
    }
    const backup = JSON.parse(require('fs').readFileSync(BACKUP_FILE, 'utf-8'));
    res.json(backup);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint de prueba de email (diagnostico)
app.post('/api/test-email', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { to, subject } = req.body;
    const destino = to || req.user.email;
    const result = await enviarEmail({
      to: destino,
      subject: subject || 'Prueba SMTP - OT Dashboard',
      html: '<h2>Prueba de SMTP</h2><p>Si recibes esto, el servidor SMTP esta funcionando correctamente.</p><p>Timestamp: ' + new Date().toISOString() + '</p>'
    });
    res.json({ success: result.success, message: result.success ? 'Email enviado a ' + destino : 'Error: ' + result.error });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnostico de env vars email
const https = require('https');
app.get('/api/diag-conexion', authMiddleware, adminOnly, (req, res) => {
  const targets = [
    { host: 'api.sendgrid.com', path: '/v3/mail/send', method: 'OPTIONS' },
    { host: 'smtp.sendgrid.net', path: '/', method: 'GET' },
    { host: 'google.com', path: '/', method: 'GET' },
  ];
  let i = 0;
  const results = {};
  targets.forEach(t => {
    const start = Date.now();
    const r = https.request({ hostname: t.host, path: t.path, method: t.method, timeout: 5000 }, (resp) => {
      results[t.host] = 'RESPONDE (status ' + resp.statusCode + ') en ' + (Date.now() - start) + 'ms';
      i++; if (i === targets.length) res.json(results);
    });
    r.on('error', (e) => { results[t.host] = 'ERROR: ' + e.message; i++; if (i === targets.length) res.json(results); });
    r.on('timeout', () => { r.destroy(); results[t.host] = 'TIMEOUT (5s)'; i++; if (i === targets.length) res.json(results); });
    r.end();
  });
});

app.get('/api/diag-email', authMiddleware, adminOnly, (req, res) => {
  res.json({
    SENDGRID_API_KEY: process.env.SENDGRID_API_KEY ? 'CONFIGURADA' : 'NO CONFIGURADA',
    SMTP_USER: process.env.SMTP_USER || 'NO CONFIGURADO',
    SMTP_HOST: process.env.SMTP_HOST || 'default: smtp.gmail.com',
    SMTP_PORT: process.env.SMTP_PORT || 'default: 587',
    SMTP_FROM_USADO: 'a.plasencia@grupoarboleda.com (fijo en codigo)',
  });
});

// Endpoint para ver los admins que recibirian notificaciones
app.get('/api/diag-admins-email', authMiddleware, adminOnly, (req, res) => {
  try {
    const admins = queryAll("SELECT id, nombre, email, rol FROM usuarios WHERE (rol = 'admin' OR rol = 'superadmin') AND email IS NOT NULL AND email != ''");
    const tecnicos = queryAll("SELECT id, nombre, email, rol FROM usuarios WHERE rol = 'tecnico' AND email IS NOT NULL AND email != ''");
    res.json({
      admins_notificacion: admins,
      tecnicos_disponibles: tecnicos,
      total_admins: admins.length,
      total_tecnicos: tecnicos.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════
// AVAL PÚBLICO — enlace para compartir con cliente
// ═══════════════════════════════════════════════

// GET /api/avales/public/:token — datos públicos del aval (sin auth)
app.get('/api/avales/public/:token', (req, res) => {
  try {
    const aval = queryFirst(`
      SELECT a.id, a.numero_aval, a.orden_trabajo_id, a.cliente_nombre, a.cliente_contacto,
        a.cliente_telefono, a.observaciones, a.estado, a.fecha_firma_cliente,
        ot.numero_ot, ot.descripcion,
        u.nombre as tecnico_nombre, u.telefono as tecnico_telefono
      FROM avales a
      JOIN ordenes_trabajo ot ON a.orden_trabajo_id = ot.id
      LEFT JOIN usuarios u ON a.tecnico_id = u.id
      WHERE a.token_publico = ?
    `, [req.params.token]);

    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });

    // Item 8: Verificar expiración del token (30 días)
    if (aval.token_enviado_en && !aval.fecha_firma_cliente && aval.estado !== 'confirmado') {
      const fechaEnvio = new Date(aval.token_enviado_en + 'Z');
      const ahora = new Date();
      const diasTranscurridos = (ahora - fechaEnvio) / (1000 * 60 * 60 * 24);
      if (diasTranscurridos > 30) {
        return res.status(410).json({
          error: 'Token expirado',
          expirado: true,
          fecha_envio: aval.token_enviado_en,
          dias_transcurridos: Math.floor(diasTranscurridos)
        });
      }
    }

    // Marcar como visto
    if (!aval.fecha_firma_cliente) {
      run("UPDATE avales SET token_visto_en = datetime('now', '-04:00') WHERE token_publico = ?", [req.params.token]);
    }

    const productos = queryAll(`
      SELECT ap.*, p.nombre as producto_nombre
      FROM aval_productos ap
      JOIN productos p ON ap.producto_id = p.id
      WHERE ap.aval_id = ?
    `, [aval.id]);

    res.json({ aval, productos });
  } catch (e) {
    console.error('Error fetching public aval:', e);
    res.status(500).json({ error: 'Error al obtener aval' });
  }
});

// POST /api/avales/public/:token/firmar — cliente firma el aval (con re-firma + historial)
app.post('/api/avales/public/:token/firmar', (req, res) => {
  try {
    const aval = queryFirst('SELECT id, estado, firma_cliente_data, historial_firmas FROM avales WHERE token_publico = ?', [req.params.token]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });
    if (aval.estado === 'confirmado' || aval.estado === 'rechazado') {
      return res.status(400).json({ error: 'Este aval ya fue procesado' });
    }

    const { firma_data, nombre_cliente } = req.body;
    if (!firma_data) return res.status(400).json({ error: 'Firma requerida' });

    // Item 7: Guardar historial de firmas
    var historial = [];
    try {
      if (aval.historial_firmas) historial = JSON.parse(aval.historial_firmas);
      if (!Array.isArray(historial)) historial = [];
    } catch(e) { historial = []; }
    
    if (aval.firma_cliente_data) {
      historial.push({
        firma_anterior: aval.firma_cliente_data,
        fecha_anterior: queryFirst('SELECT fecha_firma_cliente FROM avales WHERE id = ?', [aval.id])?.fecha_firma_cliente,
        re_firmado_en: new Date().toISOString()
      });
    }

    run(`UPDATE avales SET 
      firma_cliente_data = ?,
      fecha_firma_cliente = datetime('now', '-04:00'),
      estado = 'firmado_cliente',
      cliente_nombre = COALESCE(?, cliente_nombre),
      historial_firmas = ?
      WHERE id = ?
    `, [JSON.stringify(firma_data), nombre_cliente || null, JSON.stringify(historial), aval.id]);

    res.json({ message: 'Aval firmado por el cliente' });
    try { exportDatabase(); } catch(e) {}

    // Item 4: Notificar a admins que el cliente firmó
    try {
      const { enviarNotificacionFirmaCliente } = require('./email');
      enviarNotificacionFirmaCliente(aval.id).catch(function(err) {
        console.error('Error notificando firma cliente:', err);
      });
    } catch(e) {}
  } catch (e) {
    console.error('Error signing aval:', e);
    res.status(500).json({ error: 'Error al firmar aval' });
  }
});

// POST /api/avales/:id/enviar — envía el enlace del aval por email o prepara para WhatsApp
app.post('/api/avales/:id/enviar', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const aval = queryFirst('SELECT a.*, ot.numero_ot, c.nombre as cliente_nombre, c.email as cliente_email, c.telefono as cliente_telefono FROM avales a JOIN ordenes_trabajo ot ON a.orden_trabajo_id = ot.id LEFT JOIN clientes c ON ot.cliente_id = c.id WHERE a.id = ?', [id]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });

    let token = aval.token_publico;
    if (!token) {
      const crypto = require('crypto');
      token = crypto.randomBytes(16).toString('hex');
      run('UPDATE avales SET token_publico = ?, token_enviado_en = datetime(\'now\', \'-04:00\') WHERE id = ?', [token, id]);
    }

    const dashUrl = process.env.DASHBOARD_URL || 'https://ot-dashboard-xje7.onrender.com';
    const publicUrl = dashUrl + '/aval-publico/' + token;
    const { metodo, destinatario } = req.body;

    if (metodo === 'email') {
      if (!destinatario) return res.status(400).json({ error: 'Debes especificar un correo' });
      const { enviarNotificacionAval } = require('./email');
      // Forzar envío al destinatario especificado
      await enviarNotificacionAval(id, destinatario);
      res.json({ message: '✅ Enlace enviado por email a ' + destinatario, url: publicUrl, token: token });
    } else if (metodo === 'whatsapp') {
      if (!destinatario) return res.status(400).json({ error: 'Debes especificar un número' });
      const telefono = destinatario.replace(/[^\d]/g, '');
      const waUrl = 'https://wa.me/' + telefono + '?text=' + encodeURIComponent('Hola, aquí está el enlace para firmar el aval de instalación.\n\nOT: ' + aval.numero_ot + '\nAval: ' + aval.numero_aval + '\n\n' + publicUrl);
      res.json({ message: '✅ Enlace listo para WhatsApp', whatsapp_url: waUrl, url: publicUrl, token: token });
    } else {
      return res.status(400).json({ error: 'Método no válido. Usa "email" o "whatsapp"' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/avales/:id/compartir — genera/comparte enlace público (legacy)
app.post('/api/avales/:id/compartir', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const aval = queryFirst('SELECT * FROM avales WHERE id = ?', [id]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });

    let token = aval.token_publico;
    const renovar = req.query.renovar === 'true';
    if (!token || renovar) {
      const crypto = require('crypto');
      const tokenAnterior = token;
      token = crypto.randomBytes(16).toString('hex');
      run('UPDATE avales SET token_publico = ?, token_enviado_en = datetime(\'now\', \'-04:00\') WHERE id = ?', [token, id]);
      if (renovar) {
        console.log('Token renovado para aval ' + id + ': anterior=' + tokenAnterior + ' nuevo=' + token);
      }
    }

    const dashUrl = process.env.DASHBOARD_URL || 'https://ot-dashboard-xje7.onrender.com';
    const publicUrl = dashUrl + '/aval-publico/' + token;

    res.json({
      message: 'Enlace generado',
      url: publicUrl,
      token: token,
      numero_aval: aval.numero_aval
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/avales/:id/compartir — ver enlace existente
app.get('/api/avales/:id/compartir', authMiddleware, (req, res) => {
  try {
    const aval = queryFirst('SELECT id, numero_aval, token_publico, token_enviado_en, token_visto_en, fecha_firma_cliente FROM avales WHERE id = ?', [Number(req.params.id)]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });

    const dashUrl = process.env.DASHBOARD_URL || 'https://ot-dashboard-xje7.onrender.com';
    res.json({
      numero_aval: aval.numero_aval,
      enlace: aval.token_publico ? dashUrl + '/aval-publico/' + aval.token_publico : null,
      token_enviado_en: aval.token_enviado_en,
      token_visto_en: aval.token_visto_en,
      fecha_firma: aval.fecha_firma_cliente,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════
// CRON JOB: Timer de encuestas (cada hora)
// ═══════════════════════════════════════════════
function iniciarCronEncuestas() {
  const INTERVALO = 60 * 60 * 1000; // cada hora

  async function verificarEncuestas() {
    try {
      const hoy = new Date().toISOString().split('T')[0];
      console.log(`⏰ Cron: Verificando encuestas pendientes (${hoy})...`);

      const pendientes = queryAll(`
        SELECT e.*, ot.numero_ot, ot.cliente_id, c.nombre as cliente_nombre, c.email as cliente_email, c.telefono as cliente_telefono,
          a.numero_aval, a.cliente_nombre as aval_cliente_nombre, a.cliente_telefono as aval_cliente_telefono, a.cliente_email as aval_cliente_email
        FROM encuestas_satisfaccion e
        JOIN ordenes_trabajo ot ON e.orden_trabajo_id = ot.id
        JOIN clientes c ON ot.cliente_id = c.id
        LEFT JOIN avales a ON e.aval_id = a.id
        WHERE e.estado = 'pendiente' AND e.fecha_limite IS NOT NULL
      `);

      for (const enc of pendientes) {
        if (!enc.fecha_limite) continue;

        const diasRestantes = diasHabilesEntre(hoy, enc.fecha_limite);
        const fechaLim = new Date(enc.fecha_limite + 'T12:00:00-04:00');
        const hoyDate = new Date();
        const diffTime = fechaLim.getTime() - hoyDate.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        // Caso 1: Expirada (fecha_limite pasó)
        if (enc.fecha_limite < hoy && enc.estado === 'pendiente') {
          run('UPDATE encuestas_satisfaccion SET estado = ? WHERE id = ?', ['expirada', enc.id]);
          console.log(`⚠️ Encuesta #${enc.id} (OT ${enc.numero_ot}) marcada como expirada`);

          // Enviar alerta a admin
          const dashUrl = process.env.DASHBOARD_URL || 'https://ot-dashboard-xje7.onrender.com';
          const adminEmails = queryAll("SELECT email FROM usuarios WHERE rol IN ('admin','superadmin') AND email IS NOT NULL");
          const scEmails = queryAll("SELECT email FROM usuarios WHERE rol = 'servicio_cliente' AND email IS NOT NULL");
          const recipients = [...adminEmails.map(a => a.email), ...scEmails.map(s => s.email)].filter(Boolean);

          if (recipients.length > 0) {
            const { enviarEmail: enviarEmailCron } = require('./email');
            const emailCliente = enc.aval_cliente_email || enc.cliente_email || '';
            const emailContacto = enc.aval_cliente_email || enc.cliente_email || '';
            enviarEmailCron({
              to: recipients,
              subject: `⚠️ Encuesta expirada para OT ${enc.numero_ot} — contactar al cliente`,
              html: `<h2>Encuesta Expirada</h2>
                <p><strong>OT:</strong> ${enc.numero_ot}</p>
                <p><strong>Cliente:</strong> ${enc.cliente_nombre}</p>
                <p><strong>Fecha Límite:</strong> ${enc.fecha_limite}</p>
                <p><strong>Días vencido:</strong> ${Math.abs(diffDays)}</p>
                <p><strong>Email cliente:</strong> ${emailContacto || 'No registrado'}</p>
                <p><strong>Teléfono cliente:</strong> ${enc.aval_cliente_telefono || enc.cliente_telefono || 'No registrado'}</p>
                <p><a href="${dashUrl}">Ir al Dashboard</a></p>`
            }).catch(err => console.error('Error email expirada:', err));
          }
          continue;
        }

        // Caso 2: Recordatorio 2 (fecha_limite - today == 0 días hábiles, o diffDays <= 0)
        if (diffDays <= 0 && enc.recordatorio_2_enviado === 0) {
          run('UPDATE encuestas_satisfaccion SET recordatorio_2_enviado = 1 WHERE id = ?', [enc.id]);
          console.log(`⏰ Recordatorio 2 enviado para encuesta #${enc.id} (OT ${enc.numero_ot})`);

          const dashUrl = process.env.DASHBOARD_URL || 'https://ot-dashboard-xje7.onrender.com';
          const adminEmails = queryAll("SELECT email FROM usuarios WHERE rol IN ('admin','superadmin') AND email IS NOT NULL");
          const scEmails = queryAll("SELECT email FROM usuarios WHERE rol = 'servicio_cliente' AND email IS NOT NULL");
          const recipients = [...adminEmails.map(a => a.email), ...scEmails.map(s => s.email)].filter(Boolean);

          if (recipients.length > 0) {
            const { enviarEmail: enviarEmailCron } = require('./email');
            enviarEmailCron({
              to: recipients,
              subject: `⏰ Cliente no ha respondido encuesta — OT ${enc.numero_ot}`,
              html: `<h2>Recordatorio: Cliente no ha respondido la encuesta</h2>
                <p><strong>OT:</strong> ${enc.numero_ot}</p>
                <p><strong>Cliente:</strong> ${enc.cliente_nombre}</p>
                <p><strong>Fecha Límite:</strong> ${enc.fecha_limite}</p>
                <p><strong>Teléfono:</strong> ${enc.aval_cliente_telefono || enc.cliente_telefono || 'No registrado'}</p>
                <p><a href="${dashUrl}">Ir al Dashboard</a></p>`
            }).catch(err => console.error('Error email recordatorio 2:', err));
          }
          continue;
        }

        // Caso 3: Recordatorio 1 (al menos 1 día hábil antes del vencimiento)
        if (diffDays >= 1 && enc.recordatorio_1_enviado === 0) {
          // Enviar recordatorio al cliente
          run(`UPDATE encuestas_satisfaccion SET recordatorio_1_enviado = 1 WHERE id = ${enc.id}`);

          const dashUrl = process.env.DASHBOARD_URL || 'https://ot-dashboard-xje7.onrender.com';
          const encuestaUrl = `${dashUrl}/encuesta-publica/${enc.token_publico}`;
          const emailCliente = enc.aval_cliente_email || enc.cliente_email;

          if (emailCliente) {
            const { enviarEmail: enviarEmailCron2 } = require('./email');
            enviarEmailCron2({
              to: [emailCliente],
              subject: 'Tu opinión nos importa — completa la encuesta de satisfacción',
              html: `<h2>¿Cómo fue tu experiencia?</h2>
                <p>Hola <strong>${enc.cliente_nombre}</strong>,</p>
                <p>Queremos conocer tu opinión sobre el servicio recibido en la Orden de Trabajo <strong>${enc.numero_ot}</strong>.</p>
                <p>Tu feedback nos ayuda a mejorar.</p>
                <a href="${encuestaUrl}" style="display:inline-block;background:#2563eb;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Completar Encuesta</a>
                <p style="color:#999;font-size:12px;margin-top:16px">Este enlace expirará el ${enc.fecha_limite}.</p>`
            }).catch(err => console.error('Error email recordatorio 1:', err));
            console.log(`📧 Recordatorio 1 enviado a ${emailCliente} para encuesta #${enc.id}`);
          }
        }
      }
    } catch (e) {
      console.error('Error en cron de encuestas:', e);
    }
  }

  // Ejecutar inmediatamente al iniciar, luego cada hora
  verificarEncuestas();
  setInterval(verificarEncuestas, INTERVALO);
  console.log('⏰ Cron de encuestas iniciado (cada hora)');

  // ═══════════════════════════════════════════════════════════
  // CRON: Penalidad 48h para avales sin firmar
  // ═══════════════════════════════════════════════════════════
  function verificarAvalesPendientes() {
    try {
      const ahora = new Date();
      const dashUrl = process.env.DASHBOARD_URL || 'https://ot-dashboard-xje7.onrender.com';

      const avalesVencidos = queryAll(`
        SELECT a.id, a.orden_trabajo_id, a.estado, a.fecha_entrega_tecnico,
               a.cliente_nombre, a.cliente_telefono, a.cliente_email,
               a.historial_reconsideracion,
               o.numero_ot, o.tecnico_id,
               u.nombre as tecnico_nombre, u.email as tecnico_email, u.telefono as tecnico_telefono
        FROM avales a
        JOIN ordenes_trabajo o ON a.orden_trabajo_id = o.id
        LEFT JOIN usuarios u ON o.tecnico_id = u.id
        WHERE a.estado IN ('pendiente', 'firmado_cliente')
        AND a.fecha_entrega_tecnico IS NOT NULL
        ORDER BY a.fecha_entrega_tecnico ASC
      `);

      for (const aval of avalesVencidos) {
        const fechaEntrega = new Date(aval.fecha_entrega_tecnico + 'Z');
        const diffMs = ahora.getTime() - fechaEntrega.getTime();
        const diffHoras = diffMs / (1000 * 60 * 60);

        if (diffHoras > 48) {
          const diasExtra = Math.floor((diffHoras - 48) / 24) + 1;
          const penalidadDiaria = Math.min(diasExtra * 5, 100);

          console.log(`⚠️ Aval #${aval.id} (OT ${aval.numero_ot}) — ${diasExtra}d sin firmar, penalidad ${penalidadDiaria}%`);

          var historial = [];
          try {
            if (aval.historial_reconsideracion) {
              historial = JSON.parse(aval.historial_reconsideracion);
              if (!Array.isArray(historial)) historial = [];
            }
          } catch(e) { historial = []; }

          historial.push({
            tipo: 'penalidad_firma',
            dias_sin_firmar: diasExtra,
            penalidad_porcentaje: penalidadDiaria,
            fecha: ahora.toISOString()
          });

          run(`UPDATE avales SET historial_reconsideracion=? WHERE id=?`,
            [JSON.stringify(historial), aval.id]);

          // Alerta al técnico
          if (aval.tecnico_email) {
            const { enviarEmail: alertaEmail } = require('./email');
            alertaEmail({
              to: [aval.tecnico_email],
              subject: `⚠️ PENALIDAD — Aval #${aval.id} sin firmar (${diasExtra}d) — ${penalidadDiaria}% de bono`,
              html: `<h2>⚠️ Alerta de Penalidad por Firma Pendiente</h2>
                <p><strong>OT:</strong> ${aval.numero_ot}</p>
                <p><strong>Cliente:</strong> ${aval.cliente_nombre}</p>
                <p><strong>Teléfono:</strong> ${aval.cliente_telefono || 'N/A'}</p>
                <p><strong>Días sin firmar:</strong> ${diasExtra}</p>
                <p><strong>Penalidad acumulada:</strong> -${penalidadDiaria}% del bono</p>
                <p style="color:red;font-weight:bold">Gestiona la firma del cliente lo antes posible para evitar más penalidad.</p>
                <p><a href="${dashUrl}">Ir al Dashboard</a></p>`
            }).catch(err => console.error('Error email penalidad 48h:', err));
          }

          // Alerta a admin/lider
          const adminEmails = queryAll("SELECT email FROM usuarios WHERE (rol='admin' OR rol='superadmin' OR rol='lider') AND email IS NOT NULL");
          const recipients = adminEmails.map(a => a.email).filter(Boolean);
          if (recipients.length > 0) {
            const { enviarEmail: alertaAdmin } = require('./email');
            alertaAdmin({
              to: recipients,
              subject: `🚨 ALERTA: Aval #${aval.id} (OT ${aval.numero_ot}) sin firmar — penalidad activa`,
              html: `<h2>🚨 Aval sin firma superó 48h</h2>
                <p><strong>OT:</strong> ${aval.numero_ot}</p>
                <p><strong>Aval ID:</strong> ${aval.id}</p>
                <p><strong>Técnico:</strong> ${aval.tecnico_nombre || 'N/A'} ${aval.tecnico_telefono ? '('+aval.tecnico_telefono+')' : ''}</p>
                <p><strong>Cliente:</strong> ${aval.cliente_nombre}</p>
                <p><strong>Días sin firmar:</strong> ${diasExtra}</p>
                <p><strong>Penalidad:</strong> -${penalidadDiaria}% del bono</p>
                <p><em>El técnico fue notificado por email. El administrador puede hacer confirmación express para detener la penalidad.</em></p>
                <p><a href="${dashUrl}">Ir al Dashboard</a></p>`
            }).catch(err => console.error('Error email alerta admin 48h:', err));
          }
        }
      }
    } catch (e) {
      console.error('Error en cron de avales pendientes:', e);
    }
  }

  // Ejecutar inmediatamente al iniciar, luego cada hora
  verificarAvalesPendientes();
  setInterval(verificarAvalesPendientes, INTERVALO);
  console.log('⏰ Cron de avales sin firma iniciado (cada hora)');
}

start();
