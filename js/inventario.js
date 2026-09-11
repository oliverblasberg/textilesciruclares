// ═══════════════════════════════════════════════════════════════════
// js/inventario.js — Fase 6 de la división del monolito (10/Sep/2026)
//
// Script CLÁSICO, no ES Module — mismo criterio que utils.js/constantes.js/
// helpers-calculo.js/bancos.js/contabilidad.js: index.html usa
// onclick="funcName()" en cientos de lugares, lo que exige funciones
// globales. Se carga ANTES del script principal, después de contabilidad.js.
//
// Contenido: Kardex (vista + export CSV), Stock Actual (listado + drill a
// lotes), Motor FIFO de alto nivel (calcStock(), wrapper de
// calcStockFIFO() — el núcleo puro ya vivía en helpers-calculo.js desde la
// Fase 3), y el módulo INVENTARIO propiamente dicho: crearMovimiento() (el
// escritor central del Kardex, llamado desde compras/ventas/producción vía
// crearMovimientoConAsiento() en contabilidad.js), el listado de Movimientos,
// y Ajustes de Inventario (CRUD + consignación).
//
// DEPENDENCIAS EXTERNAS (resueltas en tiempo de ejecución, no de carga —
// todas las llamadas ocurren tras el arranque de la app):
//   · js/utils.js            → fmtDate, fmtMoney, fmtGTQ, fmtNum, today
//   · js/constantes.js       → KX_TIPO_LABEL, KX_TIPO_COLOR, KX_ES_ENTRADA
//   · js/helpers-calculo.js  → calcStockFIFO, calcCostoSalidaFIFO, periodoFechas
//   · index.html (principal) → state, sb, toast, openModal, closeModal,
//                              loadAll, logAuditoria, getTCFecha, tcHoy,
//                              costoConversionPredeterminado
//
// PERF (P2-3 del checklist, aprovechado en esta extracción): calcStockPorLote()
// ahora acepta un tercer parámetro opcional con los movimientos YA filtrados
// por producto, y renderStock() agrupa state.movimientos por producto UNA
// sola vez antes del loop — antes era cuadrático (una pasada completa de
// TODO state.movimientos por cada producto listado).
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// MÓDULO: KARDEX
// ═══════════════════════════════════════════════════

let kardexProductoId = null;

// KX_TIPO_LABEL, KX_TIPO_COLOR, KX_ES_ENTRADA viven ahora en js/constantes.js

function onKardexPeriodoChange() {
  const p = document.getElementById('kardex-periodo')?.value;
  const isPers = p === 'personalizado';
  document.getElementById('kardex-desde').style.display = isPers ? '' : 'none';
  document.getElementById('kardex-hasta').style.display = isPers ? '' : 'none';
  renderKardex();
}

function kardexGetFechas() {
  const p = document.getElementById('kardex-periodo')?.value || 'mes';
  if (p === 'personalizado') {
    return {
      desde: document.getElementById('kardex-desde').value || '',
      hasta: document.getElementById('kardex-hasta').value || '',
    };
  }
  if (p === 'todo') return { desde: '', hasta: '' };
  return periodoFechas(p === 'trimestre' ? 'trimestre' : p === 'anio' ? 'anio' : 'mes');
}

function kardexBuscarProducto() {
  const q = (document.getElementById('kardex-search-prod')?.value || '').toLowerCase().trim();
  const resultsEl = document.getElementById('kardex-search-results');
  if (!q || q.length < 2) {
    if (resultsEl) resultsEl.style.display = 'none';
    return;
  }
  const matches = state.productos.filter(p =>
    (p.codigo_interno||p.code||'').toLowerCase().includes(q) ||
    (p.description||'').toLowerCase().includes(q)
  ).slice(0, 9);

  if (!matches.length) {
    resultsEl.style.display = 'none'; return;
  }

  const TIPO_LABEL = { tela:'Tela', hilo:'Hilo', insumo:'Insumo', servicio:'Servicio' };
  resultsEl.style.display = 'grid';
  resultsEl.innerHTML = matches.map(p => `
    <div onclick="kardexSeleccionarProducto('${p.id}')"
      style="padding:10px 14px;border:1.5px solid var(--border);border-radius:8px;cursor:pointer;transition:all 0.12s"
      onmouseenter="this.style.borderColor='var(--accent)';this.style.background='var(--accent-bg)'"
      onmouseleave="this.style.borderColor='var(--border)';this.style.background=''">
      <div style="font-size:11px;color:var(--text3);font-weight:600">${TIPO_LABEL[p.tipo]||p.tipo||''}</div>
      <div style="font-weight:600;font-size:13.5px;margin:2px 0">${p.description||'—'}</div>
      <div style="font-size:11px;font-family:'DM Mono',monospace;color:var(--accent)">${p.codigo_interno||p.code||'—'}</div>
    </div>`).join('');
}

function kardexSeleccionarProducto(productoId) {
  kardexProductoId = productoId;
  const prod = state.productos.find(p => p.id === productoId);
  // Update search box
  const searchEl = document.getElementById('kardex-search-prod');
  if (searchEl) searchEl.value = `${prod?.code||''} — ${prod?.description||''}`;
  // Hide search results
  const resultsEl = document.getElementById('kardex-search-results');
  if (resultsEl) resultsEl.style.display = 'none';
  // Refresh bodega dropdown
  refreshBodegaDropdowns();
  renderKardex();
}

