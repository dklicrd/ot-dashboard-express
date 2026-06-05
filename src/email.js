const nodemailer = require('nodemailer');
const https = require('https');
const { getDb, queryFirst, queryAll } = require('./db');

async function enviarEmail({ to, subject, html, attachments }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (apiKey) {
    // 1) Try SMTP via smtp.sendgrid.net:2525
    const smtpResult = await enviarViaSendGridSMTP({ to, subject, html, attachments, apiKey });
    if (smtpResult.success) return smtpResult;

    // 2) Try API HTTP
    console.log('SendGrid SMTP fallo, probando API HTTP...');
    const apiResult = await enviarViaSendGridAPI({ to, subject, html, attachments, apiKey });
    if (apiResult.success) return apiResult;

    console.log('SendGrid API tambien fallo, probando SMTP Gmail...');
  }
  // Fallback SMTP Gmail
  return enviarViaSMTP({ to, subject, html, attachments });
}

function enviarViaSendGridSMTP({ to, subject, html, attachments, apiKey }) {
  return new Promise((resolve) => {
    const smtpTransport = nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 2525,
      secure: false,
      auth: {
        user: 'apikey',
        pass: apiKey,
      },
      connectionTimeout: 6000,
      greetingTimeout: 6000,
      socketTimeout: 8000,
    });
    const recipients = Array.isArray(to) ? to.join(', ') : to;
    smtpTransport.sendMail({
      from: process.env.SMTP_FROM || 'a.plasencia@grupoarboleda.com',
      to: recipients,
      subject: subject,
      html: html,
      attachments: attachments || [],
    }, (err) => {
      if (err) {
        console.error('SendGrid SMTP 2525 error:', err.message);
        resolve({ success: false, error: err.message });
      } else {
        console.log('Email enviado via SendGrid SMTP a:', to);
        resolve({ success: true });
      }
    });
  });
}

function enviarViaSendGridAPI({ to, subject, html, attachments, apiKey }) {
  return new Promise(function(resolve) {
    var recipients = Array.isArray(to) ? to : [to];
    var personalizations = recipients.map(function(email) { return { to: [{ email: email }] }; });
    var payload = {
      personalizations: personalizations,
      from: { email: process.env.SMTP_FROM || 'a.plasencia@grupoarboleda.com', name: 'OT Dashboard' },
      subject: subject,
      content: [{ type: 'text/html', value: html }],
    };
    var url = 'https://api.sendgrid.com/v3/mail/send';
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, 12000);
    fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).then(function(resp) {
      clearTimeout(timeoutId);
      if (resp.ok) {
        console.log('Email enviado via SendGrid API a:', to);
        resolve({ success: true });
      } else {
        resp.text().then(function(body) {
          console.error('SendGrid API error:', resp.status, body);
          resolve({ success: false, error: 'SendGrid HTTP ' + resp.status + ': ' + body });
        });
      }
    }).catch(function(e) {
      clearTimeout(timeoutId);
      console.error('SendGrid API error de red:', e.message);
      resolve({ success: false, error: e.message });
    });
  });
}

var transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 10000,
});

async function enviarViaSMTP({ to, subject, html, attachments }) {
  try {
    const recipients = Array.isArray(to) ? to.join(', ') : to;
    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'noreply@ot-dashboard.com',
      to: recipients,
      subject: subject,
      html: html,
      attachments: attachments || [],
    });
    return { success: true };
  } catch (error) {
    console.error('Error enviando email via SMTP:', error.message);
    return { success: false, error: error.message };
  }
}

var PRECIOS_PROYECTO_NUEVO = {
  cerradura: 4500, control_acceso: 6500, caja_fuerte: 8500,
  ahorro_energia: 3500, instalacion: 2000, otro: 1500
};

