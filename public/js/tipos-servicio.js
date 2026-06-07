// tipos-servicio.js — Admin de tipos y categorías de servicio
// Cargado en <head>, define funciones globales para CRUD de tipos_servicio y categorias_servicio

window._tiposServicioCache = null;

// Helper para obtener token de auth (localStorage > window.state)
window._getToken = function () {
  try { var t = localStorage.getItem('token'); if (t) return t; } catch (e) {}
  if (window.state && window.state.token) return window.state.token;
  return null;
};

window.cargarTiposServicio = async function () {
  try {
    const res = await fetch('/api/public/tipos-servicio');
    if (!res.ok) { console.warn('cargarTiposServicio: status', res.status); return []; }
    const d = await res.json();
    window._tiposServicioCache = d.tipos_servicio || [];
    return window._tiposServicioCache;
  } catch (e) {
    console.error('Error cargando tipos_servicio:', e);
    return [];
  }
};

window.renderTiposServicioConfig = async function () {
  var container = document.getElementById('cfg-tipos-list');
  if (!container) return;
  container.innerHTML = '<div class="text-center text-gray-400 py-8">Cargando tipos de servicio...</div>';
  var data = await window.cargarTiposServicio();
  if (!data || !data.length) {
    container.innerHTML = '<div class="text-center text-gray-400 py-8">No hay tipos de servicio configurados. ' +
      'Haz clic en "➕ Nuevo Tipo" para crear el primero.</div>';
    return;
  }
  container.innerHTML = data.map(function (t) {
    var cats = (t.categorias || []).map(function (c) {
      var icon = c.icon || '📦';
      return '<div class="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 border border-gray-200">' +
        '<div class="flex items-center gap-3">' +
          '<span class="text-lg">' + icon + '</span>' +
          '<div class="min-w-0">' +
            '<p class="text-sm font-medium text-gray-700 truncate">' + escHtml(c.label) + '</p>' +
            '<p class="text-xs text-gray-400">' + escHtml(c.key) + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="flex items-center gap-2 shrink-0">' +
          '<span class="text-sm text-gray-500">RD$</span>' +
          '<input type="number" min="0" step="0.01" value="' + (Number(c.precio) || 0).toFixed(2) + '"' +
            ' data-actualizar-precio="' + t.id + ':' + c.id + '"' +
            ' class="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-right">' +
          '<button data-eliminar-cat="' + t.id + ':' + c.id + '" data-label="' + escHtml(c.label) + '" class="text-red-400 hover:text-red-600 text-xs shrink-0">✕</button>' +
        '</div>' +
      '</div>';
    }).join('');
    return '<div class="card p-4 cfg-tipo-card" data-tipo-id="' + t.id + '">' +
      '<div class="flex items-center justify-between mb-3">' +
        '<div class="flex items-center gap-2">' +
          '<span class="text-lg">' + (t.icon || '📋') + '</span>' +
          '<h4 class="font-semibold text-gray-800">' + escHtml(t.label) + '</h4>' +
          '<code class="text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-500">' + escHtml(t.nombre) + '</code>' +
        '</div>' +
        '<div class="flex items-center gap-2">' +
          '<button data-editar-tipo="' + t.id + '" data-label="' + escHtml(t.label) + '" class="text-sm text-blue-600 hover:text-blue-800">✎ Editar</button>' +
          '<button data-eliminar-tipo="' + t.id + '" data-label="' + escHtml(t.label) + '" class="text-sm text-red-500 hover:text-red-700 ml-2">✕ Eliminar</button>' +
          '<button data-agregar-cat="' + t.id + '" class="btn-primary text-xs px-2 py-1">+ Categoria</button>' +
        '</div>' +
      '</div>' +
      '<div class="space-y-2">' + cats + '</div>' +
    '</div>';
  }).join('');

  // Event delegation para todos los botones
  var cfgTipsList = document.getElementById('cfg-tipos-list');
  if (cfgTipsList) {
    cfgTipsList.onclick = function (e) {
      var btn = e.target.closest('[data-editar-tipo]');
      if (btn) {
        var id = parseInt(btn.getAttribute('data-editar-tipo'));
        var label = btn.getAttribute('data-label');
        window._editarTipoServicio(id, label);
        return;
      }
      btn = e.target.closest('[data-eliminar-tipo]');
      if (btn) {
        var id = parseInt(btn.getAttribute('data-eliminar-tipo'));
        var label = btn.getAttribute('data-label');
        window._eliminarTipoServicio(id, label);
        return;
      }
      btn = e.target.closest('[data-agregar-cat]');
      if (btn) {
        var id = parseInt(btn.getAttribute('data-agregar-cat'));
        window._agregarCategoriaTipo(id);
        return;
      }
      btn = e.target.closest('[data-eliminar-cat]');
      if (btn) {
        var ids = btn.getAttribute('data-eliminar-cat').split(':');
        var tipoId = parseInt(ids[0]);
        var catId = parseInt(ids[1]);
        var label = btn.getAttribute('data-label');
        window._eliminarCategoriaTipo(tipoId, catId, label);
        return;
      }
      btn = e.target.closest('[data-actualizar-precio]');
      if (btn) {
        var ids = btn.getAttribute('data-actualizar-precio').split(':');
        var tipoId = parseInt(ids[0]);
        var catId = parseInt(ids[1]);
        window._actualizarPrecioCategoria(tipoId, catId, btn);
        return;
      }
    };
  }
};