function renderKardex() {
  if (!kardexProductoId) return;
  const prod    = state.productos.find(p => p.id === kardexProductoId);
  if (!prod) return;

  const bodegaId = document.getElementById('kardex-bodega')?.value || '';
  const { desde, hasta } = kardexGetFechas();

  // All movements for this product sorted ASC (chronological for running balance)
  const todosMovs = state.movimientos
    .filter(m => m.producto_id === kardexProductoId)
    .sort((a,b) => a.fecha.localeCompare(b.fecha) || (a.created_at||'').localeCompare(b.created_at||''));

  // Movements in period (and bodega filter)
  const movsEnPeriodo = todosMovs.filter(m =>
    (!bodegaId || m.bodega_id === bodegaId) &&
    (!desde    || m.fecha >= desde) &&
    (!hasta    || m.fecha <= hasta)
  );

  // ── Build FIFO kardex lines ──────────────────────────────────
  // Compute saldo FIFO before the period for opening balance
  const capasAntes = [];
  let ultimo_costo_antes = 0;
  if (desde) {
    todosMovs
      .filter(m => m.fecha < desde && (!bodegaId || m.bodega_id === bodegaId))
      .forEach(m => {
        const cant  = Number(m.cantidad||0);
        const costo = Number(m.costo_unitario_gtq||m.costo_unitario||0);
        if (m.tipo === 'entrada' || m.tipo === 'ajuste_positivo') {
          capasAntes.push({ cant, costo });
          if (costo > 0) ultimo_costo_antes = costo;
        } else if (m.tipo === 'consignacion') {
          capasAntes.push({ cant, costo: 0 });
        } else {
          let por = cant;
          while (por > 0 && capasAntes.length) {
            if (capasAntes[0].cant <= por) { por -= capasAntes[0].cant; capasAntes.shift(); }
            else { capasAntes[0].cant -= por; por = 0; }
          }
          if (por > 0) capasAntes.unshift({ cant: -por, costo: ultimo_costo_antes });
        }
      });
  }

  // Clone capas for the period run
  const capas = capasAntes.map(c => ({...c}));
  let ultimo_costo = ultimo_costo_antes || 0;

  const saldoAntes    = capas.reduce((s,c) => s+c.cant, 0);
  const valorAntes    = capas.reduce((s,c) => s+c.cant*c.costo, 0);
  const costoAntes    = saldoAntes > 0 ? valorAntes / saldoAntes : 0;

  let saldo      = saldoAntes;
  let valorTotal = valorAntes; // FIFO: sum of remaining layer values

  // ── Category info ──
  const cat = state.categorias.find(c => c.id === prod.categoria);
  const TIPO_LABEL_P = { tela:'Tela', hilo:'Hilo', insumo:'Insumo', servicio:'Servicio' };

  // ── Show product header ──
  document.getElementById('kardex-resumen').style.display = 'block';
  document.getElementById('kx-prod-nombre').textContent = prod.description||'—';
  document.getElementById('kx-prod-codigo').textContent = prod.code||'—';
  document.getElementById('kx-prod-tipo').textContent   = TIPO_LABEL_P[prod.tipo]||prod.tipo||'';

  // ── Render table ──
  const tbody = document.getElementById('tbl-kardex-body');
  if (!tbody) return;

  let totalEntradas = 0, totalSalidas = 0, totalCostoMov = 0;
  // Movimientos del período — se acumulan en un array en vez de un string
  // concatenado porque el cálculo FIFO (capas/saldo/valorTotal) tiene que
  // recorrerse en orden cronológico ASC, pero la tabla se muestra de más
  // nuevo a más viejo (10/Sep/2026, a pedido explícito) — se arma el HTML
  // de cada fila en el mismo orden del cálculo y se invierte solo al
  // renderizar, sin tocar la lógica de saldo corrido.
  let movRows = [];

  // Saldo inicial (si se filtra por período): queda al FINAL de la tabla al
  // mostrar de más nuevo a más viejo — cronológicamente es el punto más
  // antiguo, anterior a todos los movimientos listados.
  let openingRowHtml = '';
  if (desde && saldoAntes !== 0) {
    openingRowHtml = `<tr style="background:#F8F9FA;font-style:italic">
      <td colspan="7" style="padding:8px 14px;font-size:12px;color:var(--text2);font-weight:600">
        Saldo inicial al ${fmtDate(desde)}
      </td>
      <td colspan="2"></td>
      <td class="td-mono" style="text-align:right;font-weight:700;color:var(--text2)">${fmtNum(saldoAntes)}</td>
      <td class="td-mono" style="text-align:right;color:var(--text3)">${costoAntes>0?fmtMoney(costoAntes):'—'}</td>
      <td></td>
      <td class="td-mono" style="text-align:right;color:var(--text2)">${fmtMoney(valorAntes)}</td>
      <td></td>
    </tr>`;
  }

  movsEnPeriodo.forEach(m => {
    const cant  = Number(m.cantidad||0);
    const costo = Number(m.costo_unitario_gtq||m.costo_unitario||0);
    const isCon = m.tipo === 'consignacion';
    const isE   = KX_ES_ENTRADA(m.tipo);

    let costoMov = 0; // costo real de este movimiento en FIFO

    if (isE) {
      // FIFO entry: push layer
      capas.push({ cant, costo: isCon ? 0 : costo });
      saldo      += cant;
      if (!isCon) { valorTotal += cant * costo; costoMov = cant * costo; }
      if (costo > 0) ultimo_costo = costo;
      totalEntradas += cant;
    } else {
      // FIFO exit: consume from front of queue
      let porConsumir = cant;
      let costoSalida = 0;
      while (porConsumir > 0 && capas.length) {
        const capa = capas[0];
        const usado = Math.min(capa.cant, porConsumir);
        costoSalida   += usado * capa.costo;
        porConsumir   -= usado;
        capa.cant     -= usado;
        if (capa.cant <= 0) capas.shift();
      }
      // Negative stock edge case
      if (porConsumir > 0) capas.unshift({ cant: -porConsumir, costo: ultimo_costo });
      saldo      -= cant;
      valorTotal  = capas.reduce((s,c) => s + c.cant * c.costo, 0);
      costoMov    = costoSalida;
      totalSalidas += cant;
    }
    totalCostoMov += costoMov;

    const costoUnitFIFO = isE ? costo : (cant > 0 ? costoMov / cant : 0);
    const valInv = Math.max(0, valorTotal);

    const fechaFmt = fmtDate(m.fecha);
    const bodega = (state.bodegas||[]).find(b => b.id === m.bodega_id);
    const ref = [m.referencia_tipo, m.referencia_id].filter(Boolean).join(' — ') || '—';
    const saldoColor = saldo > 0 ? 'var(--text)' : saldo < 0 ? 'var(--red)' : 'var(--text3)';

    movRows.push(`<tr>
      <td style="white-space:nowrap;font-size:12px">${fechaFmt}</td>
      <td class="td-mono" style="font-size:11px;color:var(--accent)">${m.mov_id||'—'}</td>
      <td><span class="badge ${KX_TIPO_COLOR[m.tipo]||'badge-gray'}" style="font-size:10px">${KX_TIPO_LABEL[m.tipo]||m.tipo}</span></td>
      <td style="font-size:12px;color:var(--text2);max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${ref}">${ref}</td>
      <td style="font-size:11px;color:var(--text3)">${bodega ? bodega.codigo : '—'}</td>
      <td>${m.lote ? `<span class="badge badge-blue" style="font-family:'DM Mono',monospace;font-size:10px">${m.lote}</span>` : '<span style="color:var(--text3);font-size:11px">—</span>'}</td>
      <td style="font-size:11px;color:var(--text2)">${m.poliza||'—'}</td>
      <td class="td-mono" style="text-align:right;color:var(--green);font-weight:${isE?'600':'400'}">
        ${isE ? fmtNum(cant) : ''}
      </td>
      <td class="td-mono" style="text-align:right;color:var(--red);font-weight:${!isE?'600':'400'}">
        ${!isE ? fmtNum(cant) : ''}
      </td>
      <td class="td-mono" style="text-align:right;font-weight:700;color:${saldoColor}">${fmtNum(saldo)}</td>
      <td class="td-mono" style="text-align:right;font-size:12px">
        ${isCon ? '<span style="color:var(--text3);font-size:11px">Consig.</span>' : (costoUnitFIFO>0 ? fmtMoney(costoUnitFIFO) : '—')}
      </td>
      <td class="td-mono" style="text-align:right;font-size:12px">
        ${isCon ? '<span style="color:var(--text3);font-size:11px">$0.00</span>' : (costoMov>0 ? fmtMoney(costoMov) : '—')}
      </td>
      <td class="td-mono" style="text-align:right;color:var(--accent3);font-weight:600">
        ${valInv>0 ? fmtMoney(valInv) : saldo===0?'$0.00':'—'}
      </td>
      <td style="font-size:11px;color:var(--text3);max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${m.notas||''}">${m.notas||'—'}</td>
    </tr>`);
  });

  // De más nuevo a más viejo (10/Sep/2026, a pedido explícito): se invierte
  // solo el orden de despliegue — el cálculo de arriba corrió en ASC porque
  // el FIFO/saldo corrido lo exige. El saldo inicial queda al final (es el
  // punto más antiguo del período).
  const rows = movRows.slice().reverse().join('') + openingRowHtml;
  tbody.innerHTML = rows || `<tr><td colspan="12" style="text-align:center;padding:32px;color:var(--text3)">Sin movimientos en el período seleccionado</td></tr>`;

  // ── Footer totals ──
  const costoFIFOfinal = saldo > 0 && valorTotal > 0 ? valorTotal / saldo : 0;
  const valFinal       = Math.max(0, valorTotal);
  const foot = document.getElementById('tbl-kardex-foot');
  if (foot) foot.innerHTML = movsEnPeriodo.length ? `
    <tr style="background:var(--surface2);font-weight:600;border-top:2px solid var(--border)">
      <td colspan="7" style="padding:10px 14px;font-size:12px;color:var(--text2)">TOTALES DEL PERÍODO</td>
      <td class="td-mono" style="text-align:right;padding:10px 14px;color:var(--green)">${fmtNum(totalEntradas)}</td>
      <td class="td-mono" style="text-align:right;padding:10px 14px;color:var(--red)">${fmtNum(totalSalidas)}</td>
      <td class="td-mono" style="text-align:right;padding:10px 14px;font-weight:700;color:${saldo>0?'var(--green)':saldo<0?'var(--red)':'var(--text3)'}">${fmtNum(saldo)}</td>
      <td class="td-mono" style="text-align:right;padding:10px 14px">${costoFIFOfinal>0?fmtMoney(costoFIFOfinal):'—'}</td>
      <td class="td-mono" style="text-align:right;padding:10px 14px;color:var(--text)">${fmtMoney(totalCostoMov)}</td>
      <td class="td-mono" style="text-align:right;padding:10px 14px;color:var(--accent3);font-weight:700">${fmtMoney(valFinal)}</td>
      <td></td>
    </tr>` : '';

  // ── Update header stats ──
  const stockColor = saldo > 0 ? 'var(--green)' : saldo < 0 ? 'var(--red)' : 'var(--text3)';
  document.getElementById('kx-stock-actual').textContent = fmtNum(saldo);
  document.getElementById('kx-stock-actual').style.color = stockColor;
  document.getElementById('kx-stock-unidad').textContent = prod.unidad||'';
  document.getElementById('kx-costo-avco').textContent   = costoFIFOfinal>0 ? fmtMoney(costoFIFOfinal) : '—';
  document.getElementById('kx-valoracion').textContent   = valFinal>0        ? fmtMoney(valFinal)       : '—';
  document.getElementById('kx-categoria').textContent    = cat?.nombre||'Sin categoría';
  document.getElementById('kx-metodo-costo').textContent = 'Método: FIFO';

  // ── Period stats ──
  document.getElementById('kx-total-entradas').textContent     = fmtNum(totalEntradas);
  document.getElementById('kx-total-salidas').textContent      = fmtNum(totalSalidas);
  document.getElementById('kx-num-movs').textContent           = movsEnPeriodo.length;
  document.getElementById('kx-costo-total-periodo').textContent = fmtMoney(totalCostoMov);

  // ── Period label ──
  const pl = document.getElementById('kx-periodo-label');
  if (pl) {
    if (!desde && !hasta) pl.textContent = 'Todo el historial';
    else if (desde && hasta) pl.textContent = `${fmtDate(desde)} al ${fmtDate(hasta)}`;
    else if (desde) pl.textContent = `Desde ${fmtDate(desde)}`;
  }
}

