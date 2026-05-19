const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { getDb, queryAll, queryFirst, run, transaction } = require('./db');
const { initDatabase } = require('./init-db');
const { authMiddleware, adminOnly, generarToken } = require('./auth');
const { generarAvalPDF } = require('./pdf');
const { enviarEmail } = require('./email');

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
  return `AV-${year}-${String(count + 1).padStart(4, '0')}`;
}

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

// ==================== API: ÓRDENES DE TRABAJO ====================
app.get('/api/ordenes', authMiddleware, (req, res) => {
  const estado = req.query.estado;
  let sql = `
    SELECT ot.*, c.nombre as cliente_nombre, c.telefono as cliente_telefono, c.email as cliente_email,
           u.nombre as tecnico_nombre
    FROM ordenes_trabajo ot
    JOIN clientes c ON ot.cliente_id = c.id
    LEFT JOIN usuarios u ON ot.tecnico_id = u.id
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
  }

  res.json({ ordenes });
});

app.post('/api/ordenes', authMiddleware, adminOnly, (req, res) => {
  try {
    const num = generarNumeroOT();
    const body = req.body;
    run(`INSERT INTO ordenes_trabajo (numero_ot, cliente_id, tipo_servicio, descripcion, presupuesto_aprobado,
      monto_total, tecnico_id, estado, fuente, notas, creada_por, fecha_programada)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [num, body.cliente_id, body.tipo_servicio, body.descripcion || null,
       body.presupuesto_aprobado ? 1 : 0, body.monto_total || 0, body.tecnico_id || null,
       body.estado || 'pendiente', body.fuente || 'manual', body.notas || null,
       req.user.userId, body.fecha_programada || null]);

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

    res.status(201).json({ numero_ot: num, message: 'OT creada' });
  } catch (e) {
    console.error('Error creating OT:', e);
    res.status(500).json({ error: 'Error al crear OT' });
  }
});

app.put('/api/ordenes', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body;
    run(`UPDATE ordenes_trabajo SET cliente_id=?, tipo_servicio=?, descripcion=?, monto_total=?, tecnico_id=?,
      estado=?, notas=?, fecha_programada=?, actualizado_en=datetime('now', '-04:00') WHERE id=?`,
      [b.cliente_id, b.tipo_servicio, b.descripcion, b.monto_total, b.tecnico_id,
       b.estado, b.notas, b.fecha_programada, b.id]);

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

// ==================== API: AVALES ====================
app.get('/api/avales', authMiddleware, (req, res) => {
  const otId = req.query.orden_trabajo_id;
  let sql = `
    SELECT a.*, ot.numero_ot, c.nombre as cliente_nombre
    FROM avales a
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

app.post('/api/avales', authMiddleware, adminOnly, async (req, res) => {
  try {
    const body = req.body;
    const ot = queryFirst(
      `SELECT ot.*, c.nombre as cliente_nombre, c.telefono, c.direccion, c.cedula_rnc, c.tipo as tipo_cliente
       FROM ordenes_trabajo ot JOIN clientes c ON ot.cliente_id = c.id WHERE ot.id = ?`,
      [body.orden_trabajo_id]);
    if (!ot) return res.status(404).json({ error: 'OT no encontrada' });

    const numAval = generarNumeroAval();

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

    run(`INSERT INTO avales (orden_trabajo_id, numero_aval, descripcion_trabajo, materiales, costo_total,
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
        run("UPDATE avales SET estado='enviado', fecha_envio_tecnico=datetime('now', '-04:00') WHERE numero_aval=?", [numAval]);
      }
    }

    res.status(201).json({ numero_aval: numAval, pdf_url: `/uploads/avales/${pdfFilename}`, message: 'Aval creado' });
  } catch (e) {
    console.error('Error creating aval:', e);
    res.status(500).json({ error: 'Error al crear aval' });
  }
});

// Subir aval firmado
app.put('/api/avales', authMiddleware, adminOnly, async (req, res) => {
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

    run(`UPDATE avales SET archivo_pdf_firmado=COALESCE(?, archivo_pdf_firmado), respuestas_digitales=?,
      estado='completado', fecha_firma_cliente=datetime('now', '-04:00'),
      fecha_completado=datetime('now', '-04:00'), actualizado_en=datetime('now', '-04:00') WHERE id=?`,
      [pdfPath, respuestas_digitales || '{}', id]);

    res.json({ success: true });
  } catch (e) {
    console.error('Error updating aval:', e);
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

    run(`INSERT INTO encuestas_satisfaccion (orden_trabajo_id, aval_id, satisfaccion_general,
      tiempo_entrega, desempeno_equipo, presentacion_equipo, calidad_productos,
      conocimientos_tecnicos, calidad_entrenamientos, recomendaria, observaciones,
      porcentaje_final, realizada_por, fecha_encuesta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-04:00'))`,
      [b.orden_trabajo_id, b.aval_id || null, respuestas.satisfaccion_general,
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

// ==================== API: REPORTES ====================
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
    if (ot.tipo_servicio === 'instalacion') totalCerraduras++;
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

// ============ FRONTEND (SPA) ============
// Para SPA: servir index.html en todas las rutas excepto API y archivos estáticos
app.get(/^\/(?!api\/|uploads\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

start();
