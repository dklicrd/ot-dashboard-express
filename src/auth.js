const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ot-dashboard-secret-2026';

function generarToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
}

function verificarToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.query.token) {
    token = req.query.token;
  }
  
  if (!token) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  
  const user = verificarToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Token inválido' });
  }
  
  req.user = user;
  next();
}

function superAdminOnly(req, res, next) {
  if (req.user.rol !== 'superadmin') {
    return res.status(403).json({ error: 'Solo superadmin' });
  }
  next();
}

function adminOnly(req, res, next) {
  if (req.user.rol !== 'admin') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  next();
}

module.exports = { generarToken, verificarToken, authMiddleware, adminOnly, superAdminOnly };