function exportarKardex() {
  if (!kardexProductoId) { toast('Selecciona un producto primero','error'); return; }
  const prod = state.productos.find(p => p.id === kardexProductoId);
  const bodegaId = document.getElementById('kardex-bodega')?.value||'';
  const { desde, hasta } = kardexGetFechas();

  const movs = state.movimientos
    .filter(m =>
      m.producto_id === kardexProductoId &&
      (!bodegaId || m.bodega_id === bodegaId) &&
      (!desde || m.fecha >= desde) &&
      (!hasta || m.fecha <= hasta)
    )
    .sort((a,b) => a.fecha.localeCompare(b.fecha));

  const capasExp = []; let saldoExp = 0, valorExp = 0, ucExp = 0;
  const rows = [['Fecha','No.Mov','Tipo','Referencia','Bodega','Lote','Poliza','Entrada','Salida','Saldo','Costo Unit. FIFO','Costo Total FIFO','Valor Inv. FIFO','Notas']];
  movs.forEach(m => {
    const cant = Number(m.cantidad||0);
    const costo = Number(m.costo_unitario_gtq||m.costo_unitario||0);
    const isE = KX_ES_ENTRADA(m.tipo);
    const isCon = m.tipo === 'consignacion';
    let costoMov = 0, cu = 0;
    if (isE) {
      capasExp.push({ cant, costo: isCon ? 0 : costo });
      saldoExp += cant;
      if (!isCon) { valorExp += cant*costo; costoMov = cant*costo; cu = costo; }
      if (costo > 0) ucExp = costo;
    } else {
      let por = cant, cs = 0;
      while (por > 0 && capasExp.length) {
        const c = capasExp[0]; const u = Math.min(c.cant, por);
        cs += u*c.costo; por -= u; c.cant -= u;
        if (c.cant <= 0) capasExp.shift();
      }
      saldoExp -= cant;
      valorExp = capasExp.reduce((s,c) => s+c.cant*c.costo, 0);
      costoMov = cs; cu = cant > 0 ? cs/cant : 0;
    }
    const bodega = (state.bodegas||[]).find(b=>b.id===m.bodega_id);
    rows.push([
      m.fecha, m.mov_id, KX_TIPO_LABEL[m.tipo]||m.tipo,
      [m.referencia_tipo, m.referencia_id].filter(Boolean).join(' - '),
      bodega?.codigo||'',
      m.lote||'', m.poliza||'',
      isE ? cant : '', !isE ? cant : '',
      saldoExp, isCon ? 0 : cu,
      isCon ? 0 : costoMov,
      Math.max(0, valorExp),
      m.notas||''
    ]);
  });

  const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kardex_${prod?.code||'producto'}_${today()}.csv`;
  a.click();
  toast('Kardex exportado');
}

// ═══════════════════════════════════════════════════
// MÓDULO: STOCK ACTUAL
// ═══════════════════════════════════════════════════

// Calcula stock de todos los productos desde movimientos
// ═══════════════════════════════════════════════════
// MOTOR FIFO — First In, First Out
// ═══════════════════════════════════════════════════

/**
 * Calcula stock FIFO para todos los productos.
 * Retorna mapa: producto_id → {
 *   saldo, capas, costo_siguiente, valoracion,
 *   entradas, salidas, consignacion, ultimo_costo
 * }
 * capas = array de lotes FIFO pendientes [{ cant, costo }]
 * costo_siguiente = costo del próximo lote a consumir (para valoración)
 */
// calcStockFIFO() vive ahora en js/helpers-calculo.js

/**
 * Calcula el costo de una salida FIFO dado el estado actual de capas.
 * Útil para valorar una salida antes de registrarla.
 */
// calcCostoSalidaFIFO() vive ahora en js/helpers-calculo.js

/**
 * calcStock — wrapper FIFO que reemplaza el antiguo AVCO.
 * Acepta bodegaId opcional para filtrar por bodega.
 */
function calcStock(bodegaId = null) {
  const movsFiltrados = bodegaId
    ? state.movimientos.filter(m => m.bodega_id === bodegaId)
    : state.movimientos;
  return calcStockFIFO(movsFiltrados);
}


// Agrupación de Producto (20/Ago/2026): true si la categoría del producto
// exige elegir bultos/rollos específicos al recibir/despachar, en vez de
// solo capturar el peso neto. Ver modal-categoria (cat-agrupacion).
function productoTieneAgrupacion(prodId) {
  const prod = state.productos.find(p => p.id === prodId);
  const cat  = prod ? (state.categorias||[]).find(c => c.id === prod.categoria) : null;
  return !!(cat && cat.agrupacion_producto);
}

function calcStockPorLote(productoId, bodegaId = null, movsProducto = null) {
  // Perf (P2-3 del checklist, 10/Sep/2026): acepta opcionalmente la lista de
  // movimientos YA filtrada por producto (ver renderStock) para evitar
  // recorrer TODO state.movimientos una vez por cada fila del listado — con
  // 500 productos y 50,000 movimientos eso son 25M comparaciones por render.
  // Los demás llamadores (que invocan esta función una sola vez, no dentro
  // de un loop sobre todos los productos) siguen igual, filtrando desde
  // state.movimientos.
  const movs = (movsProducto || state.movimientos).filter(m =>
    m.producto_id === productoId &&
    (!bodegaId || m.bodega_id === bodegaId)
  );

  const porLote = {};
  movs.forEach(m => {
    const lote = m.lote || '(sin lote)';
    if (!porLote[lote]) porLote[lote] = {
      lote, entradas: 0, salidas: 0, saldo: 0, valoracion: 0,
      costo: 0, poliza: m.poliza||'', fecha: m.fecha||'',
      esConsignacion: false, consignacion_cliente: ''
    };
    const cant  = Number(m.cantidad||0);
    const costo = Number(m.costo_unitario_gtq||m.costo_unitario||0);
    if (m.tipo === 'entrada' || m.tipo === 'ajuste_positivo' || m.tipo === 'consignacion') {
      porLote[lote].entradas   += cant;
      porLote[lote].saldo      += cant;
      porLote[lote].valoracion += cant * costo;
      porLote[lote].costo       = costo;
      if (m.fecha > porLote[lote].fecha) {
        porLote[lote].poliza = m.poliza||'';
        porLote[lote].fecha  = m.fecha;
      }
      if (m.tipo === 'consignacion') {
        porLote[lote].esConsignacion = true;
        porLote[lote].consignacion_cliente = m.consignacion_cliente_nombre || '';
      }
    } else if (m.tipo === 'salida' || m.tipo === 'ajuste_negativo') {
      porLote[lote].salidas    += cant;
      porLote[lote].saldo      -= cant;
      porLote[lote].valoracion -= cant * costo;
    }
  });

  return Object.values(porLote).filter(l => l.entradas > 0).sort((a,b) => a.fecha.localeCompare(b.fecha));
}

function openMovsLote(productoId, lote) {
  const prod = state.productos.find(p => p.id === productoId);
  // De más nuevo a más viejo (10/Sep/2026, a pedido explícito) — esta lista
  // no calcula saldo corrido, así que se puede ordenar DESC directamente.
  const movs = state.movimientos
    .filter(m => m.producto_id === productoId && m.lote === lote)
    .sort((a,b) => (b.fecha||'').localeCompare(a.fecha||'') || (b.created_at||'').localeCompare(a.created_at||''));

  document.getElementById('movs-lote-title').textContent = 'Lote: ' + lote;
  document.getElementById('movs-lote-sub').textContent   = (prod?.codigo_interno||prod?.code||'') + ' — ' + (prod?.description||'');

  // Cascada de bultos/rollos (20/Ago/2026, a pedido explícito): si la
  // categoría del producto usa Agrupación de Producto, mostrar los rollos
  // de este producto+lote (incluye eliminados/reabastecidos/despachados,
  // tachados, para trazabilidad — mismo criterio que Recepción de Tela).
  const rollosDiv = document.getElementById('movs-lote-rollos');
  if (rollosDiv) {
    if (productoTieneAgrupacion(productoId)) {
      const rollosLote = (state.rollos||[])
        .filter(r => r.producto_id === productoId && (r.lote||'(sin lote)') === lote)
        .sort((a,b) => (a.numero_rollo||'').localeCompare(b.numero_rollo||''));
      const ESTADO_LABEL = { disponible:'Disponible', despachado:'Despachado', reabastecido:'Reabastecido', eliminado:'Eliminado' };
      const ESTADO_COLOR = { disponible:'var(--green)', despachado:'var(--accent)', reabastecido:'var(--accent3)', eliminado:'var(--red)' };
      rollosDiv.innerHTML = !rollosLote.length ? '' : `
        <div style="margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:6px">Bultos / Rollos de este lote</div>
          <div class="table-wrap">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr style="background:var(--surface2)">
                <th style="padding:6px 12px;text-align:left;font-size:11px">Rollo</th>
                <th style="padding:6px 12px;text-align:right;font-size:11px">Peso</th>
                <th style="padding:6px 12px;text-align:left;font-size:11px">Estado</th>
                <th style="padding:6px 12px;text-align:left;font-size:11px">Uso / Referencia</th>
              </tr></thead>
              <tbody>${rollosLote.map(r => {
                const tachado = r.estado === 'eliminado' ? 'opacity:0.5;text-decoration:line-through' : '';
                const refTxt  = r.estado === 'despachado' ? 'Despacho a cliente'
                  : r.estado === 'reabastecido' ? `Reabastecimiento — ${r.reabastecido_en_numero||''}`
                  : '—';
                return `<tr style="${tachado}">
                  <td class="td-mono" style="padding:6px 12px;font-size:12px">${r.numero_rollo||'—'}</td>
                  <td class="td-mono" style="padding:6px 12px;text-align:right;font-size:12px">${fmtNum(r.peso_kg)} kg</td>
                  <td style="padding:6px 12px;font-size:11px;font-weight:600;color:${ESTADO_COLOR[r.estado]||'var(--text3)'}">${ESTADO_LABEL[r.estado]||r.estado||'—'}</td>
                  <td style="padding:6px 12px;font-size:11px;color:var(--text3)">${refTxt}</td>
                </tr>`;
              }).join('')}</tbody>
            </table>
          </div>
        </div>`;
    } else {
      rollosDiv.innerHTML = '';
    }
  }

  const MOV_COLOR = { entrada:'var(--green)', salida:'var(--red)', ajuste_positivo:'var(--green)', ajuste_negativo:'var(--red)', devolucion:'var(--accent)' };
  const MOV_LABEL = { entrada:'Entrada', salida:'Salida', ajuste_positivo:'Ajuste +', ajuste_negativo:'Ajuste −', devolucion:'Devolución', consignacion:'Consignación' };

  document.getElementById('tbl-movs-lote').innerHTML = movs.length ? movs.map(m => {
    const color = MOV_COLOR[m.tipo] || 'var(--text2)';
    return '<tr style="border-bottom:1px solid var(--border)">' +
      '<td class="td-mono" style="padding:7px 12px;font-size:12px">' + fmtDate(m.fecha) + '</td>' +
      '<td style="padding:7px 12px"><span style="font-size:11px;font-weight:600;color:' + color + '">' + (MOV_LABEL[m.tipo]||m.tipo) + '</span></td>' +
      '<td class="td-mono" style="padding:7px 12px;font-size:11px;color:var(--accent)">' + (m.referencia_id||m.referencia_tipo||'—') + '</td>' +
      '<td class="td-mono" style="padding:7px 12px;text-align:right;font-weight:700;color:' + color + '">' + (m.tipo==='salida'||m.tipo==='ajuste_negativo' ? '−' : '+') + fmtNum(Math.abs(m.cantidad||0)) + ' ' + (m.unidad||'') + '</td>' +
      '<td class="td-mono" style="padding:7px 12px;text-align:right;font-size:12px">' + (m.costo_unitario_gtq||m.costo_unitario ? fmtGTQ(m.costo_unitario_gtq||m.costo_unitario) : '—') + '</td>' +
      '<td class="td-mono" style="padding:7px 12px;text-align:right;font-size:12px;font-weight:600;color:var(--accent3)">' + (m.costo_total_gtq||m.costo_total ? fmtGTQ(m.costo_total_gtq||m.costo_total) : '—') + '</td>' +
      '<td style="padding:7px 12px;font-size:11px;color:var(--text3)">' + (m.notas||'—') + '</td>' +
      '</tr>';
  }).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text3)">Sin movimientos para este lote</td></tr>';

  openModal('modal-movs-lote');
}

function toggleStockLotes(prodId) {
  const rows = document.querySelectorAll(`[id^="stock-lote-${prodId}-"]`);
  if (!rows.length) return;
  const visible = rows[0].style.display !== 'none';
  rows.forEach(r => r.style.display = visible ? 'none' : '');
  const btn = document.getElementById(`stock-toggle-${prodId}`);
  if (btn) btn.textContent = visible ? '▶' : '▼';
}

function renderStock() {
  const q       = (document.getElementById('search-stock')?.value || '').toLowerCase();
  const tipo    = document.getElementById('filter-stock-tipo')?.value  || '';
  const estado  = document.getElementById('filter-stock-estado')?.value || '';
  const bodegaId = document.getElementById('filter-stock-bodega')?.value || null;

  const stockMap = calcStock(bodegaId || null);

  // Agrupación de movimientos por producto UNA sola vez (P2-3 del checklist,
  // 10/Sep/2026) — antes calcStockPorLote() se llamaba una vez POR PRODUCTO
  // dentro del loop de abajo, y cada llamada volvía a filtrar TODO
  // state.movimientos desde cero (cuadrático: 500 productos × 50,000
  // movimientos = 25M comparaciones por render). Ahora se agrupa una sola
  // vez aquí y se le pasa a calcStockPorLote() ya filtrado por producto.
  const movsPorProducto = {};
  state.movimientos.forEach(m => {
    if (!movsPorProducto[m.producto_id]) movsPorProducto[m.producto_id] = [];
    movsPorProducto[m.producto_id].push(m);
  });

  // Build rows: one per producto that has movements OR all productos
  const productosSeen = new Set([
    ...Object.keys(stockMap),
    ...state.productos.filter(p => p.tipo !== 'servicio').map(p => p.id),
  ]);

  const STOCK_TIPO_LABEL = { tela:'Tela', hilo:'Hilo', insumo:'Insumo', servicio:'Servicio', almacenable:'Almacenable' };
  const STOCK_TIPO_BADGE = { tela:'badge-blue', hilo:'badge-green', insumo:'badge-yellow', servicio:'badge-gray', almacenable:'badge-blue' };

  let rows = [];
  productosSeen.forEach(pid => {
    const prod = state.productos.find(p => p.id === pid);
    if (!prod) return;
    const s = stockMap[pid] || { saldo: 0, entradas: 0, salidas: 0, valoracion: 0, consignacion: 0, costo_siguiente: 0, ultimo_costo: 0 };
    const actual       = s.saldo;
    const costoFIFO    = (s.saldo_valorizado > 0 && s.valoracion > 0) ? s.valoracion / s.saldo_valorizado : (s.costo_siguiente || s.ultimo_costo);
    const valoracion   = actual > 0 ? s.valoracion : 0;
    const cat = state.categorias.find(c => c.id === prod.categoria);

    // Filters
    if (tipo   && prod.tipo !== tipo) return;
    if (estado === 'positivo' && actual <= 0) return;
    if (estado === 'cero'     && actual !== 0) return;
    if (estado === 'negativo' && actual >= 0) return;
    if (q && !(prod.code||'').toLowerCase().includes(q) &&
             !(prod.description||'').toLowerCase().includes(q)) return;

    rows.push({ prod, s, actual, costoFIFO, valoracion, cat });
  });

  // Sort by description
  rows.sort((a,b) => (a.prod.description||'').localeCompare(b.prod.description||''));

  // Summary cards
  const totalProductos  = rows.length;
  const conStock        = rows.filter(r => r.actual > 0).length;
  const sinStock        = rows.filter(r => r.actual <= 0).length;
  const valorTotal      = rows.reduce((s, r) => s + Math.max(0, r.valoracion), 0);

  const cards = document.getElementById('stock-summary-cards');
  if (cards) cards.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Productos con Stock</div>
      <div class="stat-value" style="font-size:26px">${conStock}</div>
      <div class="stat-sub">de ${totalProductos} productos</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Sin Existencias</div>
      <div class="stat-value" style="font-size:26px;color:var(--red)">${sinStock}</div>
      <div class="stat-sub">requieren reabastecimiento</div>
    </div>
    <div class="stat-card" style="grid-column:span 2">
      <div class="stat-label">Valoración Total del Inventario</div>
      <div class="stat-value" style="font-size:26px;color:var(--accent3)">${fmtMoney(valorTotal)}</div>
      <div class="stat-sub">valoración FIFO</div>
    </div>`;

  // Table
  const tbody = document.getElementById('tbl-stock');
  if (!tbody) return;

  let totEntradas = 0, totSalidas = 0, totValoracion = 0;

  tbody.innerHTML = rows.length ? rows.map(({ prod, s, actual, costoFIFO, valoracion, cat }) => {
    totEntradas   += s.entradas;
    totSalidas    += s.salidas;
    totValoracion += Math.max(0, valoracion);

    const stockColor = actual > 0 ? 'var(--green)' : actual < 0 ? 'var(--red)' : 'var(--text3)';
    const stockBg    = actual > 0 ? 'var(--green-bg)' : actual < 0 ? 'var(--red-bg)' : 'var(--surface2)';

    const lotes    = calcStockPorLote(prod.id, bodegaId || null, movsPorProducto[prod.id] || []);
    const hasLotes = lotes.length > 0;

    const toggleAttr = hasLotes ? ' onclick="toggleStockLotes(\'' + prod.id + '\')"' : '';
    const toggleIcon = hasLotes ? '<span id="stock-toggle-' + prod.id + '" style="margin-right:6px;font-size:10px;color:var(--text3)">▶</span>' : '';
    const consigDiv  = '';
    const composDiv  = prod.composicion ? '<div style="font-size:11px;color:var(--text3)">' + prod.composicion + '</div>' : '';

    const mainRow =
      '<tr style="cursor:' + (hasLotes?'pointer':'') + '"' + toggleAttr + '>' +
      '<td class="td-mono" style="font-weight:600;color:var(--accent);font-size:12px">' + toggleIcon + (prod.codigo_interno||prod.code||'—') + '</td>' +
      '<td><div style="font-weight:500;font-size:13.5px">' + (prod.description||'—') + '</div>' + composDiv + '</td>' +
      '<td><span class="badge ' + (STOCK_TIPO_BADGE[prod.tipo]||'badge-gray') + '">' + (STOCK_TIPO_LABEL[prod.tipo]||prod.tipo||'—') + '</span></td>' +
      '<td style="font-size:12px;color:var(--text2)">' + (cat?.nombre||'—') + '</td>' +
      '<td class="hide-mobile" style="font-size:12px;color:var(--text2)">' + (prod.unidad||'—') + '</td>' +
      '<td class="td-mono" style="text-align:right;color:var(--green)">' + fmtNum(s.entradas) + '</td>' +
      '<td class="td-mono" style="text-align:right;color:var(--red)">' + fmtNum(s.salidas) + '</td>' +
      '<td style="text-align:right"><span style="background:' + stockBg + ';color:' + stockColor + ';font-family:\'DM Mono\',monospace;font-size:13px;font-weight:700;padding:3px 10px;border-radius:6px;display:inline-block">' + fmtNum(actual) + '</span>' + consigDiv + '</td>' +
      '<td class="td-mono" style="text-align:right;font-size:12px">' + (costoFIFO>0 ? fmtGTQ(costoFIFO) : '—') + '</td>' +
      '<td class="td-mono" style="text-align:right;color:var(--accent3);font-weight:600">' + (actual>0 ? fmtGTQ(valoracion) : '—') + '</td>' +
      '</tr>';

    // Lote subrows (hidden by default)
    let loteRows = '';
    if (hasLotes) {
      loteRows = lotes.map(l => {
        const loteId = 'stock-lote-' + prod.id + '-' + l.lote.replace(/[^a-zA-Z0-9]/g,'_');
        return '<tr id="' + loteId + '" style="display:none;background:var(--surface);cursor:pointer;border-bottom:1px solid var(--border)" onclick="openMovsLote(\'' + prod.id + '\',\'' + l.lote + '\')">' +
          '<td style="padding:4px 12px 4px 24px;font-size:11px;color:var(--text3)">↳</td>' +
          '<td class="td-mono" style="padding:4px 12px;font-size:11px;font-weight:600;color:var(--accent)">' + l.lote +
        (l.esConsignacion ? ' <span style="font-size:9px;background:#EFF6FF;color:#3B82F6;padding:1px 5px;border-radius:4px;font-weight:700">CONSIG.</span>' : '') +
        (l.consignacion_cliente ? ' <span style="font-size:10px;color:var(--text3)">· ' + l.consignacion_cliente + '</span>' : '') +
        '</td>' +
          '<td style="padding:4px 12px"></td>' +
          '<td style="padding:4px 12px"></td>' +
          '<td class="td-mono" style="padding:4px 12px;font-size:11px;color:var(--text2)">' + (prod.unidad||'—') + '</td>' +
          '<td class="td-mono" style="padding:4px 12px;text-align:right;font-size:11px;color:var(--green)">' + fmtNum(l.entradas) + '</td>' +
          '<td class="td-mono" style="padding:4px 12px;text-align:right;font-size:11px;color:var(--red)">' + fmtNum(l.salidas) + '</td>' +
          '<td style="padding:4px 12px;text-align:right"><span style="font-family:\'DM Mono\',monospace;font-size:12px;font-weight:700">' + fmtNum(l.saldo) + '</span></td>' +
          '<td class="td-mono" style="padding:4px 12px;text-align:right;font-size:11px">' + (l.costo>0?fmtGTQ(l.costo):'—') + '</td>' +
          '<td class="td-mono" style="padding:4px 12px;text-align:right;font-size:11px;color:var(--accent3)">' + (l.saldo>0?fmtGTQ(l.valoracion):'—') + '</td>' +
          '</tr>';
      }).join('');
    }

    return mainRow + loteRows;
  }).join('') :
  '<tr><td colspan="11"><div class="empty-state"><div class="empty-icon">◈</div><p>Sin productos en inventario</p></div></td></tr>';

  const tfoot = document.getElementById('tfoot-stock');
  if (tfoot && rows.length) tfoot.innerHTML = `
    <tr style="background:var(--surface2);font-weight:600;border-top:2px solid var(--border)">
      <td colspan="5" style="padding:10px 14px;font-size:12px;color:var(--text2)">TOTALES (${rows.length} productos)</td>
      <td class="td-mono" style="text-align:right;padding:10px 14px;color:var(--green)">${fmtNum(totEntradas)}</td>
      <td class="td-mono" style="text-align:right;padding:10px 14px;color:var(--red)">${fmtNum(totSalidas)}</td>
      <td colspan="2" style="padding:10px 14px"></td>
      <td class="td-mono" style="text-align:right;padding:10px 14px;color:var(--accent3);font-weight:700">${fmtMoney(totValoracion)}</td>
      <td></td>
    </tr>`;
}

