// ═══════════════════════════════════════════════════════════════════
// js/bancos.js — Fase 4 de la división del monolito (26/Ago/2026)
//
// Script CLÁSICO, no ES Module — mismo criterio que utils.js/constantes.js/
// helpers-calculo.js: index.html usa onclick="funcName()", lo que exige
// funciones globales. Se carga ANTES del script principal.
//
// POR QUÉ ES UN MÓDULO PROPIO Y NO PARTE DE COMPRAS O VENTAS:
// signedPagoMonto() determina el signo de cada movimiento revisando
// explícitamente state.ocFacturas (compras) Y state.facturas (ventas), y usa
// state.cuentas (catálogo contable). Es lógica compartida real entre compras,
// ventas y contabilidad — asignarla a un solo dominio obligaría a duplicarla.
//
// DEPENDENCIAS EXTERNAS (resueltas en tiempo de ejecución, no de carga —
// todas las llamadas ocurren tras el arranque de la app):
//   · js/utils.js            → fmtDate, fmtGTQ, today
//   · js/helpers-calculo.js  → normalizarFilasExtracto y sus _parse* internos
//   · index.html (principal) → state, sb, toast, openModal, closeModal,
//                              loadAll, crearAsiento, statusBadge,
//                              bancoNomenclatura, transitoriaNomenclatura
//   · CDN                    → XLSX (SheetJS), para leer el archivo de extracto
//
// Este archivo contiene SOLO declaraciones de función más una variable de
// módulo (_extParsedRows), usada exclusivamente por el flujo de importación
// de extracto — no se ejecuta nada al cargar.
// ═══════════════════════════════════════════════════════════════════
// ═══ CONCILIACIÓN BANCARIA ═══

let _extParsedRows = [];

// Determina el signo real de un pago (erp_pagos): + si es un cobro de venta
// (OV, dinero entra al banco), - si es un pago a proveedor (OC, dinero sale).
function signedPagoMonto(pago) {
  const monto = Number(pago.monto||0);
  if ((state.ocFacturas||[]).some(f=>f.id===pago.factura_id)) return -monto;
  if ((state.facturas||[]).some(f=>f.id===pago.factura_id)) return monto;
  return monto; // no se pudo determinar la dirección — se asume abono
}

function _concCuentaOpts(selectedId) {
  return (state.cuentas||[]).filter(c=>c.activa!==false)
    .map(c=>`<option value="${c.id}" ${c.id===selectedId?'selected':''}>${c.name}${c.moneda?' ('+c.moneda+')':''}</option>`).join('');
}

function concTab(tab) {
  document.getElementById('conc-panel-lineas').style.display  = tab==='lineas'  ? '' : 'none';
  document.getElementById('conc-panel-reporte').style.display = tab==='reporte' ? '' : 'none';
  document.getElementById('conc-tab-lineas').style.color         = tab==='lineas'  ? 'var(--accent)' : 'var(--text3)';
  document.getElementById('conc-tab-lineas').style.borderBottom  = tab==='lineas'  ? '2px solid var(--accent)' : 'none';
  document.getElementById('conc-tab-reporte').style.color        = tab==='reporte' ? 'var(--accent)' : 'var(--text3)';
  document.getElementById('conc-tab-reporte').style.borderBottom = tab==='reporte' ? '2px solid var(--accent)' : 'none';
  if (tab === 'reporte') renderReporteSaldos();
}

