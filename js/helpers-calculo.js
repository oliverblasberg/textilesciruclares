// ═══════════════════════════════════════════════════════
// HELPERS DE CALCULO — extraidos de index.html (Fase 3 modularizacion, 26/Ago/2026)
// Funciones PURAS: reciben todo por parametro, devuelven un valor.
// Cero dependencia de state, sb, DOM, toast o fetch.
// Cargar DESPUES de js/utils.js y js/constantes.js, ANTES del script principal.
// ═══════════════════════════════════════════════════════


// ═══ COSTEO FIFO ═══

function calcStockFIFO(movimientos) {
  // Group and sort by producto_id, then by fecha ASC
  const porProducto = {};
  movimientos.forEach(m => {
    const id = m.producto_id;
    if (!id) return;
    if (!porProducto[id]) porProducto[id] = [];
    porProducto[id].push(m);
  });

  const resultado = {};

  Object.entries(porProducto).forEach(([id, movs]) => {
    const sorted = [...movs].sort((a,b) =>
      (a.fecha||'').localeCompare(b.fecha||'') ||
      (a.created_at||'').localeCompare(b.created_at||'')
    );

    const capas = []; // { cant, costo } FIFO queue
    let entradas = 0, salidas = 0, consignacion = 0, ultimo_costo = 0;

    sorted.forEach(m => {
      const cant  = Number(m.cantidad || 0);
      const costo = Number(m.costo_unitario_gtq || m.costo_unitario || 0);

      if (m.tipo === 'entrada' || m.tipo === 'ajuste_positivo') {
        capas.push({ cant, costo });
        entradas += cant;
        if (costo > 0) ultimo_costo = costo;

      } else if (m.tipo === 'consignacion') {
        // Entra físicamente con costo 0
        capas.push({ cant, costo: 0 });
        entradas    += cant;
        consignacion += cant;

      } else if (m.tipo === 'salida' || m.tipo === 'ajuste_negativo') {
        salidas += cant;
        // Consume FIFO layers
        let porConsumir = cant;
        while (porConsumir > 0 && capas.length) {
          const capa = capas[0];
          if (capa.cant <= porConsumir) {
            porConsumir -= capa.cant;
            capas.shift();
          } else {
            capa.cant -= porConsumir;
            porConsumir = 0;
          }
        }
        // If porConsumir > 0, stock went negative (phantom layer)
        if (porConsumir > 0) {
          capas.unshift({ cant: -porConsumir, costo: ultimo_costo });
        }
      }
    });

    const saldo      = capas.reduce((s, c) => s + c.cant, 0);
    const valoracion = capas.reduce((s, c) => s + c.cant * c.costo, 0);
    // For costo unitario: only consider capas with actual cost (exclude consignacion)
    const saldo_valorizado    = capas.filter(c => c.costo > 0).reduce((s, c) => s + c.cant, 0);
    const costo_siguiente = capas.length ? capas[0].costo : ultimo_costo;

    resultado[id] = {
      saldo, capas, valoracion, entradas, salidas,
      consignacion, ultimo_costo, costo_siguiente,
      saldo_valorizado,
      costo_total: valoracion,
    };
  });

  return resultado;
}

function calcCostoSalidaFIFO(capas, cantidad) {
  let restante = cantidad;
  let costoTotal = 0;
  const capasCopia = capas.map(c => ({...c})); // non-destructive
  for (const capa of capasCopia) {
    if (restante <= 0) break;
    const usado = Math.min(capa.cant, restante);
    costoTotal += usado * capa.costo;
    restante   -= usado;
  }
  return costoTotal;
}


// ═══ FISCAL — RETENCIONES ═══

function calcRetencionISR(neto) {
  const n = Number(neto || 0);
  if (n <= 2500) return 0;
  if (n <= 30000) return parseFloat((n * 0.05).toFixed(2));
  return parseFloat((30000 * 0.05 + (n - 30000) * 0.07).toFixed(2));
}


// ═══ CORRELATIVOS ═══

