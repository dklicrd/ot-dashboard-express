// ==================== TIPOS DE SERVICIO (Admin Config) ====================

window._tiposServicioCache = null;

window.cargarTiposServicio = async function () {
  try {
    const d = await api('GET', '/api/tipos-servicio');
    window._tiposServicioCache = d.tipos_servicio || [];
    return window._tiposServicioCache;
  } catch (e) {
    console.error('Error cargando tipos_servicio:', e);
    return [];
  }
};

window.renderTiposServicioConfig = async function () {
  const container = document.getElementById('cfg-tipos-list');
  if (!container) return;

  const tipos = await window.cargarTiposServicio();

  if (tipos.length === 0) {
    container.innerHTML = '<div class="text-center text-gray-400 py-8">No hay tipos de servicio. Crea uno nuevo.</div>';
    return;
  }

  container.innerHTML = tipos.map(function(t) {
    var cats = t.categorias || [];
    var catsHtml = '';
    if (cats.length > 0) {
      var catItems = cats.map(function(c) {
        return '<div class="bg-gray-50 rounded-lg p-3 flex items-center justify-between gap-2">' +
          '<div class="flex items-center gap-2 min-w-0">' +
            '<span class="text-lg shrink-0">' + (c.icon || '\uD83D\uDCE6') + '</span>' +
            '<div class="min-w-0">' +
              '<p class="text-sm font-medium text-gray-700 truncate">' + escHtml(c.label) + '</p>' +
              '<p class="text-xs text-gray-400">' + escHtml(c.key) + '</p>' +
            '</div>' +
          '</div>' +
          '<div class="flex items-center gap-2 shrink-0">' +
            '<div class="flex items-center gap-1">' +
              '<span class="text-xs text-gray-500">RD$</span>' +
              '<input type="number" min="0" step="0.01" value="' + Number(c.precio).toFixed(2) + '"' +
                ' onchange="window.actualizarPrecioCategoria(' + c.id + ', this.value)"' +
                ' class="w-20 px-2 py-1 border border-gray-300 rounded text-xs text-center focus:outline-none focus:ring-1 focus:ring-blue-400">' +
            '</div>' +
            '<button onclick="window.eliminarCategoriaTipo(' + c.id + ', ' + JSON.stringify(c.label) + ')" class="text-red-400 hover:text-red-600 text-xs shrink-0">\u2715</button>' +
          '</div>' +
        '</div>';
      }).join('');
      catsHtml = '<div class="px-5 py-3"><div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">' + catItems + '</div></div>';
    } else {
      catsHtml = '<div class="px-5 py-4 text-center text-sm text-gray-400">Sin categor\u00edas. Agrega una.</div>';
    }

    return '<div class="bg-white border border-gray-200 rounded-xl overflow-hidden">' +
      '<div class="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-200">' +
        '<div class="flex items-center gap-3">' +
          '<span class="font-semibold text-gray-800">' + escHtml(t.label) + '</span>' +
          '<span class="text-xs text-gray-400 bg-gray-200 px-2 py-0.5 rounded">' + escHtml(t.nombre) + '</span>' +
        '</div>' +
        '<div class="flex items-center gap-2">' +
          '<button onclick="window.agregarCategoriaTipo(' + t.id + ')" class="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1 px-2 py-1 hover:bg-blue-50 rounded-lg transition-colors"><span>\u2795</span> Categor\u00eda</button>' +
          '<button onclick="window.editarTipoServicio(' + t.id + ', ' + JSON.stringify(t.label) + ')" class="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 hover:bg-gray-100 rounded-lg transition-colors">\u270F\uFE0F</button>' +
          '<button onclick="window.eliminarTipoServicio(' + t.id + ', ' + JSON.stringify(t.label) + ')" class="text-xs text-red-500 hover:text-red-700 px-2 py-1 hover:bg-red-50 rounded-lg transition-colors">\uD83D\uDDD1\uFE0F</button>' +
        '</div>' +
      '</div>' + catsHtml + '</div>';
  }).join('');
};

window.actualizarPrecioCategoria = async function (catId, precio) {
  try {
    await api('PUT', '/api/tipos-servicio/1/categorias/' + catId, { precio: parseFloat(precio) || 0 });
  } catch (e) {
    console.error('Error actualizando precio:', e);
  }
};

window.agregarCategoriaTipo = function (tipoId) {
  var key = prompt('Nombre clave (key) de la categor\u00eda (ej: cerradura, control_acceso):');
  if (!key) return;
  var label = prompt('Etiqueta visible (ej: Cerradura Electr\u00f3nica):');
  if (!label) return;
  var precio = parseFloat(prompt('Precio (RD$):', '0')) || 0;
  api('POST', '/api/tipos-servicio/' + tipoId + '/categorias', { key: key, label: label, precio: precio })
    .then(function() { toast('Categor\u00eda agregada', 'success'); renderTiposServicioConfig(); })
    .catch(function(e) { toast('Error: ' + e.message, 'error'); });
};

window.eliminarCategoriaTipo = async function (catId, label) {
  if (!confirm('\u00BFDesactivar categor\u00EDa "' + label + '"?')) return;
  try {
    await api('DELETE', '/api/tipos-servicio/1/categorias/' + catId);
    toast('Categor\u00EDa desactivada', 'success');
    renderTiposServicioConfig();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
};

window.abrirModalNuevoTipo = function () {
  var nombre = prompt('Nombre interno (ej: proyecto_nuevo):');
  if (!nombre) return;
  var label = prompt('Nombre visible (ej: Proyecto Nuevo):');
  if (!label) return;
  api('POST', '/api/tipos-servicio', { nombre: nombre, label: label })
    .then(function() { toast('Tipo de servicio creado', 'success'); renderTiposServicioConfig(); })
    .catch(function(e) { toast('Error: ' + e.message, 'error'); });
};

window.editarTipoServicio = function (id, labelActual) {
  var label = prompt('Nuevo nombre visible:', labelActual);
  if (!label) return;
  api('PUT', '/api/tipos-servicio/' + id, { label: label })
    .then(function() { toast('Tipo actualizado', 'success'); renderTiposServicioConfig(); })
    .catch(function(e) { toast('Error: ' + e.message, 'error'); });
};

window.eliminarTipoServicio = function (id, label) {
  if (!confirm('\u00BFDesactivar tipo de servicio "' + label + '" y todas sus categor\u00EDas?')) return;
  api('DELETE', '/api/tipos-servicio/' + id)
    .then(function() { toast('Tipo desactivado', 'success'); renderTiposServicioConfig(); })
    .catch(function(e) { toast('Error: ' + e.message, 'error'); });
};