function renderConciliacion() {
  const selCuenta = document.getElementById('conc-cuenta');
  if (!selCuenta) return;
  const cuentaVal = selCuenta.value;
  selCuenta.innerHTML = '<option value="">Todas las cuentas</option>' + _concCuentaOpts(cuentaVal);
  selCuenta.value = cuentaVal;

  const estadoVal = document.getElementById('conc-estado')?.value || '';
  const mesVal    = document.getElementById('conc-mes')?.value || '';

  let lineas = (state.extractoBancario||[]).slice();
  if (cuentaVal) lineas = lineas.filter(l=>l.cuenta_id===cuentaVal);
  if (estadoVal) lineas = lineas.filter(l=>l.estado===estadoVal);
  if (mesVal)    lineas = lineas.filter(l=>(l.fecha||'').slice(0,7)===mesVal);
  lineas.sort((a,b)=> (b.fecha||'').localeCompare(a.fecha||''));

  const pendientes  = lineas.filter(l=>l.estado==='pendiente');
  const conciliadas = lineas.filter(l=>l.estado==='conciliado');
  const ignoradas   = lineas.filter(l=>l.estado==='ignorado');
  const lotesCuenta = cuentaVal ? (state.extractoLotes||[]).filter(x=>x.cuenta_id===cuentaVal) : (state.extractoLotes||[]);
  const ultimoLote  = lotesCuenta.slice().sort((a,b)=>(b.fecha_fin||'').localeCompare(a.fecha_fin||''))[0];

  const summaryEl = document.getElementById('conc-summary');
  if (summaryEl) summaryEl.innerHTML = `
    <div style="background:var(--yellow-bg);border-radius:10px;padding:14px;text-align:center">
      <div style="font-size:11px;color:var(--yellow);text-transform:uppercase;font-weight:600;letter-spacing:0.06em;margin-bottom:6px">Pendientes</div>
      <div style="font-size:20px;font-weight:700;font-family:'DM Mono',monospace;color:var(--yellow)">${pendientes.length}</div>
    </div>
    <div style="background:var(--green-bg);border-radius:10px;padding:14px;text-align:center">
      <div style="font-size:11px;color:var(--green);text-transform:uppercase;font-weight:600;letter-spacing:0.06em;margin-bottom:6px">Conciliadas</div>
      <div style="font-size:20px;font-weight:700;font-family:'DM Mono',monospace;color:var(--green)">${conciliadas.length}</div>
    </div>
    <div style="background:var(--surface2);border-radius:10px;padding:14px;text-align:center">
      <div style="font-size:11px;color:var(--text2);text-transform:uppercase;font-weight:600;letter-spacing:0.06em;margin-bottom:6px">Ignoradas</div>
      <div style="font-size:20px;font-weight:700;font-family:'DM Mono',monospace;color:var(--text2)">${ignoradas.length}</div>
    </div>
    <div style="background:#EFF6FF;border-radius:10px;padding:14px;text-align:center">
      <div style="font-size:11px;color:var(--accent3);text-transform:uppercase;font-weight:600;letter-spacing:0.06em;margin-bottom:6px">Última Carga</div>
      <div style="font-size:14px;font-weight:700;font-family:'DM Mono',monospace;color:var(--accent3)">${ultimoLote ? fmtDate(ultimoLote.fecha_fin)+' · '+fmtGTQ(ultimoLote.saldo_final) : '—'}</div>
    </div>
  `;

  const tbody = document.getElementById('tbl-conciliacion');
  if (tbody) tbody.innerHTML = lineas.map(l => {
    const pago = l.pago_id ? (state.pagos||[]).find(p=>p.id===l.pago_id) : null;
    const estadoBadge = l.estado==='conciliado' ? '<span class="badge badge-green">Conciliado</span>'
      : l.estado==='ignorado' ? '<span class="badge badge-gray">Ignorado</span>'
      : '<span class="badge badge-yellow">Pendiente</span>';
    const conciliadoInfo = pago
      ? `${pago.num_pago||''} ${fmtDate(pago.fecha)} — ${fmtGTQ(pago.monto)}${l.match_tipo==='auto'?' <span style="color:var(--text3);font-size:10px">(auto)</span>':''}`
      : (l.estado==='ignorado' ? (l.motivo_ignorado||'—') : '—');
    const montoOk = Number(l.monto||0) >= 0;
    return `<tr>
      <td>${fmtDate(l.fecha)}</td>
      <td>${l.descripcion||'—'}</td>
      <td class="hide-mobile td-mono" style="font-size:11px">${l.referencia||'—'}</td>
      <td class="td-mono" style="text-align:right;font-weight:600;color:${montoOk?'var(--green)':'var(--red)'}">${montoOk?'+':'-'}${fmtGTQ(Math.abs(Number(l.monto||0)))}</td>
      <td>${estadoBadge}</td>
      <td class="hide-mobile" style="font-size:11px">${conciliadoInfo}</td>
      <td>
        ${l.estado==='pendiente' ? `<button class="btn btn-sm" onclick="openConciliarManual('${l.id}')">Conciliar</button>` : `<button class="btn btn-sm btn-ghost" onclick="deshacerConciliacion('${l.id}')">Deshacer</button>`}
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:20px">Sin movimientos — sube un extracto para comenzar</td></tr>`;

  const panelReporte = document.getElementById('conc-panel-reporte');
  if (panelReporte && panelReporte.style.display !== 'none') renderReporteSaldos();
}

// ── Auto-match por monto + fecha contra erp_pagos ──
async function autoMatchConciliacion(cuentaIdParam) {
  const cuentaId = cuentaIdParam || document.getElementById('conc-cuenta')?.value || '';
  const TOLERANCIA_DIAS = 6;

  const cuentasAProcesar = cuentaId ? [cuentaId]
    : [...new Set((state.extractoBancario||[]).filter(l=>l.estado==='pendiente').map(l=>l.cuenta_id))];
  if (!cuentasAProcesar.length) { toast('No hay líneas pendientes para conciliar','error'); return; }

  let totalMatched = 0;
  for (const ctaId of cuentasAProcesar) {
    const pendientesExt = (state.extractoBancario||[]).filter(l=>l.estado==='pendiente' && l.cuenta_id===ctaId);
    if (!pendientesExt.length) continue;

    const yaVinculados = new Set((state.extractoBancario||[]).filter(l=>l.pago_id).map(l=>l.pago_id));
    // Candidatos: dinero que entra (erp_pagos, cobros) Y dinero que sale
    // (erp_pagos_oc, pagos a proveedores) — antes solo se buscaba en
    // erp_pagos, así que ninguna salida a proveedor podía conciliarse
    // automáticamente contra el extracto bancario.
    const candidatosPago = [...(state.pagos||[]), ...(state.pagosOC||[])]
      .filter(p=>p.cuenta_id===ctaId && !yaVinculados.has(p.id))
      .map(p => ({ pago: p, signed: signedPagoMonto(p) }));

    const usados = new Set();
    const pendientesOrdenadas = pendientesExt.slice().sort((a,b)=>(a.fecha||'').localeCompare(b.fecha||''));

    for (const linea of pendientesOrdenadas) {
      const montoLinea = Number(linea.monto||0);
      let mejor = null, mejorDiff = Infinity;
      for (const cand of candidatosPago) {
        if (usados.has(cand.pago.id)) continue;
        if (Math.abs(cand.signed - montoLinea) > 0.01) continue;
        const dias = Math.abs((new Date(linea.fecha) - new Date(cand.pago.fecha)) / 86400000);
        if (dias > TOLERANCIA_DIAS) continue;
        if (dias < mejorDiff) { mejorDiff = dias; mejor = cand; }
      }
      if (mejor) {
        usados.add(mejor.pago.id);
        const { error } = await sb.from('erp_extracto_bancario').update({
          pago_id: mejor.pago.id, estado: 'conciliado', match_tipo: 'auto', conciliado_at: new Date().toISOString(),
        }).eq('id', linea.id);
        if (!error) {
          totalMatched++;
          await asientoConfirmacionBancaria(mejor.pago.id, linea.fecha);
        }
      }
    }
  }

  if (totalMatched > 0) toast(`✓ ${totalMatched} movimiento${totalMatched!==1?'s':''} conciliado${totalMatched!==1?'s':''} automáticamente`);
  else toast('No se encontraron coincidencias automáticas','error');
  await loadAll();
  renderConciliacion();
}

// ── Subir extracto ──
function openExtractoUpload() {
  document.getElementById('ext-cuenta').innerHTML = '<option value="">— Seleccionar cuenta —</option>' + _concCuentaOpts('');
  document.getElementById('ext-file-input').value = '';
  document.getElementById('ext-fecha-inicio').value = '';
  document.getElementById('ext-fecha-fin').value = '';
  document.getElementById('ext-saldo-inicial').value = '';
  document.getElementById('ext-saldo-final').value = '';
  document.getElementById('ext-preview-wrap').style.display = 'none';
  document.getElementById('ext-preview-tbody').innerHTML = '';
  const btn = document.getElementById('ext-btn-importar');
  btn.disabled = true; btn.textContent = '📥 Importar y Auto-Conciliar';
  _extParsedRows = [];
  openModal('modal-extracto-upload');
}

// _normKeyExt() vive ahora en js/helpers-calculo.js

// _parseNumeroExtracto() vive ahora en js/helpers-calculo.js

// _parseFechaExtracto() vive ahora en js/helpers-calculo.js

// normalizarFilasExtracto() vive ahora en js/helpers-calculo.js

function onExtractoFileSelected() {
  const file = document.getElementById('ext-file-input').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type:'array', cellDates:true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval:'' });
      _extParsedRows = normalizarFilasExtracto(rows);
      renderExtPreview();
    } catch (err) {
      toast('No se pudo leer el archivo: '+err.message,'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function renderExtPreview() {
  const wrap  = document.getElementById('ext-preview-wrap');
  const tbody = document.getElementById('ext-preview-tbody');
  if (!_extParsedRows.length) {
    wrap.style.display = 'none';
    toast('No se detectaron movimientos válidos en el archivo — revisa el formato','error');
    validarExtractoForm();
    return;
  }
  document.getElementById('ext-preview-count').textContent = _extParsedRows.length;
  tbody.innerHTML = _extParsedRows.slice(0,300).map(r => `<tr>
    <td style="padding:5px 10px">${fmtDate(r.fecha)}</td>
    <td style="padding:5px 10px">${r.descripcion||'—'}</td>
    <td style="padding:5px 10px">${r.referencia||'—'}</td>
    <td style="padding:5px 10px;text-align:right;font-family:'DM Mono',monospace;color:${r.monto>=0?'var(--green)':'var(--red)'}">${r.monto>=0?'+':'-'}${fmtGTQ(Math.abs(r.monto))}</td>
  </tr>`).join('');
  wrap.style.display = 'block';

  const fechas = _extParsedRows.map(r=>r.fecha).sort();
  if (!document.getElementById('ext-fecha-inicio').value) document.getElementById('ext-fecha-inicio').value = fechas[0];
  if (!document.getElementById('ext-fecha-fin').value)    document.getElementById('ext-fecha-fin').value    = fechas[fechas.length-1];

  validarExtractoForm();
}

function validarExtractoForm() {
  const ok = document.getElementById('ext-cuenta').value &&
             document.getElementById('ext-fecha-inicio').value &&
             document.getElementById('ext-fecha-fin').value &&
             document.getElementById('ext-saldo-final').value !== '' &&
             _extParsedRows.length > 0;
  document.getElementById('ext-btn-importar').disabled = !ok;
}

async function importarExtracto() {
  const cuenta_id = document.getElementById('ext-cuenta').value;
  const fecha_inicio = document.getElementById('ext-fecha-inicio').value;
  const fecha_fin = document.getElementById('ext-fecha-fin').value;
  const saldoInicialRaw = document.getElementById('ext-saldo-inicial').value;
  const saldo_inicial = saldoInicialRaw === '' ? null : parseFloat(saldoInicialRaw);
  const saldo_final = parseFloat(document.getElementById('ext-saldo-final').value);
  const archivo_nombre = document.getElementById('ext-file-input').files[0]?.name || null;

  if (!cuenta_id || !fecha_inicio || !fecha_fin || isNaN(saldo_final) || !_extParsedRows.length) {
    toast('Completa cuenta, fechas, saldo final y adjunta un archivo válido','error'); return;
  }

  const btn = document.getElementById('ext-btn-importar');
  btn.disabled = true; btn.textContent = 'Importando…';

  const { data: lote, error: eLote } = await sb.from('erp_extracto_lotes').insert({
    cuenta_id, fecha_inicio, fecha_fin, saldo_inicial, saldo_final, archivo_nombre,
  }).select().single();
  if (eLote) { toast('Error creando el lote: '+eLote.message,'error'); btn.disabled=false; btn.textContent='📥 Importar y Auto-Conciliar'; return; }

  const filas = _extParsedRows.map(r => ({
    lote_id: lote.id, cuenta_id, fecha: r.fecha, descripcion: r.descripcion||null,
    referencia: r.referencia||null, monto: r.monto, tipo: r.monto>=0?'abono':'cargo',
  }));
  const { error: eLineas } = await sb.from('erp_extracto_bancario').insert(filas);
  if (eLineas) { toast('Error guardando movimientos: '+eLineas.message,'error'); btn.disabled=false; btn.textContent='📥 Importar y Auto-Conciliar'; return; }

  toast(`✓ Extracto importado — ${filas.length} movimientos`);
  closeModal('modal-extracto-upload');
  await loadAll();
  document.getElementById('conc-cuenta').value = cuenta_id;
  await autoMatchConciliacion(cuenta_id);
}

// ── Conciliación manual ──
function openConciliarManual(extractoId) {
  const linea = (state.extractoBancario||[]).find(l=>l.id===extractoId);
  if (!linea) return;
  document.getElementById('cm-extracto-id').value = extractoId;
  document.getElementById('cm-motivo-ignorar').value = '';
  const cuenta = (state.cuentas||[]).find(c=>c.id===linea.cuenta_id);
  const montoOk = Number(linea.monto||0) >= 0;
  document.getElementById('cm-linea-info').innerHTML = `
    <div style="color:var(--text2);font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:4px">Línea del Extracto</div>
    <div style="font-weight:500">${fmtDate(linea.fecha)} — ${linea.descripcion||'—'}${linea.referencia?' · '+linea.referencia:''}</div>
    <div style="margin-top:6px"><span style="color:var(--text3);font-size:11px">Cuenta:</span> ${cuenta?.name||'—'} &nbsp; <span style="color:var(--text3);font-size:11px">Monto:</span>
      <strong style="font-family:'DM Mono',monospace;color:${montoOk?'var(--green)':'var(--red)'}">${montoOk?'+':'-'}${fmtGTQ(Math.abs(Number(linea.monto||0)))}</strong>
    </div>`;

  const yaVinculados = new Set((state.extractoBancario||[]).filter(l=>l.pago_id).map(l=>l.pago_id));
  const montoLinea = Number(linea.monto||0);
  // Mismo fix que autoMatchConciliacion(): incluir pagos a proveedores
  // (erp_pagos_oc), no solo cobros a clientes (erp_pagos).
  const candidatos = [...(state.pagos||[]), ...(state.pagosOC||[])]
    .filter(p=>p.cuenta_id===linea.cuenta_id && !yaVinculados.has(p.id))
    .map(p => ({ pago:p, signed: signedPagoMonto(p) }))
    .filter(c => Math.abs((new Date(linea.fecha) - new Date(c.pago.fecha))/86400000) <= 45)
    .sort((a,b) => {
      const da = Math.abs(a.signed-montoLinea), db = Math.abs(b.signed-montoLinea);
      if (Math.abs(da-db) > 0.001) return da - db;
      return Math.abs(new Date(linea.fecha)-new Date(a.pago.fecha)) - Math.abs(new Date(linea.fecha)-new Date(b.pago.fecha));
    });

  const cont = document.getElementById('cm-candidatos');
  cont.innerHTML = candidatos.length ? candidatos.map(c => {
    const f = (state.ocFacturas||[]).find(x=>x.id===c.pago.factura_id) || (state.facturas||[]).find(x=>x.id===c.pago.factura_id);
    const exacto = Math.abs(c.signed - montoLinea) < 0.01;
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:7px;background:var(--surface2);margin-bottom:6px;font-size:12px">
      <div>
        ${c.pago.num_pago?`<span style="font-family:'DM Mono',monospace;font-weight:700;color:var(--accent);margin-right:8px">${c.pago.num_pago}</span>`:''}
        <span style="font-weight:500">${fmtDate(c.pago.fecha)}</span>
        <span style="color:var(--text2);margin:0 6px">·</span>
        <span>${c.pago.forma||c.pago.metodo||'—'}</span>
        ${f ? `<span style="color:var(--text3);margin-left:6px">${f.serie||''}${f.numero||f.invoice_number||''}</span>` : ''}
        ${exacto?' <span class="badge badge-green" style="margin-left:6px">monto exacto</span>':''}
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <strong style="font-family:'DM Mono',monospace;color:${c.signed>=0?'var(--green)':'var(--red)'}">${c.signed>=0?'+':'-'}${fmtGTQ(Math.abs(c.signed))}</strong>
        <button class="btn btn-sm btn-primary" onclick="vincularManual('${extractoId}','${c.pago.id}')">Vincular</button>
      </div>
    </div>`;
  }).join('') : `<div style="color:var(--text3);font-size:12px;padding:10px">No hay pagos sin conciliar en esta cuenta con fecha cercana.</div>`;

  document.getElementById('cm-gasto-cuenta').innerHTML = '<option value="">— Seleccionar cuenta —</option>' +
    (state.nomenclatura||[]).filter(n=>n.activo!==false).map(n=>`<option value="${n.id}">${n.codigo?n.codigo+' — ':''}${n.nombre}</option>`).join('');

  openModal('modal-conciliar-manual');
}

// Dirección real de un pago (erp_pagos): 'egreso' si paga una factura de
// compra (OC, dinero sale), 'ingreso' si cobra una factura de venta (OV,
// dinero entra). null si no se puede determinar (no debería pasar en datos
// sanos, pero se contempla por seguridad). Mismo criterio que signedPagoMonto().
function _direccionPago(pago) {
  if ((state.ocFacturas||[]).some(f => f.id === pago.factura_id)) return 'egreso';
  if ((state.facturas||[]).some(f => f.id === pago.factura_id)) return 'ingreso';
  return null;
}

// ¿Hay una confirmación bancaria vigente para este pago? (>0 = sí). Compara
// cuántos asientos de confirmación se han generado contra cuántos se han
// revertido (deshacerConciliacion()) — así asientoConfirmacionBancaria() es
// idempotente y reversoConfirmacionBancaria() sabe si hay algo que revertir.
function _saldoConfirmacionPago(pagoId) {
  const confirmados = (state.asientos||[]).filter(a => a.referencia_id === pagoId && a.diario === 'CONCILIACION').length;
  const revertidos  = (state.asientos||[]).filter(a => a.referencia_id === pagoId && a.diario === 'CONCILIACION-REVERSO').length;
  return confirmados - revertidos;
}

// Líneas del asiento que mueve el monto entre la cuenta transitoria y el
// banco real — compartidas entre asientoConfirmacionBancaria() (Debe/Haber
// normal) y reversoConfirmacionBancaria() (invertidas), para que ambas
// nunca puedan quedar desincronizadas entre sí.
function _lineasConfirmacionBancaria(cuenta, ctaBanco, ctaTransitoria, monto, esEgreso) {
  return esEgreso ? [
    { cuenta_id: ctaTransitoria?.id||null, cuenta_codigo: ctaTransitoria?.codigo||'PAGOS-PEND', cuenta_nombre: ctaTransitoria?.nombre||'Pagos Pendientes', debe: monto, haber: 0, descripcion: 'Confirmado por banco' },
    { cuenta_id: ctaBanco?.id||null,       cuenta_codigo: ctaBanco?.codigo||'BANCO',            cuenta_nombre: cuenta?.name||'Banco', debe: 0, haber: monto, descripcion: 'Salida confirmada' },
  ] : [
    { cuenta_id: ctaBanco?.id||null,       cuenta_codigo: ctaBanco?.codigo||'BANCO',            cuenta_nombre: cuenta?.name||'Banco', debe: monto, haber: 0, descripcion: 'Entrada confirmada' },
    { cuenta_id: ctaTransitoria?.id||null, cuenta_codigo: ctaTransitoria?.codigo||'COBROS-PEND', cuenta_nombre: ctaTransitoria?.nombre||'Cobros Pendientes', debe: 0, haber: monto, descripcion: 'Confirmado por banco' },
  ];
}

// Segundo asiento del patrón de cuenta transitoria: se dispara cuando un
// pago (erp_pagos) queda vinculado con certeza a una línea del extracto
// bancario (vincularManual() o autoMatchConciliacion()) — mueve el monto de
// la cuenta "Pendiente de Confirmar" a la cuenta real del banco. Idempotente
// vía _saldoConfirmacionPago(): no duplica la confirmación si ya hay una
// vigente. No genera nada si no se puede determinar la dirección del pago
// (evita adivinar y dejar un asiento mal formado).
async function asientoConfirmacionBancaria(pagoId, fechaConfirmacion) {
  // Busca en ambas tablas — el pago puede ser un cobro (erp_pagos) o un
  // pago a proveedor (erp_pagos_oc). Antes solo buscaba en erp_pagos, así
  // que la confirmación bancaria nunca se generaba para pagos a proveedores.
  const pago = (state.pagos||[]).find(p => p.id === pagoId) || (state.pagosOC||[]).find(p => p.id === pagoId);
  if (!pago) return;
  if (_saldoConfirmacionPago(pagoId) > 0) return;

  const direccion = _direccionPago(pago);
  if (!direccion) return;

  const cuenta = (state.cuentas||[]).find(c => c.id === pago.cuenta_id);
  const moneda = cuenta?.moneda || 'GTQ';
  const monto  = Number(pago.monto||0);
  if (!monto) return;

  const esEgreso       = direccion === 'egreso';
  const ctaBanco       = bancoNomenclatura(pago.cuenta_id);
  const ctaTransitoria = transitoriaNomenclatura(moneda, esEgreso ? 'pago' : 'cobro');

  await crearAsiento({
    diario: 'CONCILIACION', fecha: fechaConfirmacion || pago.fecha,
    descripcion: `Confirmación bancaria — ${cuenta?.name||'Banco'}`,
    referencia: 'Conciliación de pago', referencia_id: pagoId,
    moneda,
    lineas: _lineasConfirmacionBancaria(cuenta, ctaBanco, ctaTransitoria, monto, esEgreso),
  });
}

// Reverso del asiento anterior — se dispara desde deshacerConciliacion()
// cuando se desvincula un pago que ya tenía una confirmación bancaria
// vigente. Se registra como un asiento NUEVO con Debe/Haber invertidos (no
// se edita ni se borra el asiento original) — es la práctica contable
// correcta y mantiene el rastro de auditoría completo.
async function reversoConfirmacionBancaria(pagoId, fecha) {
  const pago = (state.pagos||[]).find(p => p.id === pagoId) || (state.pagosOC||[]).find(p => p.id === pagoId);
  if (!pago) return;
  if (_saldoConfirmacionPago(pagoId) <= 0) return;

  const direccion = _direccionPago(pago);
  if (!direccion) return;

  const cuenta = (state.cuentas||[]).find(c => c.id === pago.cuenta_id);
  const moneda = cuenta?.moneda || 'GTQ';
  const monto  = Number(pago.monto||0);
  if (!monto) return;

  const esEgreso       = direccion === 'egreso';
  const ctaBanco       = bancoNomenclatura(pago.cuenta_id);
  const ctaTransitoria = transitoriaNomenclatura(moneda, esEgreso ? 'pago' : 'cobro');

  const lineasBase = _lineasConfirmacionBancaria(cuenta, ctaBanco, ctaTransitoria, monto, esEgreso);
  const lineasReversas = lineasBase.map(l => ({ ...l, debe: l.haber, haber: l.debe, descripcion: 'Reverso — ' + (l.descripcion||'') }));

  await crearAsiento({
    diario: 'CONCILIACION-REVERSO', fecha: fecha || today(),
    descripcion: `Reverso de confirmación bancaria — ${cuenta?.name||'Banco'}`,
    referencia: 'Deshacer conciliación', referencia_id: pagoId,
    moneda,
    lineas: lineasReversas,
  });
}

async function vincularManual(extractoId, pagoId) {
  const linea = (state.extractoBancario||[]).find(l => l.id === extractoId);
  const { error } = await sb.from('erp_extracto_bancario').update({
    pago_id: pagoId, estado:'conciliado', match_tipo:'manual', conciliado_at: new Date().toISOString(), motivo_ignorado: null,
  }).eq('id', extractoId);
  if (error) { toast('Error: '+error.message,'error'); return; }
  await asientoConfirmacionBancaria(pagoId, linea?.fecha);
  toast('✓ Línea conciliada');
  closeModal('modal-conciliar-manual');
  await loadAll();
  renderConciliacion();
}

async function ignorarLineaExtracto() {
  const extractoId = document.getElementById('cm-extracto-id').value;
  const motivo = document.getElementById('cm-motivo-ignorar').value.trim();
  if (!motivo) { toast('Escribe un motivo para ignorar la línea','error'); return; }
  const { error } = await sb.from('erp_extracto_bancario').update({
    estado:'ignorado', match_tipo:null, pago_id:null, motivo_ignorado: motivo, conciliado_at: new Date().toISOString(),
  }).eq('id', extractoId);
  if (error) { toast('Error: '+error.message,'error'); return; }
  toast('Línea marcada como ignorada');
  closeModal('modal-conciliar-manual');
  await loadAll();
  renderConciliacion();
}

async function deshacerConciliacion(extractoId) {
  if (!confirm('¿Deshacer la conciliación de esta línea? Volverá a quedar pendiente.')) return;
  const linea = (state.extractoBancario||[]).find(l => l.id === extractoId);
  const pagoIdPrevio = linea?.pago_id || null;
  const { error } = await sb.from('erp_extracto_bancario').update({
    estado:'pendiente', pago_id:null, match_tipo:null, motivo_ignorado:null, conciliado_at:null,
  }).eq('id', extractoId);
  if (error) { toast('Error: '+error.message,'error'); return; }
  // Si el pago ya tenía una confirmación bancaria vigente (Debe/Haber contra
  // el banco real), hay que revertirla — si no, el dinero quedaría "salido
  // del banco" en la contabilidad aunque la conciliación que lo confirmaba
  // se acaba de deshacer.
  if (pagoIdPrevio) await reversoConfirmacionBancaria(pagoIdPrevio, today());
  toast('Conciliación deshecha');
  await loadAll();
  renderConciliacion();
}

// Movimiento propio del banco sin contraparte en el sistema (comisiones, intereses, etc.):
// genera un asiento simple Banco vs la cuenta contable elegida, y concilia la línea.
async function registrarGastoBancario() {
  const extractoId = document.getElementById('cm-extracto-id').value;
  const cuentaContableId = document.getElementById('cm-gasto-cuenta').value;
  if (!cuentaContableId) { toast('Selecciona una cuenta contable','error'); return; }
  const linea = (state.extractoBancario||[]).find(l=>l.id===extractoId);
  if (!linea) return;

  const cuentaBancaria = (state.cuentas||[]).find(c=>c.id===linea.cuenta_id);
  const ctaBancoNom = bancoNomenclatura(linea.cuenta_id);
  const ctaOtra = (state.nomenclatura||[]).find(n=>n.id===cuentaContableId);
  const monto = Math.abs(Number(linea.monto||0));
  const esAbono = Number(linea.monto||0) >= 0;

  await crearAsiento({
    diario:'BANCOS', fecha: linea.fecha,
    descripcion: `Movimiento bancario — ${linea.descripcion||(esAbono?'Abono':'Cargo')} (${cuentaBancaria?.name||'Banco'})`,
    referencia: linea.referencia||`EXTRACTO-${linea.fecha}`, referencia_id: extractoId, moneda:'GTQ',
    lineas: esAbono ? [
      { cuenta_id: ctaBancoNom?.id||null, cuenta_codigo: ctaBancoNom?.codigo||'BANCO', cuenta_nombre: cuentaBancaria?.name||'Banco', debe: monto, haber: 0 },
      { cuenta_id: ctaOtra?.id||null, cuenta_codigo: ctaOtra?.codigo||'', cuenta_nombre: ctaOtra?.nombre||'', debe: 0, haber: monto },
    ] : [
      { cuenta_id: ctaOtra?.id||null, cuenta_codigo: ctaOtra?.codigo||'', cuenta_nombre: ctaOtra?.nombre||'', debe: monto, haber: 0 },
      { cuenta_id: ctaBancoNom?.id||null, cuenta_codigo: ctaBancoNom?.codigo||'BANCO', cuenta_nombre: cuentaBancaria?.name||'Banco', debe: 0, haber: monto },
    ],
  });

  const { error } = await sb.from('erp_extracto_bancario').update({
    estado:'conciliado', match_tipo:'gasto', motivo_ignorado: `Registrado como movimiento bancario — ${ctaOtra?.nombre||''}`, conciliado_at: new Date().toISOString(),
  }).eq('id', extractoId);
  if (error) { toast('Error: '+error.message,'error'); return; }

  toast('✓ Movimiento registrado y conciliado');
  closeModal('modal-conciliar-manual');
  await loadAll();
  renderConciliacion();
}

// ── Reporte: Saldo Banco vs Saldo Libros ──
function calcSaldoLibros(cuentaId, fechaCorte) {
  const cuenta = (state.cuentas||[]).find(c=>c.id===cuentaId);
  let saldo = Number(cuenta?.saldo_inicial||0);
  // Dinero que ENTRA (cobros a clientes, erp_pagos) y que SALE (pagos a
  // proveedores, erp_pagos_oc) — la conciliación bancaria debe cuadrar
  // ambos flujos, no solo cobros. signedPagoMonto() ya distinguía el signo
  // correcto para ambos (negativo si el factura_id pertenece a
  // erp_oc_facturas), pero antes solo se recorría state.pagos.
  [...(state.pagos||[]), ...(state.pagosOC||[])]
    .filter(p=>p.cuenta_id===cuentaId && (!fechaCorte || p.fecha<=fechaCorte))
    .forEach(p => saldo += signedPagoMonto(p));
  (state.ocAnticipos||[]).filter(a=>a.cuenta_id===cuentaId && (!fechaCorte || a.fecha<=fechaCorte))
    .forEach(a => saldo -= Number(a.monto||0));
  return saldo;
}

function renderReporteSaldos() {
  const body = document.getElementById('conc-reporte-body');
  if (!body) return;
  const cuentaId = document.getElementById('conc-cuenta')?.value || '';

  if (!cuentaId) {
    const filas = (state.cuentas||[]).filter(c=>c.activa!==false).map(cuenta => {
      const lotes = (state.extractoLotes||[]).filter(l=>l.cuenta_id===cuenta.id).sort((a,b)=>(b.fecha_fin||'').localeCompare(a.fecha_fin||''));
      const ultimoLote  = lotes[0];
      const saldoBanco  = ultimoLote ? Number(ultimoLote.saldo_final) : null;
      const saldoLibros = calcSaldoLibros(cuenta.id, ultimoLote?.fecha_fin);
      const dif = saldoBanco !== null ? saldoBanco - saldoLibros : null;
      return { cuenta, ultimoLote, saldoBanco, saldoLibros, dif };
    });

    body.innerHTML = `
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em">MTG Textiles</div>
        <div style="font-size:18px;font-weight:700;margin:4px 0">Saldo Banco vs Saldo Libros — Todas las Cuentas</div>
        <div style="font-size:12px;color:var(--text2)">Selecciona una cuenta específica arriba para ver el detalle de la conciliación</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:var(--surface2)">
          <th style="padding:8px 14px;text-align:left">Cuenta</th>
          <th style="padding:8px 14px;text-align:left">Último Extracto</th>
          <th style="padding:8px 14px;text-align:right">Saldo Banco</th>
          <th style="padding:8px 14px;text-align:right">Saldo Libros</th>
          <th style="padding:8px 14px;text-align:right">Diferencia</th>
        </tr></thead>
        <tbody>
        ${filas.map(f => `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:8px 14px;font-weight:500">${f.cuenta.name}</td>
          <td style="padding:8px 14px;font-size:12px;color:var(--text2)">${f.ultimoLote?fmtDate(f.ultimoLote.fecha_fin):'Sin cargas'}</td>
          <td class="td-mono" style="padding:8px 14px;text-align:right">${f.saldoBanco!==null?fmtGTQ(f.saldoBanco):'—'}</td>
          <td class="td-mono" style="padding:8px 14px;text-align:right">${fmtGTQ(f.saldoLibros)}</td>
          <td class="td-mono" style="padding:8px 14px;text-align:right;font-weight:700;color:${f.dif===null?'var(--text3)':Math.abs(f.dif)<0.01?'var(--green)':'var(--red)'}">${f.dif!==null?fmtGTQ(f.dif):'—'}</td>
        </tr>`).join('')}
        </tbody>
      </table>`;
    return;
  }

  const cuenta = (state.cuentas||[]).find(c=>c.id===cuentaId);
  const lotes  = (state.extractoLotes||[]).filter(l=>l.cuenta_id===cuentaId).sort((a,b)=>(b.fecha_fin||'').localeCompare(a.fecha_fin||''));
  const ultimoLote = lotes[0];

  if (!ultimoLote) {
    body.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text3)">Aún no se ha subido ningún extracto para <strong>${cuenta?.name||''}</strong>.</div>`;
    return;
  }

  const fechaCorte  = ultimoLote.fecha_fin;
  const saldoBanco  = Number(ultimoLote.saldo_final);
  const saldoLibros = calcSaldoLibros(cuentaId, fechaCorte);

  const vinculadosSet = new Set((state.extractoBancario||[]).filter(l=>l.pago_id).map(l=>l.pago_id));
  const pagosSinConciliar = (state.pagos||[]).filter(p=>p.cuenta_id===cuentaId && p.fecha<=fechaCorte && !vinculadosSet.has(p.id));
  const sumaPagosSinConciliar = pagosSinConciliar.reduce((s,p)=>s+signedPagoMonto(p),0);

  const extractoSinConciliar = (state.extractoBancario||[]).filter(l=>l.cuenta_id===cuentaId && l.fecha<=fechaCorte && l.estado==='pendiente');
  const sumaExtractoSinConciliar = extractoSinConciliar.reduce((s,l)=>s+Number(l.monto||0),0);

  const saldoBancoAjustado  = saldoBanco  + sumaPagosSinConciliar;
  const saldoLibrosAjustado = saldoLibros + sumaExtractoSinConciliar;
  const diferenciaFinal = saldoBancoAjustado - saldoLibrosAjustado;
  const cuadra = Math.abs(diferenciaFinal) < 0.01;

  const filaPago = r => {
    const f = (state.ocFacturas||[]).find(x=>x.id===r.factura_id) || (state.facturas||[]).find(x=>x.id===r.factura_id);
    const signed = signedPagoMonto(r);
    return `<tr><td style="padding:6px 10px;font-size:12px">${fmtDate(r.fecha)}</td><td style="padding:6px 10px;font-size:12px">${r.num_pago||''} ${f?.serie||''}${f?.numero||f?.invoice_number||''}</td><td class="td-mono" style="padding:6px 10px;text-align:right;font-size:12px;color:${signed>=0?'var(--green)':'var(--red)'}">${signed>=0?'+':'-'}${fmtGTQ(Math.abs(signed))}</td></tr>`;
  };
  const filaExtracto = r => `<tr><td style="padding:6px 10px;font-size:12px">${fmtDate(r.fecha)}</td><td style="padding:6px 10px;font-size:12px">${r.descripcion||'—'}</td><td class="td-mono" style="padding:6px 10px;text-align:right;font-size:12px;color:${Number(r.monto)>=0?'var(--green)':'var(--red)'}">${Number(r.monto)>=0?'+':'-'}${fmtGTQ(Math.abs(Number(r.monto)))}</td></tr>`;

  body.innerHTML = `
    <div style="text-align:center;margin-bottom:24px">
      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em">MTG Textiles</div>
      <div style="font-size:18px;font-weight:700;margin:4px 0">Conciliación Bancaria — ${cuenta?.name||''}</div>
      <div style="font-size:12px;color:var(--text2)">Corte al ${fmtDate(fechaCorte)} · último extracto cargado</div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
      <div>
        <div style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--text3);margin-bottom:10px">Saldo Según Banco</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="padding:6px 4px">Saldo extracto (${fmtDate(fechaCorte)})</td><td class="td-mono" style="padding:6px 4px;text-align:right">${fmtGTQ(saldoBanco)}</td></tr>
          <tr><td style="padding:6px 4px">+ Pagos registrados en libros, aún no reflejados en banco</td><td class="td-mono" style="padding:6px 4px;text-align:right">${fmtGTQ(sumaPagosSinConciliar)}</td></tr>
          <tr style="border-top:1.5px solid var(--border);font-weight:700"><td style="padding:8px 4px">= Saldo Bancario Conciliado</td><td class="td-mono" style="padding:8px 4px;text-align:right">${fmtGTQ(saldoBancoAjustado)}</td></tr>
        </table>
        ${pagosSinConciliar.length ? `<div style="margin-top:10px;max-height:160px;overflow:auto"><table style="width:100%">${pagosSinConciliar.map(filaPago).join('')}</table></div>` : '<div style="font-size:12px;color:var(--text3);margin-top:8px">Todos los pagos están conciliados con el banco.</div>'}
      </div>
      <div>
        <div style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--text3);margin-bottom:10px">Saldo Según Libros</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="padding:6px 4px">Saldo en libros (${fmtDate(fechaCorte)})</td><td class="td-mono" style="padding:6px 4px;text-align:right">${fmtGTQ(saldoLibros)}</td></tr>
          <tr><td style="padding:6px 4px">+ Movimientos del banco aún no registrados en libros</td><td class="td-mono" style="padding:6px 4px;text-align:right">${fmtGTQ(sumaExtractoSinConciliar)}</td></tr>
          <tr style="border-top:1.5px solid var(--border);font-weight:700"><td style="padding:8px 4px">= Saldo en Libros Conciliado</td><td class="td-mono" style="padding:8px 4px;text-align:right">${fmtGTQ(saldoLibrosAjustado)}</td></tr>
        </table>
        ${extractoSinConciliar.length ? `<div style="margin-top:10px;max-height:160px;overflow:auto"><table style="width:100%">${extractoSinConciliar.map(filaExtracto).join('')}</table></div>` : '<div style="font-size:12px;color:var(--text3);margin-top:8px">No hay movimientos del banco pendientes de registrar.</div>'}
      </div>
    </div>

    <div style="background:${cuadra?'var(--green-bg)':'var(--red-bg)'};border-radius:10px;padding:18px;text-align:center">
      <div style="font-size:11px;text-transform:uppercase;font-weight:600;letter-spacing:0.06em;margin-bottom:6px;color:${cuadra?'var(--green)':'var(--red)'}">${cuadra?'✓ Concilia Correctamente':'✗ Diferencia Sin Explicar'}</div>
      <div style="font-size:24px;font-weight:700;font-family:'DM Mono',monospace;color:${cuadra?'var(--green)':'var(--red)'}">${fmtGTQ(diferenciaFinal)}</div>
      ${!cuadra?'<div style="font-size:11px;color:var(--text2);margin-top:6px">Revisa montos duplicados, pagos con cuenta bancaria incorrecta, o movimientos del extracto sin conciliar ni ignorar.</div>':''}
    </div>
  `;
}

// ═══ CUENTAS BANCARIAS ═══
function renderCuentas() {
  const q = (document.getElementById('search-cuentas')?.value||'').toLowerCase();
  const data = state.cuentas.filter(c => c.name.toLowerCase().includes(q) || (c.banco||'—').toLowerCase().includes(q));
  const tbody = document.getElementById('tbl-cuentas');
  if (!tbody) return;
  tbody.innerHTML = data.length ? data.map(c => `<tr>
    <td><strong>${c.name}</strong></td>
    <td class="hide-mobile">${c.banco||'—'}</td>
    <td class="hide-mobile td-mono">${c.numero||'—'}</td>
    <td><span class="badge badge-blue">${c.moneda||'GTQ'}</span></td>
    <td>${statusBadge(c.activa !== false ? 'activo':'inactivo')}</td>
    <td><div class="td-actions">
      <button class="btn btn-sm btn-ghost" onclick="editCuenta('${c.id}')">Editar</button>
      <button class="btn btn-sm btn-danger" onclick="deleteCuenta('${c.id}')">Eliminar</button>
    </div></td>
  </tr>`).join('') : '<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◉</div><p>Sin cuentas registradas</p></div></td></tr>';
}

// Cuentas de nomenclatura tipo "Banco y efectivo" — para mapear cada cuenta
// bancaria operativa (erp_cuentas) a SU cuenta contable real del mayor.
function _cuentaNomenclaturaOpts(selectedId) {
  return (state.nomenclatura||[]).filter(n=>n.tipo==='Banco y efectivo' && n.activo!==false)
    .sort((a,b)=>(a.codigo||'').localeCompare(b.codigo||''))
    .map(n=>`<option value="${n.id}" ${n.id===selectedId?'selected':''}>${n.codigo?n.codigo+' — ':''}${n.nombre}</option>`).join('');
}

function openNewCuenta() {
  document.getElementById('cta-id').value = '';
  document.getElementById('cta-name').value = '';
  document.getElementById('cta-banco').value = '';
  document.getElementById('cta-numero').value = '';
  document.getElementById('cta-moneda').value = 'GTQ';
  document.getElementById('cta-activa').value = 'true';
  document.getElementById('cta-notes').value = '';
  document.getElementById('cta-nomenclatura').innerHTML = '<option value="">— Sin asignar (usa cualquier cuenta "Banco y efectivo") —</option>' + _cuentaNomenclaturaOpts('');
  document.getElementById('modal-cuenta-title').textContent = 'Nueva Cuenta';
  openModal('modal-cuenta');
}

function editCuenta(id) {
  const c = state.cuentas.find(x => x.id === id);
  document.getElementById('cta-id').value    = c.id;
  document.getElementById('cta-name').value  = c.name||'';
  document.getElementById('cta-banco').value = c.banco||'';
  document.getElementById('cta-numero').value= c.numero||'';
  document.getElementById('cta-moneda').value= c.moneda||'GTQ';
  document.getElementById('cta-activa').value= String(c.activa !== false);
  document.getElementById('cta-notes').value = c.notes||'';
  document.getElementById('cta-nomenclatura').innerHTML = '<option value="">— Sin asignar (usa cualquier cuenta "Banco y efectivo") —</option>' + _cuentaNomenclaturaOpts(c.nomenclatura_id||'');
  document.getElementById('modal-cuenta-title').textContent = 'Editar Cuenta';
  openModal('modal-cuenta');
}

async function saveCuenta() {
  const id   = document.getElementById('cta-id').value;
  const name = document.getElementById('cta-name').value.trim();
  if (!name) { toast('El nombre es requerido','error'); return; }
  const row = {
    name,
    banco:  document.getElementById('cta-banco').value.trim(),
    numero: document.getElementById('cta-numero').value.trim(),
    moneda: document.getElementById('cta-moneda').value,
    activa: document.getElementById('cta-activa').value === 'true',
    notes:  document.getElementById('cta-notes').value.trim(),
    nomenclatura_id: document.getElementById('cta-nomenclatura').value || null,
  };
  let err;
  if (id) { ({error:err} = await sb.from('erp_cuentas').update(row).eq('id',id)); }
  else     { ({error:err} = await sb.from('erp_cuentas').insert(row)); }
  if (err) { toast('Error: '+err.message,'error'); return; }
  // Reset form
  ['cta-id','cta-name','cta-banco','cta-numero','cta-notes'].forEach(x => document.getElementById(x).value='');
  document.getElementById('cta-moneda').value = 'GTQ';
  document.getElementById('cta-activa').value = 'true';
  document.getElementById('cta-nomenclatura').innerHTML = '<option value="">— Sin asignar (usa cualquier cuenta "Banco y efectivo") —</option>' + _cuentaNomenclaturaOpts('');
  document.getElementById('modal-cuenta-title').textContent = 'Nueva Cuenta';
  toast('Cuenta guardada');
  closeModal('modal-cuenta');
  await loadAll();
}

async function deleteCuenta(id) {
  if (!confirm('¿Eliminar esta cuenta?')) return;
  const {error} = await sb.from('erp_cuentas').delete().eq('id',id);
  if (error) { toast('Error: '+error.message,'error'); return; }
  toast('Cuenta eliminada');
  await loadAll();
}