function nextCorrelativo(prefix, list, field='numero') {
  const year  = new Date().getFullYear();
  const nums  = list.filter(x=>(x[field]||'').startsWith(`${prefix}-${year}`))
                    .map(x=>parseInt((x[field]||'').slice(-4))||0);
  const next  = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}-${year}-${String(next).padStart(4,'0')}`;
}


// ═══ PRODUCTOS / PROVEEDORES ═══

function proveedorPredeterminado(prod) {
  return (prod?.proveedores_compra||[])[0]?.proveedor_id || null;
}


// ═══ CREDITO Y VENCIMIENTOS DE VENTA ═══

function diasCreditoVenta(credito) {
  if (!credito || credito === 'inmediato') return 0;
  const n = parseInt(credito, 10);
  return isNaN(n) ? 0 : n;
}

function facturaVentaVencimiento(f) {
  if (!f?.date) return null;
  const dias = diasCreditoVenta(f.credito);
  const d = new Date(f.date);
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}


// ═══ PERIODOS Y AGRUPACION TEMPORAL ═══

function periodoFechas(periodo) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  let desde, hasta;
  if (periodo === 'mes') {
    desde = new Date(y, m, 1);
    hasta = new Date(y, m+1, 0);
  } else if (periodo === 'trimestre') {
    const q = Math.floor(m/3);
    desde = new Date(y, q*3, 1);
    hasta = new Date(y, q*3+3, 0);
  } else {
    desde = new Date(y, 0, 1);
    hasta = new Date(y, 11, 31);
  }
  return { desde: desde.toISOString().slice(0,10), hasta: hasta.toISOString().slice(0,10) };
}

function fcBucketKey(fecha, intervalo) {
  if (!fecha) return null;
  if (intervalo === 'anio') return fecha.slice(0, 4);
  if (intervalo === 'mes')  return fecha.slice(0, 7);
  return fecha;
}

// Depende de MESES_ABREV y fmtDate(), ambos en js/utils.js (carga antes).
function fcBucketLabel(key, intervalo) {
  if (intervalo === 'anio') return key;
  if (intervalo === 'mes') {
    const [y, m] = key.split('-');
    const mi = parseInt(m, 10) - 1;
    return `${MESES_ABREV[mi] || m} ${y}`;
  }
  return fmtDate(key);
}


// ═══ NOMENCLATURA CONTABLE ═══

function nomDepth(codigo) {
  const len = (codigo||'').length;
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  if (len <= 8) return 2;
  if (len <= 10) return 3;
  return 4;
}


// ═══ PARSEO DE EXTRACTO BANCARIO ═══

function _normKeyExt(k) { return String(k||'').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g,''); }

function _parseNumeroExtracto(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/[Qq$\s]/g,'').replace(/,/g,'');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function _parseFechaExtracto(v) {
  if (!v) return '';
  if (v instanceof Date && !isNaN(v)) return v.toISOString().split('T')[0];
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; // dd/mm/yyyy
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  return '';
}

function normalizarFilasExtracto(rows) {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]);
  const findKey = (...candidates) => keys.find(k => candidates.some(c => _normKeyExt(k).includes(c)));

  const kFecha = findKey('fecha');
  const kDesc  = findKey('descripcion','concepto','detalle','glosa');
  const kRef   = findKey('referencia','documento','doc');
  const kMonto = findKey('monto','importe','valor');
  const kCargo = findKey('cargo','debito','debe');
  const kAbono = findKey('abono','credito','haber');

  const out = [];
  for (const row of rows) {
    const fecha = kFecha ? _parseFechaExtracto(row[kFecha]) : '';
    if (!fecha) continue; // fila sin fecha válida (encabezados, totales, etc.)

    let monto = null;
    if (kMonto) {
      monto = _parseNumeroExtracto(row[kMonto]);
    } else if (kCargo || kAbono) {
      const cargo = _parseNumeroExtracto(kCargo ? row[kCargo] : 0);
      const abono = _parseNumeroExtracto(kAbono ? row[kAbono] : 0);
      monto = (abono||0) - Math.abs(cargo||0);
    }
    if (monto === null || isNaN(monto) || monto === 0) continue;

    out.push({
      fecha,
      descripcion: kDesc ? String(row[kDesc]||'').trim() : '',
      referencia: kRef ? String(row[kRef]||'').trim() : '',
      monto: parseFloat(monto.toFixed(2)),
    });
  }
  return out;
}