// fmtNum() vive ahora en js/utils.js (cargado antes de este script).

function openStockDetalle(productoId) {
  const prod = state.productos.find(p => p.id === productoId);
  const movs = state.movimientos
    .filter(m => m.producto_id === productoId)
    .sort((a,b) => new Date(a.fecha) - new Date(b.fecha));

  const stockMap = calcStock();
  const s = stockMap[productoId] || { saldo: 0, valoracion: 0, entradas: 0, salidas: 0, costo_siguiente: 0 };
  const actual    = s.saldo;
  const costoFIFO = (s.saldo_valorizado > 0 && s.valoracion > 0) ? s.valoracion / s.saldo_valorizado : s.costo_siguiente || 0;
  const valoracion = actual > 0 ? s.valoracion : 0;

  document.getElementById('modal-stock-title').textContent =
    `${prod?.code || ''} — ${prod?.description || 'Producto'}`;

  document.getElementById('stock-detalle-info').innerHTML = `
    <div style="display:flex;gap:24px;flex-wrap:wrap">
      <div><div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Stock Actual</div>
        <div style="font-size:22px;font-weight:700;color:${actual>0?'var(--green)':'var(--red)'}">${fmtNum(actual)} ${prod?.unidad||''}</div></div>
      <div><div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Costo FIFO</div>
        <div style="font-size:22px;font-weight:700;color:var(--accent3)">${costoFIFO>0?fmtMoney(costoFIFO):'—'}</div></div>
      <div><div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Valoración</div>
        <div style="font-size:22px;font-weight:700;color:var(--text)">${valoracion>0?fmtMoney(valoracion):'—'}</div></div>
      <div><div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Total movimientos</div>
        <div style="font-size:22px;font-weight:700;color:var(--text)">${movs.length}</div></div>
    </div>`;

  const TIPO_LABEL_MOV = {
    entrada:'Entrada', salida:'Salida',
    ajuste_positivo:'Ajuste +', ajuste_negativo:'Ajuste −'
  };
  const TIPO_COLOR = {
    entrada:'badge-green', salida:'badge-red',
    ajuste_positivo:'badge-green', ajuste_negativo:'badge-red'
  };

  // El cálculo de saldoCorrido sigue en ASC (obligatorio para que el saldo
  // corrido sea correcto), pero se invierte el array resultante antes de
  // unirlo — de más nuevo a más viejo (10/Sep/2026, a pedido explícito).
  let saldoCorrido = 0;
  document.getElementById('tbl-stock-movs').innerHTML = movs.length ? movs.map(m => {
    const cant = Number(m.cantidad||0);
    if (m.tipo==='entrada'||m.tipo==='ajuste_positivo'||m.tipo==='consignacion') saldoCorrido += cant;
    else saldoCorrido -= cant;
    return `<tr>
      <td class="td-mono" style="font-size:12px;color:var(--accent)">${m.mov_id||'—'}</td>
      <td style="white-space:nowrap">${fmtDate(m.fecha)}</td>
      <td><span class="badge ${TIPO_COLOR[m.tipo]||'badge-gray'}">${TIPO_LABEL_MOV[m.tipo]||m.tipo}</span></td>
      <td style="font-size:12px;color:var(--text2)">${m.referencia_tipo||''}${m.referencia_id?' — '+m.referencia_id:''}</td>
      <td class="td-mono" style="text-align:right;font-weight:600;color:${m.tipo==='entrada'||m.tipo==='ajuste_positivo'?'var(--green)':'var(--red)'}">
        ${m.tipo==='entrada'||m.tipo==='ajuste_positivo'?'+':'−'}${fmtNum(cant)}
      </td>
      <td class="td-mono" style="text-align:right">${Number(m.costo_unitario||0)>0?fmtMoney(m.costo_unitario):'—'}</td>
      <td class="td-mono" style="text-align:right">${Number(m.costo_total||0)>0?fmtMoney(m.costo_total):'—'}</td>
    </tr>`;
  }).reverse().join('') : '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text3)">Sin movimientos registrados</td></tr>';

  openModal('modal-stock-detalle');
}

