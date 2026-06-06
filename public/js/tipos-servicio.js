// tipos-servicio.js — Admin de tipos y categorías de servicio
// Cargado en <head>, define funciones globales para CRUD de tipos_servicio y categorias_servicio

window._tiposServicioCache = null;

window.cargarTiposServicio = async function () {
  try {
    const res = await fetch('/api/tipos-servicio', {
      headers: { Authorization: 'Bearer ' + (window.state ? window.state.token : '') }
    });
    if (!res.ok) {
      console.warn('cargarTiposServicio: status', res.status);
      return [];
    }
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
  if (!data.length) {
    container.innerHTML = '<div class="text-center text-gray-400 py-8">No hay tipos de servicio configurados.</div>';
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
            ' onchange="window.actualizarPrecioCategoria(' + t.id + ',' + c.id + ',this.value)"' +
            ' class="w-20 px-2 py-1 border border-gray-300 rounded text-sm text-right focus:outline-none focus:ring-1 focus:ring-blue-500">' +
          '<button onclick="window.eliminarCategoriaTipo(' + t.id + ',' + c.id + ',' + JSON.stringify(c.label) + ')" class="text-red-400 hover:text-red-600 text-xs shrink-0">✕</button>' +
        '</div>' +
      '</div>';
    }).join('');
    return '<div class="card p-4">' +
      '<div class="flex items-center justify-between mb-3">' +
        '<div class="flex items-center gap-2">' +
          '<span class="text-lg">' + (t.icon || '📋') + '</span>' +
          '<h4 class="font-semibold text-gray-800">' + escHtml(t.label) + '</h4>' +
          '<code class="text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-500">' + escHtml(t.nombre) + '</code>' +
        '</div>' +
        '<div class="flex items-center gap-2">' +
          '<button onclick="window.editarTipoServicio(' + t.id + ',' + JSON.stringify(t.label) + ')" class="text-sm text-blue-600 hover:text-blue-800">✎ Editar</button>' +
          '<button onclick="window.agregarCategoriaTipo(' + t.id + ')" class="btn-primary text-xs px-2 py-1">+ Categoría</button>' +
        '</div>' +
      '</div>' +
      '<div class="space-y-2">' + cats + '</div>' +
    '</div>';
  }).join('');
};

window.actualizarPrecioCategoria = async function (tipoId, catId, precio) {
  try {
    await fetch('/api/tipos-servicio/' + tipoId + '/categorias/' + catId, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (window.state ? window.state.token : '')
      },
      body: JSON.stringify({ precio: parseFloat(precio) || 0 })
    });
  } catch (e) {
    console.error('Error actualizando precio:', e);
  }
};

window.eliminarCategoriaTipo = async function (tipoId, catId, label) {
  if (!confirm('¿Desactivar categoría "' + label + '"?')) return;
  try {
    await fetch('/api/tipos-servicio/' + tipoId + '/categorias/' + catId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + (window.state ? window.state.token : '') }
    });
    toast('Categoría desactivada', 'success');
    window.renderTiposServicioConfig();
  } catch (e) {
    console.error('Error eliminando categoría:', e);
  }
};

window.agregarCategoriaTipo = function (tipoId) {
  var key = prompt('Nombre clave (key) de la categoría (ej: cerradura, control_acceso):');
  if (!key) return;
  var label = prompt('Etiqueta visible (ej: Cerradura Electrónica):');
  if (!label) return;
  var precio = parseFloat(prompt('Precio (RD$):', '0')) || 0;
  fetch('/api/tipos-servicio/' + tipoId + '/categorias', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (window.state ? window.state.token : '')
    },
    body: JSON.stringify({ key: key, label: label, precio: precio })
  }).then(function (r) {
    if (!r.ok) throw new Error('Error');
    toast('Categoría agregada', 'success');
    window.renderTiposServicioConfig();
  }).catch(function (e) { toast('Error: ' + e.message, 'error'); });
};

window.abrirModalNuevoTipo = function () {
  var nombre = prompt('Nombre interno (ej: proyecto_nuevo):');
  if (!nombre) return;
  var label = prompt('Nombre visible (ej: Proyecto Nuevo):');
  if (!label) return;
  fetch('/api/tipos-servicio', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (window.state ? window.state.token : '')
    },
    body: JSON.stringify({ nombre: nombre, label: label })
  }).then(function (r) {
    if (!r.ok) throw new Error('Error');
    toast('Tipo de servicio creado', 'success');
    window.renderTiposServicioConfig();
  }).catch(function (e) { toast('Error: ' + e.message, 'error'); });
};

window.editarTipoServicio = function (id, labelActual) {
  var label = prompt('Nuevo nombre visible:', labelActual);
  if (!label) return;
  fetch('/api/tipos-servicio/' + id, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (window.state ? window.state.token : '')
    },
    body: JSON.stringify({ label: label })
  }).then(function (r) {
    if (!r.ok) throw new Error('Error');
    toast('Tipo actualizado', 'success');
    window.renderTiposServicioConfig();
  }).catch(function (e) { toast('Error: ' + e.message, 'error'); });
};

window.eliminarTipoServicio = function (id, label) {
  if (!confirm('¿Desactivar tipo de servicio "' + label + '" y todas sus categorías?')) return;
  fetch('/api/tipos-servicio/' + id, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + (window.state ? window.state.token : '') }
  }).then(function (r) {
    if (!r.ok) throw new Error('Error');
    toast('Tipo desactivado', 'success');
    window.renderTiposServicioConfig();
  }).catch(function (e) { toast('Error: ' + e.message, 'error'); });
};