// ============ Helpers internos con fetch auth ============

window._fetchAuth = function (url, opts) {
  var token = window._getToken();
  if (!token) { return Promise.reject(new Error('No hay token de autenticacion. Re-logueate.')); }
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers['Authorization'] = 'Bearer ' + token;
  if (opts.body && !opts.headers['Content-Type']) {
    opts.headers['Content-Type'] = 'application/json';
  }
  return fetch(url, opts).then(function (r) {
    if (!r.ok) {
      return r.json().then(function (d) {
        throw new Error((d && d.error) || 'Error HTTP ' + r.status);
      }).catch(function (e) {
        if (e.message && e.message.indexOf('Error') >= 0) throw e;
        throw new Error('Error HTTP ' + r.status);
      });
    }
    return r.json();
  });
};

window._actualizarPrecioCategoria = async function (tipoId, catId, input) {
  var precio = parseFloat(input.value) || 0;
  try {
    await window._fetchAuth('/api/tipos-servicio/' + tipoId + '/categorias/' + catId, {
      method: 'PUT',
      body: JSON.stringify({ precio: precio })
    });
    toast('Precio actualizado: RD$ ' + precio.toFixed(2), 'success');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
};

window._eliminarCategoriaTipo = async function (tipoId, catId, label) {
  if (!confirm('¿Desactivar categoría "' + label + '"?')) return;
  try {
    await window._fetchAuth('/api/tipos-servicio/' + tipoId + '/categorias/' + catId, { method: 'DELETE' });
    toast('Categoría desactivada', 'success');
    window.renderTiposServicioConfig();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
};

window._agregarCategoriaTipo = function (tipoId) {
  var key = prompt('Nombre clave (key) de la categoría (ej: cerradura, control_acceso):');
  if (!key) return;
  var label = prompt('Etiqueta visible (ej: Cerradura Electrónica):');
  if (!label) return;
  var precio = parseFloat(prompt('Precio (RD$):', '0')) || 0;
  window._fetchAuth('/api/tipos-servicio/' + tipoId + '/categorias', {
    method: 'POST',
    body: JSON.stringify({ key: key, label: label, precio: precio })
  }).then(function () {
    toast('Categoría agregada', 'success');
    window.renderTiposServicioConfig();
  }).catch(function (e) {
    toast('Error: ' + e.message, 'error');
  });
};

window.abrirModalNuevoTipo = function () {
  var nombre = prompt('Nombre interno (ej: proyecto_nuevo):');
  if (!nombre) return;
  var label = prompt('Nombre visible (ej: Proyecto Nuevo):');
  if (!label) return;
  window._fetchAuth('/api/tipos-servicio', {
    method: 'POST',
    body: JSON.stringify({ nombre: nombre, label: label })
  }).then(function () {
    toast('Tipo de servicio creado', 'success');
    window.renderTiposServicioConfig();
  }).catch(function (e) {
    toast('Error: ' + e.message, 'error');
  });
};

window._editarTipoServicio = function (id, labelActual) {
  var label = prompt('Nuevo nombre visible:', labelActual);
  if (!label) return;
  window._fetchAuth('/api/tipos-servicio/' + id, {
    method: 'PUT',
    body: JSON.stringify({ label: label })
  }).then(function () {
    toast('Tipo actualizado', 'success');
    window.renderTiposServicioConfig();
  }).catch(function (e) {
    toast('Error: ' + e.message, 'error');
  });
};

window._eliminarTipoServicio = function (id, label) {
  if (!confirm('¿Desactivar tipo de servicio "' + label + '" y todas sus categorías?')) return;
  window._fetchAuth('/api/tipos-servicio/' + id, {
    method: 'DELETE'
  }).then(function () {
    toast('Tipo desactivado', 'success');
    window.renderTiposServicioConfig();
  }).catch(function (e) {
    toast('Error: ' + e.message, 'error');
  });
};