// ═══ INVENTARIO ═══

const MOV_TIPO_LABEL = {
  entrada:          'Entrada',
  salida:           'Salida',
  ajuste_positivo:  'Ajuste +',
  ajuste_negativo:  'Ajuste −',
  consignacion:     'Consignación',
};
const MOV_TIPO_COLOR = {
  entrada:          'badge-green',
  salida:           'badge-red',
  ajuste_positivo:  'badge-blue',
  ajuste_negativo:  'badge-yellow',
  consignacion:     'badge-blue',
};

// BUGFIX (debugging en vivo, 13/Ago/2026): mismo problema — ver
// nextAsientoNum/nextOCNum/nextOPNum.
async function nextMovId() {
  // Generate next MV-YYYYNNNN correlative
  const year  = new Date().getFullYear();
  const { data } = await sb.from('erp_movimientos_inv').select('mov_id').ilike('mov_id', `MV-${year}-%`);
  const nums  = (data||[]).map(m => parseInt((m.mov_id||'').slice(-4))||0);
  const next  = (nums.length ? Math.max(...nums) : 0) + 1;
  return `MV-${year}-${String(next).padStart(4,'0')}`;
}

function getCategoriaNombre(categoriaId) {
  const c = state.categorias.find(x => x.id === categoriaId);
  return c ? c.nombre : '—';
}