var PRECIOS_MANTENIMIENTO = {
  cerradura: 1500, control_acceso: 2000, caja_fuerte: 2500,
  ahorro_energia: 1200, instalacion: 1000, otro: 800
};

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function enviarNotificacionOT(otId) {
  await getDb();
  var ot = queryFirst([
    'SELECT ot.*, c.nombre as cliente_nombre, c.telefono as cliente_telefono,',
    'c.email as cliente_email, c.direccion as cliente_direccion,',
    'c.cedula_rnc as cliente_cedula_rnc, c.tipo as cliente_tipo,',
    'u.nombre as tecnico_nombre, u.email as tecnico_email, u.telefono as tecnico_telefono',
    'FROM ordenes_trabajo ot',
    'JOIN clientes c ON ot.cliente_id = c.id',
    'LEFT JOIN usuarios u ON ot.tecnico_id = u.id',
    'WHERE ot.id = ?'
  ].join(' '), [otId]);

  if (!ot) {
    console.error('OT ' + otId + ' no encontrada para enviar notificacion');
    return { success: false, error: 'OT no encontrada' };
  }

  var productos = queryAll([
    'SELECT p.nombre, p.categoria, otp.cantidad',
    'FROM orden_trabajo_productos otp',
    'JOIN productos p ON otp.producto_id = p.id',
    'WHERE otp.orden_trabajo_id = ?'
  ].join(' '), [otId]);

  var precios = ot.tipo_servicio === 'mantenimiento' ? PRECIOS_MANTENIMIENTO : PRECIOS_PROYECTO_NUEVO;
  var montoTotal = 0;
  var prodRows = productos.map(function(p) {
    var pu = precios[p.categoria] || 0;
    var sub = pu * p.cantidad;
    montoTotal += sub;
    return '<tr><td style="border:1px solid #ddd;padding:8px">' + escHtml(p.nombre) + '</td><td style="border:1px solid #ddd;padding:8px;text-align:center">' + p.categoria.replace(/_/g, ' ') + '</td><td style="border:1px solid #ddd;padding:8px;text-align:center">' + p.cantidad + '</td><td style="border:1px solid #ddd;padding:8px;text-align:right">RD$ ' + pu.toFixed(2) + '</td><td style="border:1px solid #ddd;padding:8px;text-align:right">RD$ ' + sub.toFixed(2) + '</td></tr>';
  }).join('');

  var dashUrl = process.env.DASHBOARD_URL || 'https://ot-dashboard-9mn9.onrender.com';
  var enlaceDetalle = dashUrl + '/orden/' + otId;

  var emailHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:20px"><div style="max-width:650px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)"><div style="background:linear-gradient(135deg,#1e40af,#1d4ed8);color:white;padding:24px 30px"><h1 style="margin:0;font-size:22px">&#x1F680; &#xA1;Orden de Trabajo Iniciada!</h1><p style="margin:8px 0 0;opacity:0.9">' + escHtml(ot.numero_ot) + ' - ' + escHtml(ot.cliente_nombre) + '</p></div><div style="padding:24px 30px"><p style="font-size:16px;color:#333">Estimado/a <strong>' + escHtml(ot.cliente_nombre) + '</strong>,</p><p style="color:#555">Nos complace informarle que su Orden de Trabajo ha sido <strong style="color:#16a34a">iniciada</strong> y el equipo t\u00e9cnico se encuentra listo para atender su solicitud.</p><h3 style="color:#1e40af;border-bottom:2px solid #e5e7eb;padding-bottom:8px">&#x1F4CB; Detalle de la Orden</h3><table style="width:100%;border-collapse:collapse;margin-bottom:16px"><tr><td style="padding:6px 0;color:#666">No. Orden:</td><td style="font-weight:bold">' + escHtml(ot.numero_ot) + '</td></tr><tr><td style="padding:6px 0;color:#666">Tipo de Servicio:</td><td style="font-weight:bold;text-transform:capitalize">' + escHtml(ot.tipo_servicio) + '</td></tr><tr><td style="padding:6px 0;color:#666">T\u00e9cnico Asignado:</td><td style="font-weight:bold">' + escHtml(ot.tecnico_nombre || 'Pendiente') + '</td></tr>' + (ot.descripcion ? '<tr><td style="padding:6px 0;color:#666">Descripci\u00f3n:</td><td>' + escHtml(ot.descripcion) + '</td></tr>' : '') + '</table>';

  if (productos.length > 0) {
    emailHtml += '<h3 style="color:#1e40af;border-bottom:2px solid #e5e7eb;padding-bottom:8px">&#x1F4E6; Productos / Servicios</h3><table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:14px"><thead><tr style="background:#f3f4f6"><th style="border:1px solid #ddd;padding:8px;text-align:left">Producto</th><th style="border:1px solid #ddd;padding:8px;text-align:center">Categoria</th><th style="border:1px solid #ddd;padding:8px;text-align:center">Cant.</th><th style="border:1px solid #ddd;padding:8px;text-align:right">Precio</th><th style="border:1px solid #ddd;padding:8px;text-align:right">Subtotal</th></tr></thead><tbody>' + prodRows + '</tbody><tfoot><tr style="background:#f0fdf4"><td colspan="4" style="border:1px solid #ddd;padding:10px;font-weight:bold;text-align:right">TOTAL</td><td style="border:1px solid #ddd;padding:10px;font-weight:bold;text-align:right;color:#16a34a">RD$ ' + montoTotal.toFixed(2) + '</td></tr></tfoot></table>';
  }

  emailHtml += '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 18px;margin:16px 0"><p style="margin:0;color:#166534;font-weight:bold">&#x2705; Que sigue?</p><p style="margin:6px 0 0;color:#166534;font-size:14px">El equipo tecnico se comunicara con usted para coordinar los detalles de la visita. Puede dar seguimiento al progreso de su orden desde nuestro portal.</p></div><a href="' + escHtml(enlaceDetalle) + '" style="display:inline-block;background:#1d4ed8;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;margin-top:8px">&#x1F517; Ver Detalle Completo</a><p style="color:#999;font-size:13px;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:16px">Este es un mensaje automatico del sistema de gestion de Ordenes de Trabajo.<br>Si tiene alguna pregunta, no dude en contactarnos.</p></div></div></body></html>';

  var destinatarios = [];
  if (ot.cliente_email) destinatarios.push(ot.cliente_email);
  if (ot.tecnico_email) destinatarios.push(ot.tecnico_email);
  if (process.env.SMTP_USER) destinatarios.push(process.env.SMTP_USER);

  if (destinatarios.length === 0) {
    console.log('No hay destinatarios para notificacion OT ' + otId);
    return { success: false, error: 'Sin destinatarios' };
  }

  var result = await enviarEmail({
    to: destinatarios,
    subject: '\u2705 ' + ot.numero_ot + ' - Orden de Trabajo Iniciada - ' + ot.cliente_nombre,
    html: emailHtml,
  });

  console.log('Notificacion OT ' + ot.numero_ot + ' enviada a: ' + destinatarios.join(', '));
  return result;
}

module.exports = { enviarEmail, enviarNotificacionOT };
