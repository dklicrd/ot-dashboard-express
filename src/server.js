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
const { initDatabase } = require('./init-db');
const { authMiddleware, adminOnly, superAdminOnly, generarToken, verificarToken } = require('./auth');
const { exportDatabase } = require('./backup-restore');
const { generarAvalPDF } = require('./pdf');
const { enviarEmail, enviarNotificacionOT } = require('./email');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Inicializar BD
async function start() {
  try {
    await getDb();
    await initDatabase();

    app.listen(PORT, () => {
      console.log(`🌐 Servidor corriendo en http://localhost:${PORT}`);
    });
  } catch (e) {
    console.error('Error inicializando BD:', e.message);
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

// ==================== API: AUTH ====================
app.post('/api/auth', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    await getDb();
    const user = queryFirst('SELECT * FROM usuarios WHERE email = ? AND activo = 1', [email]);

    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

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

app.delete('/api/usuarios/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.userId) {
      return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
    }
    run('UPDATE usuarios SET activo = 0 WHERE id = ?', [id]);
    res.json({ message: 'Usuario desactivado' });
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

  if (estado) { sql += ' AND ot.estado = ?'; params.push(estado); }
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

app.post('/api/ordenes', authMiddleware, adminOnly, (req, res) => {
  try {
    const num = generarNumeroOT();
    const body = req.body;

    // Calculate monto_total from precios fijos
    let montoCalculado = 0;
    if (body.productos && Array.isArray(body.productos)) {
      const tipo = body.tipo_servicio || 'proyecto_nuevo';
      const precios = tipo === 'mantenimiento' ? PRECIOS_MANTENIMIENTO : PRECIOS_PROYECTO_NUEVO;
      for (const p of body.productos) {
        if (p.producto_id && p.cantidad > 0) {
          const prod = queryFirst('SELECT categoria FROM productos WHERE id = ?', [p.producto_id]);
          const precio = precios[prod?.categoria] || 0;
          montoCalculado += precio * p.cantidad;
        }
      }
    }

    run(`INSERT INTO ordenes_trabajo (numero_ot, cliente_id, tipo_servicio, descripcion, presupuesto_aprobado,
      monto_total, tecnico_id, estado, fuente, notas, creada_por, fecha_programada, presupuesto_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [num, body.cliente_id, body.tipo_servicio, body.descripcion || null,
       body.presupuesto_aprobado ? 1 : 0, montoCalculado, body.tecnico_id || null,
       body.estado || 'pendiente', (body.fuente === 'presupuesto' || body.fuente === 'garantia' || body.fuente === 'levantamiento' ? 'manual' : body.fuente || 'manual'), body.notas || null,
       req.user.userId, body.fecha_programada || null, body.presupuesto_id || null]);

    // Get the inserted OT id
    const otRow = queryFirst('SELECT id FROM ordenes_trabajo WHERE numero_ot = ?', [num]);

    // Insert productos if provided
    if (body.productos && Array.isArray(body.productos) && otRow) {
      for (const p of body.productos) {
        if (p.producto_id && p.cantidad > 0) {
          run('INSERT INTO orden_trabajo_productos (orden_trabajo_id, producto_id, cantidad) VALUES (?, ?, ?)',
            [otRow.id, p.producto_id, p.cantidad]);
        }
      }
    }

    res.status(201).json({ numero_ot: num, monto_incentivo: montoCalculado, message: 'OT creada' });
  } catch (e) {
    console.error('Error creating OT:', e);
    res.status(500).json({ error: 'Error al crear OT' });
  }
});

app.put('/api/ordenes', authMiddleware, adminOnly, (req, res) => {
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
  } catch (e) {
    console.error('Error updating OT:', e);
    res.status(500).json({ error: 'Error al actualizar OT' });
  }
});

// ============ ESTADO DE OT - TRANSICIONES ============
const TRANSICIONES_ESTADO = {
  'pendiente': ['en_curso', 'cancelada'],
  'en_curso': ['cancelada'], // 'aval_entregado' se maneja desde flujo de avales
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
    const precios = ot.tipo_servicio === 'mantenimiento' ? PRECIOS_MANTENIMIENTO : PRECIOS_PROYECTO_NUEVO;
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
    } else {
      run("UPDATE ordenes_trabajo SET estado=?, actualizado_en=datetime('now', '-04:00') WHERE id=?", [nuevoEstado, id]);
      res.json({ message: 'Estado actualizado' });
    }

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
      return res.status(400).json({ error: 'La OT debe estar en curso para entregar aval' });
    }

    // Check no existing aval
    const existingAval = queryFirst('SELECT id FROM avales WHERE orden_trabajo_id = ?', [body.orden_trabajo_id]);
    if (existingAval) {
      return res.status(400).json({ error: 'Esta OT ya tiene un aval registrado' });
    }

    const tecnicoId = body.tecnico_id || req.user.userId;

    // Guardar productos como JSON para auditoría
    const productosTecnico = JSON.stringify(body.productos || []);

    transaction(() => {
      const avalId = queryFirst(`
        INSERT INTO avales (orden_trabajo_id, tecnico_id, cliente_nombre, cliente_contacto, cliente_cedula,
          cliente_telefono, cliente_email, observaciones, productos_tecnico, estado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')
        RETURNING id
      `, [
        body.orden_trabajo_id, tecnicoId, body.cliente_nombre, body.cliente_contacto || null,
        body.cliente_cedula || null, body.cliente_telefono || null, body.cliente_email || null,
        body.observaciones || null, productosTecnico
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

    res.status(201).json({ message: 'Aval entregado correctamente', aval_id: queryFirst(`SELECT id FROM avales WHERE orden_trabajo_id = ?`, [body.orden_trabajo_id]).id });
  } catch (e) {
    console.error('Error creating aval de entrega:', e);
    res.status(500).json({ error: 'Error al registrar aval' });
  }
});

// PUT /api/avales/:id/confirmar — admin confirma aval
app.put('/api/avales/:id/confirmar', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body;

    const aval = queryFirst('SELECT * FROM avales WHERE id = ?', [id]);
    if (!aval) return res.status(404).json({ error: 'Aval no encontrado' });
    if (aval.estado !== 'pendiente') {
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

      // Update aval
      run(`UPDATE avales SET estado='confirmado', fecha_confirmacion_admin=datetime('now', '-04:00'),
        confirmado_por=?, productos_admin=? WHERE id=?`,
        [req.user.userId, productosAdmin, id]);

      // Change OT to completada
      run("UPDATE ordenes_trabajo SET estado='completada', fecha_fin=datetime('now', '-04:00'), actualizado_en=datetime('now', '-04:00') WHERE id=?",
        [aval.orden_trabajo_id]);
    });

    res.json({ message: 'Aval confirmado. OT marcada como completada.' });
  } catch (e) {
    console.error('Error confirmando aval:', e);
    res.status(500).json({ error: 'Error al confirmar aval' });
  }
});

// GET /api/avales/:id/pdf — genera HTML del aval para imprimir
app.get('/api/avales/:id/pdf', authMiddleware, (req, res) => {
  try {
    const id = Number(req.params.id);
    const aval = queryFirst(`
      SELECT a.*, ot.numero_ot, u.nombre as tecnico_nombre
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
  <h1>AVAL DE INSTALACIÓN</h1>
  <h2>OT: ${aval.numero_ot}</h2>
</div>
<div class="status">${estadoLabel}</div>
<div class="section">
  <h3>DATOS DEL CLIENTE</h3>
  <table><tr><td class="label">Nombre:</td><td>${aval.cliente_nombre}</td></tr>
  <tr><td class="label">Contacto:</td><td>${aval.cliente_contacto || '-'}</td></tr>
  <tr><td class="label">Cédula:</td><td>${aval.cliente_cedula || '-'}</td></tr>
  <tr><td class="label">Teléfono:</td><td>${aval.cliente_telefono || '-'}</td></tr>
  <tr><td class="label">Email:</td><td>${aval.cliente_email || '-'}</td></tr></table>
</div>
<div class="section">
  <h3>TÉCNICO ASIGNADO</h3>
  <p>${aval.tecnico_nombre}</p>
</div>
<div class="section">
  <h3>PRODUCTOS INSTALADOS</h3>
  <table><thead><tr><th>Producto</th><th>Cant. Reportada</th><th>Cant. Confirmada</th><th>Comentario</th></tr></thead>
  <tbody>${prodRows}</tbody></table>
</div>
${aval.observaciones ? `<div class="section"><h3>OBSERVACIONES</h3><p>${aval.observaciones}</p></div>` : ''}
<div class="section">
  <h3>FECHAS</h3>
  <table><tr><td class="label">Fecha Entrega Técnico:</td><td>${aval.fecha_entrega_tecnico}</td></tr>
  ${aval.fecha_confirmacion_admin ? `<tr><td class="label">Fecha Confirmación Admin:</td><td>${aval.fecha_confirmacion_admin}</td></tr>` : ''}</table>
</div>
<div class="footer">Documento generado por OT Dashboard - ${new Date().toLocaleDateString('es-DO')}</div>
<script>window.print()</script>
</body></html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
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

  res.json({ avales: queryAll(sql, params) });
});

app.post('/api/avales-legacy', authMiddleware, adminOnly, async (req, res) => {
  try {
    const body = req.body;
    const ot = queryFirst(
      `SELECT ot.*, c.nombre as cliente_nombre, c.telefono, c.direccion, c.cedula_rnc, c.tipo as tipo_cliente
       FROM ordenes_trabajo ot JOIN clientes c ON ot.cliente_id = c.id WHERE ot.id = ?`,
      [body.orden_trabajo_id]);
    if (!ot) return res.status(404).json({ error: 'OT no encontrada' });

    const numAval = (() => {
      const year = new Date().getFullYear();
      const row = queryFirst("SELECT COUNT(*) as cnt FROM avales_legacy WHERE strftime('%Y', creado_en) = ?", [String(year)]);
      const count = row?.cnt || 0;
      return `AV-${year}-${String(count + 1).padStart(4, '0')}`;
    })();

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
  } catch (e) {
    console.error('Error creating aval legacy:', e);
    res.status(500).json({ error: 'Error al crear aval' });
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
  let sql = `
    SELECT e.*, ot.numero_ot, c.nombre as cliente_nombre
    FROM encuestas_satisfaccion e
    JOIN ordenes_trabajo ot ON e.orden_trabajo_id = ot.id
    JOIN clientes c ON ot.cliente_id = c.id
    WHERE 1=1
  `;
  const params = [];
  if (otId) { sql += ' AND e.orden_trabajo_id = ?'; params.push(Number(otId)); }
  sql += ' ORDER BY e.creado_en DESC';
  res.json({ encuestas: queryAll(sql, params) });
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
      porcentaje_final, realizada_por, fecha_encuesta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-04:00'))`,
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
  } catch (e) {
    console.error('Error creating encuesta:', e);
    res.status(500).json({ error: 'Error al registrar encuesta' });
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

    const config = queryFirst('SELECT * FROM configuracion_incentivos WHERE id = 1');
    res.json({ message: 'Configuración actualizada', config });
  } catch (e) {
    console.error('Error updating config:', e);
    res.status(500).json({ error: 'Error al actualizar configuración' });
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
    res.json({ message: 'Configuración de documentos actualizada', configuracion: cfg });
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
      SELECT ot.*, c.nombre as cliente_nombre, p.nombre_proyecto,
             a.id as aval_id,
             e.tiempo_entrega, e.desempeno_equipo, e.presentacion_equipo,
             e.calidad_productos, e.calidad_entrenamientos
      FROM ordenes_trabajo ot
      JOIN clientes c ON ot.cliente_id = c.id
      LEFT JOIN avales a ON a.orden_trabajo_id = ot.id AND a.estado = 'confirmado'
      LEFT JOIN presupuestos p ON ot.presupuesto_id = p.id
      LEFT JOIN encuestas_satisfaccion e ON e.orden_trabajo_id = ot.id
      WHERE ot.estado = 'completada'
        AND (ot.fecha_fin >= ? AND ot.fecha_fin <= ?)
    `, [fInicio, fFin]);

    // Calculate per-project
    const proyectosData = proyectos.map(ot => {
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

      // Calculate values
      const valCerNuevo = cerradurasNuevas * PRECIOS_PROYECTO_NUEVO.cerradura;
      const valCajaNuevo = cajasNuevas * PRECIOS_PROYECTO_NUEVO.caja_fuerte;
      const valCtrlNuevo = controlAccesoNuevo * PRECIOS_PROYECTO_NUEVO.control_acceso;
      const valAhorroNuevo = ahorroEnergiaNuevo * PRECIOS_PROYECTO_NUEVO.ahorro_energia;
      const valCerMant = cerradurasMant * PRECIOS_MANTENIMIENTO.cerradura;
      const valCajaMant = cajasMant * PRECIOS_MANTENIMIENTO.caja_fuerte;
      const valAhorroMant = ahorroEnergiaMant * PRECIOS_MANTENIMIENTO.ahorro_energia;

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
      if (evaluacion && evaluacion.promedio < 1.0) {
        deduccionPorcentaje = 1 - evaluacion.promedio;
        total = subtotal * (1 - deduccionPorcentaje);
      }

      return {
        id: ot.id,
        nombre: ot.nombre_proyecto || ot.cliente_nombre,
        habitaciones: 1,
        fecha_inicio: ot.fecha_inicio,
        fecha_fin: ot.fecha_fin,
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
          subtotal: Math.round(subtotal * 100) / 100
        },
        evaluacion: evaluacion,
        deduccion_porcentaje: Math.round(deduccionPorcentaje * 10000) / 10000,
        total: Math.round(total * 100) / 100
      };
    });

    // Sum totals
    let totalCerraduras = 0, totalCajas = 0, totalControlAcceso = 0, totalAhorroEnergia = 0;
    let totalBruto = 0, totalDeduccion = 0;
    let sumEval = 0, countEval = 0;

    for (const p of proyectosData) {
      totalCerraduras += p.valores.cerraduras;
      totalCajas += p.valores.cajas_fuertes;
      totalControlAcceso += p.valores.control_acceso;
      totalAhorroEnergia += p.valores.ahorro_energia;
      totalBruto += p.valores.subtotal;
      totalDeduccion += (p.valores.subtotal - p.total);
      if (p.evaluacion) {
        sumEval += p.evaluacion.promedio;
        countEval++;
      }
    }

    const evalPromedioGeneral = countEval > 0 ? Math.round((sumEval / countEval) * 100) / 100 : null;
    const porcDeduccionGeneral = totalBruto > 0 ? Math.round((totalDeduccion / totalBruto) * 10000) / 10000 : 0;
    const totalADistribuir = Math.round((totalBruto - totalDeduccion) * 100) / 100;

    // Distribución por técnico
    const distTecnicos = [
      { nombre: 'Máximo Vallejo', porcentaje: 0.30 },
      { nombre: 'Víctor De La Rosa', porcentaje: 0.28 },
      { nombre: 'Alexander De Dios', porcentaje: 0.12 },
      { nombre: 'Ángel Pérez', porcentaje: 0.12 },
      { nombre: 'Juan Samuel Encarnación', porcentaje: 0.08 },
      { nombre: 'Rosaura Nivar', porcentaje: 0.10 },
    ];

    const distribucion = distTecnicos.map(t => ({
      tecnico: t.nombre,
      porcentaje: t.porcentaje,
      valor_bruto: Math.round(t.porcentaje * totalADistribuir * 100) / 100,
      adicionales: 0,
      total: Math.round(t.porcentaje * totalADistribuir * 100) / 100
    }));

    const resultado = {
      periodo: { inicio: fInicio, fin: fFin },
      proyectos: proyectosData,
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
        total_a_distribuir: totalADistribuir
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

    const precios = ot.tipo_servicio === 'mantenimiento' ? PRECIOS_MANTENIMIENTO : PRECIOS_PROYECTO_NUEVO;
    let montoTotal = 0;
    const prodRows = productos.map(p => {
      const pu = precios[p.categoria] || 0;
      const sub = pu * p.cantidad;
      montoTotal += sub;
      return `<tr><td style="border:1px solid #e5e7eb;padding:8px">${escHtml2(p.nombre)}</td><td style="border:1px solid #e5e7eb;padding:8px;text-align:center">${p.categoria}</td><td style="border:1px solid #e5e7eb;padding:8px;text-align:center">${p.cantidad}</td><td style="border:1px solid #e5e7eb;padding:8px;text-align:right">RD$ ${pu.toFixed(2)}</td><td style="border:1px solid #e5e7eb;padding:8px;text-align:right">RD$ ${sub.toFixed(2)}</td></tr>`;
    }).join('');

    // Desglose
    const desglose = {};
    for (const p of productos) {
      const cat = p.categoria || 'otro';
      const pu = precios[cat] || 0;
      if (!desglose[cat]) desglose[cat] = { cantidad: 0, subtotal: 0 };
      desglose[cat].cantidad += p.cantidad;
      desglose[cat].subtotal += pu * p.cantidad;
    }
    const desgRows = Object.entries(desglose).map(([cat, v]) =>
      `<tr><td style="border:1px solid #e5e7eb;padding:8px">${cat.replace(/_/g, ' ')}</td><td style="border:1px solid #e5e7eb;padding:8px;text-align:center">${v.cantidad}</td><td style="border:1px solid #e5e7eb;padding:8px;text-align:right">RD$ ${v.subtotal.toFixed(2)}</td></tr>`
    ).join('');

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
              <th class="text-right py-2.5 px-4 font-semibold text-gray-600 text-xs uppercase">Precio Unit.</th>
              <th class="text-right py-2.5 px-4 font-semibold text-gray-600 text-xs uppercase">Subtotal</th>
            </tr></thead>
            <tbody>${productos.length === 0 ? '<tr><td colspan="5" class="text-center py-8 text-gray-400">Sin productos asignados</td></tr>' : prodRows}</tbody>
          </table>
        </div>
      </div>

      <!-- DESGLOSE DE MONTOS -->
      <div class="border border-gray-200 rounded-xl overflow-hidden">
        <div class="bg-gray-50 px-4 py-2.5 border-b border-gray-200 font-semibold text-gray-700 flex items-center gap-2"><span>💰</span> Desglose de Montos</div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead><tr class="bg-gray-50 border-b border-gray-200">
              <th class="text-left py-2.5 px-4 font-semibold text-gray-600 text-xs uppercase">Categoría</th>
              <th class="text-center py-2.5 px-4 font-semibold text-gray-600 text-xs uppercase">Cant.</th>
              <th class="text-right py-2.5 px-4 font-semibold text-gray-600 text-xs uppercase">Subtotal</th>
            </tr></thead>
            <tbody>${desgRows}</tbody>
            <tfoot><tr class="bg-gray-50 border-t-2 border-gray-200">
              <td class="py-3 px-4 font-bold text-gray-800">TOTAL</td>
              <td class="py-3 px-4 text-center font-bold">${productos.reduce((s,p) => s + p.cantidad, 0)}</td>
              <td class="py-3 px-4 text-right font-bold text-blue-700">RD$ ${montoTotal.toFixed(2)}</td>
            </tr></tfoot>
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

// ============ FRONTEND (SPA) ============
// Para SPA: servir index.html en todas las rutas excepto API y archivos estáticos
app.get(/^\/(?!api\/|uploads\/|orden\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});







// ============ LIMPIEZA DE BD (admin only) ============
app.post('/api/limpiar-bd', authMiddleware, superAdminOnly, (req, res) => {
  try {
    transaction(() => {
      const tables = ['orden_trabajo_productos','avales_legacy','encuestas_satisfaccion','notificaciones_ot','avales','aval_productos','ordenes_trabajo','presupuestos','reportes_incentivos','configuracion_incentivos','configuracion_documentos','productos','clientes'];
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

// Descargar backup como JSON
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
    SENDGRID_API_KEY: process.env.SENDGRID_API_KEY ? 'CONFIGURADA (primeros 10 chars: ' + process.env.SENDGRID_API_KEY.substring(0,10) + '...)' : 'NO CONFIGURADA',
    SMTP_USER: process.env.SMTP_USER || 'NO CONFIGURADO',
    SMTP_HOST: process.env.SMTP_HOST || 'default: smtp.gmail.com',
    SMTP_PORT: process.env.SMTP_PORT || 'default: 587',
    SMTP_FROM: process.env.SMTP_FROM || 'NO CONFIGURADO',
  });
});

start();