// Helper to snapshot category accounts at time of movement
function snapshotCategoriaAccounts(categoriaId) {
  const c = state.categorias.find(x => x.id === categoriaId);
  if (!c) return {};
  return {
    snap_metodo_coste:  c.metodo_coste,
    snap_cta_valoracion: c.cta_valoracion,
    snap_cta_entrada:   c.cta_entrada,
    snap_cta_salida:    c.cta_salida,
    ...(c.cta_transito ? { snap_cta_transito: c.cta_transito } : {}),
    snap_diario_stock:  c.diario_stock,
    snap_cta_ingresos:  c.cta_ingresos,
    snap_cta_gasto:     c.cta_gasto,
  };
}

// ── PUBLIC: create a movement (called from OC, OV, ajuste) ──
async function crearMovimiento({ tipo, producto_id, cantidad, costo_unitario,
  referencia_tipo, referencia_id, notas, fecha, bodega_id,
  lote, poliza, proveedor_lote_id, lote_vence, moneda='GTQ',
  consignacion_cliente_id=null, consignacion_cliente_nombre=null }) {
  const prod       = state.productos.find(x => x.id === producto_id);
  const catId      = prod?.categoria || null;
  const snap       = snapshotCategoriaAccounts(catId);
  const costo_total = (parseFloat(cantidad)||0) * (parseFloat(costo_unitario)||0);
  const mov_id     = await nextMovId();

  // GTQ conversion — use best available TC for the transaction date
  const tc = getTCFecha(fecha || today()) || tcHoy() || 1;
  const esUSD = moneda === 'USD';
  const cu = parseFloat(costo_unitario||0);
  const costo_unitario_gtq = esUSD && tc > 1 ? parseFloat((cu * tc).toFixed(4)) : cu;
  const costo_total_gtq    = esUSD && tc > 1 ? parseFloat((costo_total * tc).toFixed(4)) : costo_total;
  // TC guardado explícitamente (26/Ago/2026). Antes se reconstruía dividiendo
  // costo_total_gtq/costo_total, lo que es imposible cuando el costo es cero —
  // caso real del hilo en consignación. Con la columna, el TC sobrevive
  // aunque el movimiento no tenga valor.
  const tipo_cambio = esUSD ? tc : 1;

  // BLOQUEO DE COSTO CERO EN COMPRAS (26/Ago/2026, a pedido explícito).
  // Costo cero es LEGÍTIMO solo en consignación: el hilo de terceros se
  // registra a valor cero por requisito legal, en el paso hilo → tejido. A
  // partir de GF el producto ya tiene valor porque se cargó el costo de tejido.
  // En una COMPRA es siempre un error de captura: capitalizaría inventario en
  // Q0 y arrastraría ese cero al costeo FIFO y al costo de venta sin que nada
  // lo delate después.
  //
  // Se LANZA excepción en vez de devolver null: de los 14 llamadores de esta
  // función, casi todos hacen `await crearMovimiento({...})` sin revisar el
  // retorno, así que un null se ignoraría en silencio y la operación
  // continuaría igual — exactamente lo que hay que evitar. El throw corta el
  // flujo completo (recepción, asiento y actualización de OC) y deja el
  // sistema sin escribir nada.
  const esConsignacion = tipo === 'consignacion' || !!consignacion_cliente_id;
  // Solo los referencia_tipo de COMPRA. Verificado contra los valores que el
  // sistema realmente emite: OC y DEV-OC. Quedan deliberadamente fuera los de
  // producción (OP, OP-ROLLO, OP-AJUSTE, REABASTECIMIENTO, ENVIO-TERCEROS,
  // RECEPCION-TERCEROS) y DESPACHO, donde un costo cero puede ser legítimo.
  const esCompra = ['OC','DEV-OC'].includes(referencia_tipo||'');
  if (!esConsignacion && esCompra && costo_total === 0) {
    // Sin alert() acá: el llamador (saveRecepcion y demás flujos) muestra el
    // mensaje. Tener el alert en ambos lados producía dos diálogos seguidos,
    // el segundo con stack trace. Esta guarda es la última línea de defensa:
    // lo esperable es que la validación previa del llamador ya haya frenado
    // la operación antes de tocar la base.
    throw new Error(
      'Movimiento bloqueado: compra con costo cero — ' +
      (prod?.description || producto_id) +
      '. Una compra no puede entrar a costo cero: el inventario se capitalizaría ' +
      'en Q0 y ese cero se propagaría al costeo FIFO y al costo de venta. ' +
      'Corrija el precio unitario en la orden de compra.'
    );
  }

  const row = {
    mov_id, tipo, producto_id,
    categoria_id:      catId,
    cantidad:          parseFloat(cantidad)||0,
    unidad:            prod?.unidad || '',
    costo_unitario:    parseFloat(costo_unitario)||0,
    costo_total,
    moneda:            moneda||'GTQ',
    tipo_cambio,
    costo_unitario_gtq,
    costo_total_gtq,
    referencia_tipo:   referencia_tipo||null,
    referencia_id:     referencia_id||null,
    notas:             notas||'',
    fecha:             fecha || today(),
    bodega_id:         bodega_id||null,
    lote:              lote||null,
    poliza:            poliza||null,
    proveedor_lote_id: proveedor_lote_id||null,
    lote_vence:        lote_vence||null,
    ...(consignacion_cliente_id ? {
      consignacion_cliente_id,
      consignacion_cliente_nombre: consignacion_cliente_nombre||null,
    } : {}),
    ...snap,
  };

  const { error } = await sb.from('erp_movimientos_inv').insert(row);
  if (error) {
    alert('Error en movimiento de inventario:\n\n' + error.message + '\nCode: ' + (error.code||'') + '\nDetails: ' + (error.details||''));
    return null;
  }
  return mov_id;
}

// ── RENDER MOVIMIENTOS ──
function imprimirMovimiento(movId) {
  const m    = state.movimientos.find(x => x.mov_id === movId);
  if (!m) { toast('Movimiento no encontrado','error'); return; }
  const prod   = state.productos.find(p => p.id === m.producto_id);
  const bodega = (state.bodegas||[]).find(b => b.id === m.bodega_id);
  const cat    = state.categorias?.find(c => c.id === m.categoria_id);
  const fechaFmt = fmtDate(m.fecha);
  const isNeg    = m.tipo === 'salida' || m.tipo === 'ajuste_negativo';

  const MOV_TIPO_LABEL_FULL = {
    entrada:'Entrada de Inventario', salida:'Salida de Inventario',
    ajuste_positivo:'Ajuste Positivo', ajuste_negativo:'Ajuste Negativo',
    consignacion:'Consignación', devolucion:'Devolución',
  };

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
  <title>Movimiento ${movId}</title>
  <style>
    body { font-family: 'Segoe UI', sans-serif; font-size: 13px; color: #1A1916; margin: 0; padding: 32px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; padding-bottom: 16px; border-bottom: 2px solid #E5E4DF; }
    .logo { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
    .doc-title { text-align: right; }
    .doc-title h1 { font-size: 18px; margin: 0 0 4px; color: #1A1916; }
    .doc-id { font-family: 'Courier New', monospace; font-size: 14px; font-weight: 700; color: #E07B39; }
    .tipo-badge { display: inline-block; padding: 4px 12px; border-radius: 99px; font-size: 12px; font-weight: 700; margin-top: 6px;
      background: ${isNeg?'#FEF2F2':'#F0FDF4'}; color: ${isNeg?'#DC2626':'#16A34A'}; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 32px; margin-bottom: 24px; }
    .row { display: flex; flex-direction: column; gap: 2px; }
    .label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #9EA4B0; }
    .val { font-size: 13px; font-weight: 500; }
    .val.mono { font-family: 'Courier New', monospace; }
    .section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #9EA4B0; margin: 20px 0 10px; border-bottom: 1px solid #E5E4DF; padding-bottom: 6px; }
    .totals { background: #F8F7F4; border-radius: 8px; padding: 16px 20px; margin-top: 24px; }
    .tot-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
    .tot-row.main { font-size: 16px; font-weight: 700; border-top: 1px solid #E5E4DF; margin-top: 8px; padding-top: 8px; }
    .footer { margin-top: 40px; display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
    .firma { border-top: 1px solid #1A1916; padding-top: 6px; font-size: 11px; color: #9EA4B0; text-align: center; }
    @media print { body { padding: 16px; } }
  </style></head><body>
  <div class="header">
    <div class="logo">MTG Textiles</div>
    <div class="doc-title">
      <h1>Reporte de Movimiento</h1>
      <div class="doc-id">${movId}</div>
      <div class="tipo-badge">${MOV_TIPO_LABEL_FULL[m.tipo]||m.tipo}</div>
    </div>
  </div>

  <div class="grid">
    <div class="row"><span class="label">Fecha</span><span class="val">${fechaFmt}</span></div>
    <div class="row"><span class="label">Referencia</span><span class="val mono">${m.referencia_tipo||'—'}: ${m.referencia_id||'—'}</span></div>
    <div class="row"><span class="label">Producto</span><span class="val">${prod?.description||'—'}</span></div>
    <div class="row"><span class="label">Código Interno</span><span class="val mono">${prod?.codigo_interno||prod?.code||'—'}</span></div>
    <div class="row"><span class="label">Categoría</span><span class="val">${cat?.nombre||'—'}</span></div>
    <div class="row"><span class="label">Unidad</span><span class="val">${m.unidad||'—'}</span></div>
    <div class="row"><span class="label">Bodega</span><span class="val">${bodega?`${bodega.codigo} — ${bodega.nombre}`:'—'}</span></div>
    <div class="row"><span class="label">Moneda</span><span class="val mono">${m.moneda||'GTQ'}</span></div>
    <div class="row"><span class="label">Lote</span><span class="val mono">${m.lote||'—'}</span></div>
    <div class="row"><span class="label">Póliza</span><span class="val mono">${m.poliza||'—'}</span></div>
    ${m.notas?`<div class="row" style="grid-column:1/-1"><span class="label">Notas</span><span class="val">${m.notas}</span></div>`:''}
  </div>

  <div class="section-title">Detalle Monetario</div>
  <div class="totals">
    <div class="tot-row"><span>Cantidad</span><span class="mono">${isNeg?'−':'+'}${Number(m.cantidad||0).toFixed(3)} ${m.unidad||''}</span></div>
    <div class="tot-row"><span>Costo Unitario (${m.moneda||'GTQ'})</span><span class="mono">${fmtMoney(m.costo_unitario, m.moneda||'GTQ')}</span></div>
    ${m.moneda==='USD'?`<div class="tot-row"><span>Tipo de Cambio</span><span class="mono">Q${Number(m.costo_unitario_gtq&&m.costo_unitario?m.costo_unitario_gtq/m.costo_unitario:1).toFixed(5)}</span></div>`:''}
    ${m.moneda==='USD'?`<div class="tot-row"><span>Costo Unitario (GTQ)</span><span class="mono">${fmtGTQ(m.costo_unitario_gtq||m.costo_unitario||0)}</span></div>`:''}
    <div class="tot-row main"><span>Costo Total (GTQ)</span><span class="mono">${fmtGTQ(m.costo_total_gtq||m.costo_total||0)}</span></div>
  </div>

  <div class="footer">
    <div class="firma">Elaborado por</div>
    <div class="firma">Autorizado por</div>
  </div>
  <scr` + `ipt>window.onload=()=>window.print();</scr` + `ipt>
  </body></html>`;

  const w = window.open('','_blank');
  w.document.write(html);
  w.document.close();
}

function renderMovimientos() {
  const q       = (document.getElementById('search-movimientos')?.value||'').toLowerCase();
  const tp      = document.getElementById('filter-mov-tipo')?.value||'';
  const mes     = document.getElementById('filter-mov-mes')?.value||'';
  const bodegaId = document.getElementById('filter-mov-bodega')?.value||'';

  // De más nuevo a más viejo (10/Sep/2026, a pedido explícito). Antes solo
  // ordenaba por `fecha` (columna date, sin hora) — varios movimientos del
  // mismo día (caso típico: varias líneas de un mismo despacho/recepción, o
  // una devolución generada horas después de su despacho original) quedaban
  // en el orden en que Supabase los devolviera, no necesariamente el más
  // reciente primero. Se desempata por `created_at` (con hora real).
  let data = [...state.movimientos].sort((a,b) =>
    (b.fecha||'').localeCompare(a.fecha||'') || (b.created_at||'').localeCompare(a.created_at||'')
  );
  data = data.filter(m =>
    (!tp       || m.tipo === tp) &&
    (!mes      || (m.fecha||'').startsWith(mes)) &&
    (!bodegaId || m.bodega_id === bodegaId) &&
    (!q        || (m.mov_id||'').toLowerCase().includes(q) ||
                  (state.productos.find(p=>p.id===m.producto_id)?.description||'').toLowerCase().includes(q))
  );

  let sumTotal = 0;
  const tbody = document.getElementById('tbl-movimientos');
  if (!tbody) return;

  tbody.innerHTML = data.length ? data.map(m => {
    const prod   = state.productos.find(p => p.id === m.producto_id);
    const bodega = (state.bodegas||[]).find(b => b.id === m.bodega_id);
    const fechaFmt  = fmtDate(m.fecha);
    const refLabel  = m.referencia_tipo && m.referencia_id
      ? `${m.referencia_tipo}: ${m.referencia_id}` : '—';
    const isNeg = m.tipo === 'salida' || m.tipo === 'ajuste_negativo';
    sumTotal += isNeg ? -Number(m.costo_total||0) : Number(m.costo_total||0);
    return `<tr>
      <td class="td-mono" style="font-size:12px;font-weight:600;color:var(--accent)">${m.mov_id||'—'}</td>
      <td style="white-space:nowrap">${fechaFmt}</td>
      <td><span class="badge ${MOV_TIPO_COLOR[m.tipo]||'badge-gray'}">${MOV_TIPO_LABEL[m.tipo]||m.tipo}</span></td>
      <td>
        <div style="font-weight:500;font-size:13px">${prod?.description||'—'}</div>
        <div style="font-size:11px;color:var(--text3)">${prod?.code||''}</div>
      </td>
      <td class="hide-mobile" style="font-size:12px">
        ${bodega ? `<span style="font-weight:500">${bodega.codigo}</span><br><span style="font-size:11px;color:var(--text3)">${bodega.nombre}</span>` : '<span style="color:var(--text3)">—</span>'}
      </td>
      <td class="hide-mobile">
        ${m.lote ? `<span class="badge badge-blue" style="font-family:'DM Mono',monospace">${m.lote}</span>` : '<span style="color:var(--text3);font-size:12px">—</span>'}
      </td>
      <td class="hide-mobile" style="font-size:12px;color:var(--text2)">${m.poliza||'—'}</td>
      <td class="hide-mobile" style="font-size:12px">${getCategoriaNombre(m.categoria_id)}</td>
      <td class="td-mono" style="text-align:right;color:${isNeg?'var(--red)':'var(--green)'};font-weight:600">
        ${isNeg?'−':'+'}${Number(m.cantidad||0).toFixed(3)} ${m.unidad||''}
      </td>
      <td class="td-mono hide-mobile" style="text-align:right">
        ${m.moneda&&m.moneda!=='GTQ'?`<div style="font-size:10px;color:var(--text3)">${fmtMoney(m.costo_unitario,m.moneda)}</div>`:''}
        ${fmtGTQ(m.costo_unitario_gtq??m.costo_unitario??0)}
      </td>
      <td class="td-mono" style="text-align:right;font-weight:600">
        ${m.moneda&&m.moneda!=='GTQ'?`<div style="font-size:10px;color:var(--text3)">${fmtMoney(m.costo_total,m.moneda)}</div>`:''}
        ${fmtGTQ(m.costo_total_gtq??m.costo_total??0)}
      </td>
      <td class="hide-mobile" style="font-size:12px">${refLabel}</td>
      <td class="hide-mobile" style="font-size:12px;color:var(--text2)">${m.notas||'—'}</td>
      <td><button class="btn btn-sm btn-ghost" onclick="imprimirMovimiento('${m.mov_id}')" title="Imprimir reporte">🖨</button></td>
    </tr>`;
  }).join('') :
  '<tr><td colspan="11"><div class="empty-state"><div class="empty-icon">▦</div><p>Sin movimientos de inventario</p></div></td></tr>';

  const tfoot = document.getElementById('tfoot-movimientos');
  if (tfoot && data.length) {
    tfoot.innerHTML = `<tr style="background:var(--surface2);font-weight:600">
      <td colspan="8" style="padding:10px 14px;font-size:12px;color:var(--text2)">
        TOTAL NETO (${data.length} movimiento${data.length!==1?'s':''})
      </td>
      <td class="td-mono" style="text-align:right;padding:10px 14px;color:${sumTotal>=0?'var(--green)':'var(--red)'}">${fmtMoney(Math.abs(sumTotal))}</td>
      <td colspan="2"></td>
    </tr>`;
  } else if (tfoot) tfoot.innerHTML = '';
}

// ── RENDER AJUSTES ──
function renderAjustes() {
  const q = (document.getElementById('search-ajustes')?.value||'').toLowerCase();
  const data = state.movimientos.filter(m =>
    (m.tipo === 'ajuste_positivo' || m.tipo === 'ajuste_negativo') &&
    (!q || (m.mov_id||'').toLowerCase().includes(q) ||
           (state.productos.find(p=>p.id===m.producto_id)?.description||'').toLowerCase().includes(q))
  ).sort((a,b)=>new Date(b.fecha)-new Date(a.fecha));

  const tbody = document.getElementById('tbl-ajustes');
  if (!tbody) return;
  tbody.innerHTML = data.length ? data.map(m => {
    const prod = state.productos.find(p => p.id === m.producto_id);
    const fechaFmt = fmtDate(m.fecha);
    const isNeg = m.tipo === 'ajuste_negativo';
    return `<tr>
      <td class="td-mono" style="font-size:12px;font-weight:600;color:var(--accent)">${m.mov_id||'—'}</td>
      <td style="white-space:nowrap">${fechaFmt}</td>
      <td><span class="badge ${MOV_TIPO_COLOR[m.tipo]}">${MOV_TIPO_LABEL[m.tipo]}</span></td>
      <td>
        <div style="font-weight:500;font-size:13px">${prod?.description||'—'}</div>
        <div style="font-size:11px;color:var(--text3)">${prod?.code||''}</div>
      </td>
      <td class="td-mono" style="text-align:right;color:${isNeg?'var(--red)':'var(--green)'};font-weight:600">
        ${isNeg?'−':'+'}${Number(m.cantidad||0).toFixed(3)} ${m.unidad||''}
      </td>
      <td class="td-mono hide-mobile" style="text-align:right">${fmtMoney(m.costo_unitario)}</td>
      <td class="td-mono" style="text-align:right;font-weight:600">${fmtMoney(m.costo_total)}</td>
      <td class="hide-mobile" style="font-size:12px;color:var(--text2)">${m.notas||'—'}</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteAjuste('${m.id}')">Eliminar</button></td>
    </tr>`;
  }).join('') :
  '<tr><td colspan="9"><div class="empty-state"><div class="empty-icon">◈</div><p>Sin ajustes de inventario</p></div></td></tr>';
}

// ── AJUSTE MODAL ──
function onAjusteTipoChange() {
  const tipo = document.getElementById('ajuste-tipo').value;
  const isConsig = tipo === 'consignacion';
  const isEntrada = tipo === 'ajuste_positivo' || tipo === 'consignacion';

  // Toggle cost field
  document.getElementById('ajuste-costo-field').style.display   = isConsig ? 'none' : '';
  document.getElementById('ajuste-consig-banner').style.display  = isConsig ? 'block' : 'none';
  document.getElementById('ajuste-proveedor-consig-field').style.display = isConsig ? 'block' : 'none';

  // Show trazabilidad only on entries
  document.getElementById('ajuste-traza-section').style.display = isEntrada ? 'block' : 'none';

  if (isConsig) {
    document.getElementById('ajuste-costo-unit').value = '0';
    document.getElementById('ajuste-total-display').textContent = '$0.00 (sin valor contable)';
    console.log('Clientes disponibles:', state.clientes?.length, state.clientes?.map(c=>c.name));
    const cltOpts = '<option value="">— Seleccionar cliente —</option>' +
      ((state.clientes||[]).length
        ? (state.clientes||[]).map(c=>`<option value="${c.id}">${c.name}</option>`).join('')
        : '<option disabled>Sin clientes registrados</option>');
    document.getElementById('ajuste-proveedor-consig').innerHTML = cltOpts;
  } else {
    calcAjusteTotal();
  }

  // Populate proveedor-lote dropdown
  if (isEntrada) {
    const pvOpts2 = '<option value="">— Seleccionar proveedor —</option>' +
      (state.proveedores||[]).map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
    document.getElementById('ajuste-proveedor-lote').innerHTML = pvOpts2;
  }
}

function onAjusteProductoChange() {
  const id   = document.getElementById('ajuste-producto').value;
  const prod = state.productos.find(x => x.id === id);
  const cat  = prod?.categoria ? state.categorias.find(c => c.id === prod.categoria) : null;
  document.getElementById('ajuste-cat-display-field').style.display = cat ? 'block' : 'none';
  document.getElementById('ajuste-cat-display').textContent = cat?.nombre || '—';
  document.getElementById('ajuste-unidad-field').style.display = prod ? 'block' : 'none';
  document.getElementById('ajuste-unidad-display').textContent = prod?.unidad || '—';
  const tipo = document.getElementById('ajuste-tipo').value;
  const precioDefault = costoConversionPredeterminado(prod, tcHoy()||7.75);
  if (tipo !== 'consignacion' && precioDefault) {
    document.getElementById('ajuste-costo-unit').value = precioDefault;
  }
  calcAjusteTotal();
}

function calcAjusteTotal() {
  const tipo = document.getElementById('ajuste-tipo')?.value;
  if (tipo === 'consignacion') {
    document.getElementById('ajuste-total-display').textContent = '$0.00 (sin valor contable)';
    return;
  }
  const qty  = parseFloat(document.getElementById('ajuste-cantidad').value)||0;
  const cost = parseFloat(document.getElementById('ajuste-costo-unit').value)||0;
  document.getElementById('ajuste-total-display').textContent = fmtMoney(qty * cost);
}

async function openNewAjuste() {
  document.getElementById('ajuste-id').value = '';
  document.getElementById('ajuste-fecha').value = today();
  document.getElementById('ajuste-tipo').value  = 'ajuste_positivo';
  document.getElementById('ajuste-cantidad').value   = '';
  document.getElementById('ajuste-costo-unit').value = '';
  document.getElementById('ajuste-notas').value      = '';
  document.getElementById('ajuste-lote').value       = '';
  document.getElementById('ajuste-poliza').value     = '';
  document.getElementById('ajuste-lote-vence').value = '';
  document.getElementById('ajuste-total-display').textContent = '$0.00';
  document.getElementById('ajuste-cat-display-field').style.display = 'none';
  document.getElementById('ajuste-unidad-field').style.display = 'none';
  document.getElementById('ajuste-costo-field').style.display  = '';
  document.getElementById('ajuste-consig-banner').style.display = 'none';
  document.getElementById('ajuste-proveedor-consig-field').style.display = 'none';
  document.getElementById('ajuste-traza-section').style.display = 'block'; // default: entrada

  const opts = state.productos.filter(p => p.tipo !== 'servicio').map(p =>
    `<option value="${p.id}">${p.codigo_interno||p.code||'?'} — ${p.description}</option>`
  ).join('');
  document.getElementById('ajuste-producto').innerHTML =
    '<option value="">— Seleccionar producto —</option>' + opts;

  const pvOpts = '<option value="">— Seleccionar proveedor —</option>' +
    (state.proveedores||[]).map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  document.getElementById('ajuste-proveedor-lote').innerHTML = pvOpts;

  document.getElementById('ajuste-mov-id-preview').textContent = await nextMovId();
  openModal('modal-ajuste');
}

async function saveAjuste() {
  const producto_id    = document.getElementById('ajuste-producto').value;
  const tipo           = document.getElementById('ajuste-tipo').value;
  const fecha          = document.getElementById('ajuste-fecha').value;
  const cantidad       = parseFloat(document.getElementById('ajuste-cantidad').value);
  const bodega_id      = document.getElementById('ajuste-bodega')?.value || null;
  const notas          = document.getElementById('ajuste-notas').value.trim();
  const isConsig       = tipo === 'consignacion';
  const isEntrada      = tipo === 'ajuste_positivo' || isConsig;
  const costo_unitario = isConsig ? 0 : parseFloat(document.getElementById('ajuste-costo-unit').value)||0;
  const proveedor_consig = isConsig ? (document.getElementById('ajuste-proveedor-consig')?.value||null) : null;
  const consig_cliente   = isConsig && proveedor_consig
    ? state.clientes.find(c => c.id === proveedor_consig)
    : null;

  // Trazabilidad — solo en entradas
  const lote              = isEntrada ? (document.getElementById('ajuste-lote')?.value.trim().toUpperCase()||null) : null;
  const poliza            = isEntrada ? (document.getElementById('ajuste-poliza')?.value.trim()||null) : null;
  const proveedor_lote_id = isEntrada ? (document.getElementById('ajuste-proveedor-lote')?.value||null) : null;
  const lote_vence        = isEntrada ? (document.getElementById('ajuste-lote-vence')?.value||null) : null;

  if (!producto_id || !fecha || isNaN(cantidad) || cantidad <= 0) {
    toast('Producto, fecha y cantidad son requeridos','error'); return;
  }
  if (isEntrada && !lote) {
    toast('El número de lote es requerido para ingresos','error'); return;
  }

  try {
    const movId = await crearMovimientoConAsiento({
      tipo, producto_id, cantidad,
      costo_unitario: isConsig ? 0 : costo_unitario,
      referencia_tipo: isConsig ? 'CONSIGNACION' : 'AJUSTE',
      referencia_id: proveedor_consig,
      notas: isConsig ? `Consignación${consig_cliente?' — '+consig_cliente.name:''}${notas?' | '+notas:''}` : notas,
      fecha, bodega_id, lote, poliza, proveedor_lote_id, lote_vence,
      consignacion_cliente_id:     proveedor_consig || null,
      consignacion_cliente_nombre: consig_cliente?.name || null,
    });

    if (movId) {
      logAuditoria('inventario', 'ajuste', isConsig ? 'Consignacion' : 'Ajuste', movId, null, { producto_id, tipo, cantidad, notas });
      toast(isConsig ? `Consignación registrada — ${movId}` : `Ajuste registrado — ${movId}`);
      closeModal('modal-ajuste');
      await loadAll();
    }
  } catch(e) {
    alert('Error al guardar ajuste:\n\n' + e.message);
  }
}

async function deleteAjuste(id) {
  if (!confirm('¿Eliminar este ajuste de inventario?\nEsta acción no puede deshacerse.')) return;
  const {error} = await sb.from('erp_movimientos_inv').delete().eq('id',id);
  if (error) { toast('Error: '+error.message,'error'); return; }
  toast('Ajuste eliminado');
  await loadAll();
}
