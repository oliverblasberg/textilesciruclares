// ═══════════════════════════════════════════════════════════════
// COMPRAS — extraído de index.html (Fase 7 modularización, 11/Sep/2026)
// Proveedores, Órdenes de Compra (SC/OC), Recepción de OC (incl. Packing
// List de Hilo y captura de rollos), Retención ISR, Pagos a Proveedor,
// Libro de Compras (facturas de OC / FOC) y Anticipos a proveedor.
//
// Extraído en 14 bloques no contiguos del index.html original (mismo
// patrón que js/contabilidad.js, Fase 5) — el dominio Compras está
// entrelazado con Ventas y Producción a lo largo del archivo, así que se
// dejó constancia con breadcrumbs en cada punto de corte.
//
// Funciones/variables COMPARTIDAS entre Compras y Ventas/Producción
// (resolveMoneda, incotermsOpts, terminosPagoOpts, transitoriaNomenclatura,
// sinAplicarNomenclatura, pagoTab y el resto del modal genérico de pago,
// nextReabastecimientoNum, nextDevolucionNum, prodName, populateBodegaSelect,
// populateOVSelect, devolucionesREADe, devolucionesDespachoDeOV,
// verDevolucion, imprimirDevolucion, verReabastecimiento,
// devolverReabastecimiento, imprimirReabastecimiento, hideGlobalSearch,
// onGlobalSearch, bancoNomenclatura, _pagoCtaOrigenOpts) NO se movieron —
// quedan como funciones globales en el script principal, igual que
// signedPagoMonto en js/bancos.js. Ver mapa_modulos_1.md para el catálogo
// completo de dominio.
//
// Cargar DESPUÉS de js/inventario.js y ANTES del script principal.
// ═══════════════════════════════════════════════════════════════

// ── PAGOS OC — nextNumPago, _pagoCtaOptsProveedor (index.html original: líneas 10172-10196) ──
async function nextNumPago() {
  const now    = new Date();
  const year   = now.getFullYear();
  const month  = String(now.getMonth()+1).padStart(2,'0');
  const prefix = `NP-${year}-${month}-`;
  const { data } = await sb.from('erp_pagos_oc').select('num_pago').ilike('num_pago', `${prefix}%`);
  const nums = (data||[]).map(p => parseInt((p.num_pago||'').slice(-3))||0);
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}${String(next).padStart(3,'0')}`;
}

// Cuenta bancaria del PROVEEDOR — solo informativa (se anexa a las notas del
// pago si se selecciona). Nunca es obligatoria para registrar el pago; el
// asiento contable real usa siempre la Cuenta de Origen (la cuenta propia de
// la empresa), no esta.
function _pagoCtaOptsProveedor(provId) {
  const prov = (state.proveedores||[]).find(p=>p.id===provId);
  let opts = '<option value="">— Seleccionar cuenta —</option>';
  if (prov?.banco || prov?.num_cuenta) {
    const tipo  = prov.tipo_cuenta === 'monetaria' ? 'Monetaria' : prov.tipo_cuenta === 'ahorro' ? 'Ahorro' : prov.tipo_cuenta||'';
    const label = [prov.banco, tipo, prov.num_cuenta].filter(Boolean).join(' · ');
    opts += `<option value="prov-${prov.id}" selected data-banco="${prov.banco||''}" data-tipo="${prov.tipo_cuenta||''}" data-num="${prov.num_cuenta||''}">${label}</option>`;
  }
  return opts;
}

// ── PAGOS OC — RETENCIÓN ISR (banner + retencionISRFactura + ctaRetencionISR) (index.html original: líneas 10231-10265) ──
// ═══════════════════════════════════════════════════
// (COMPRAS — retención aplica solo a proveedores, nunca a clientes.)
// RETENCIÓN ISR — Art. 39 Decreto 10-2012. 5%/7% sobre el NETO (sin IVA)
// de la factura del proveedor, por FACTURA INDIVIDUAL (no acumulado
// mensual). Solo aplica si el proveedor está en Régimen Opcional
// Simplificado Y la factura indica "Sujeto a Retención ISR" (no "Pagos
// Directos"). Verificado con ejemplo real del contador (Robert Cardona):
// factura Q35,000 (con IVA) → neto Q31,250 → retención Q1,587.50.
// Los subcontratistas de producción (tejido/tintura/acabado) están
// exentos por Decreto 29-89 — quedan fuera automáticamente porque su
// regimen_isr es 'exento_29_89', no 'opcional_simplificado'.
// ═══════════════════════════════════════════════════
// calcRetencionISR() vive ahora en js/helpers-calculo.js

// Retención ISR que corresponde a una factura de OC específica, o 0 si no
// aplica. El neto se toma de erp_compras.valor_neto (el mismo valor real
// que ya quedó grabado en el Libro de Compras al generar la factura —
// misma fuente que usa asientoFacturaCompra(), nunca se recalcula el IVA
// de nuevo aquí).
function retencionISRFactura(facturaId) {
  const f = (state.ocFacturas||[]).find(x => x.id === facturaId);
  if (!f || !f.sujeto_retencion_isr) return 0;
  const oc   = (state.oc||[]).find(o => o.id === f.oc_id);
  const prov = (state.proveedores||[]).find(p => p.id === oc?.proveedor_id);
  if (prov?.regimen_isr !== 'opcional_simplificado') return 0;
  const compra = (state.compras||[]).find(c => c.factura_id === facturaId);
  const neto   = compra ? Number(compra.valor_neto||0) : 0;
  return calcRetencionISR(neto);
}

// (COMPRAS — solo proveedores tienen retención ISR.)
// Cuenta de nomenclatura "Retenciones - ISR por pagar - proveedores" (21104002).
function ctaRetencionISR() {
  return (state.nomenclatura||[]).find(n => n.codigo === '21104002');
}

// ── PAGOS OC — buildLineasPago (index.html original: líneas 10297-10399) ──
// Construye las líneas del asiento que se generará para el pago actual del
// modal — lee directamente los campos del formulario. Es la MISMA función que
// usa savePago() al grabar y el tab "Información Contable" para previsualizar
// en vivo, así preview y grabación real NUNCA pueden mostrar cosas distintas.
// Solo soporta tipo 'OC' (pago a proveedor) — el flujo de cobro a cliente (OV)
// hoy no genera asiento automático desde este modal, así que retorna [] y el
// preview lo indica explícitamente en vez de mostrar algo inventado.
//
// Moneda: el monto en el formulario está en la moneda de la OC/factura (ver
// _pagoSetMoneda), NO siempre en GTQ — y tanto la cuenta de Cuentas x Pagar
// como la cuenta de Banco pueden estar configuradas en la nomenclatura con
// moneda propia (ej. un banco en USD). Por eso estas líneas se devuelven en
// SU MONEDA ORIGINAL (sin convertir) — es crearAsiento() quien, recibiendo
// `moneda` a nivel de asiento, hace la conversión a GTQ para el balance
// (debe_gtq/haber_gtq) Y conserva el monto real por línea (monto_orig/
// moneda_orig) para poder conciliar la cuenta bancaria contra su propio
// estado de cuenta en USD — igual patrón que buildLineasFacturaCompra() /
// asientoFacturaCompra(). El diferencial cambiario contra la factura
// original (si el TC del día de pago difiere del TC de la factura) se
// registra aparte en savePago() vía asientoDiferencialCambiario().
// (COMPRAS — construye asiento de pago a proveedor. Su análogo en Ventas
// sería una función de cobro de cliente, que aquí no existe separada.)
function buildLineasPago() {
  const modo      = document.getElementById('pago-modo').value;
  const tipo      = document.getElementById('pago-factura-id').dataset.tipo;
  const facturaId = document.getElementById('pago-factura-id').value;
  const cuenta_id = document.getElementById('pago-cuenta-origen').value;
  const monto     = parseFloat(document.getElementById('pago-monto').value) || 0;

  if (tipo !== 'OC' || !cuenta_id || !monto) return [];

  const cuentaBancaria = (state.cuentas||[]).find(c => c.id === cuenta_id);
  // El pago NO se contabiliza directo contra el banco — se contabiliza contra
  // la cuenta transitoria "Pagos Pendientes" de su moneda. Solo cuando el
  // extracto bancario confirma el movimiento (vincularManual()/
  // autoMatchConciliacion() → asientoConfirmacionBancaria()) se genera el
  // segundo asiento que mueve el monto de la transitoria al banco real.
  const ctaTransitoria = transitoriaNomenclatura(cuentaBancaria?.moneda || 'GTQ', 'pago');

  if (modo === 'single') {
    const f = state.ocFacturas.find(x => x.id === facturaId);
    if (!f) return [];
    const ctaPorPagar = ctaPorPagarOC(f.oc_id);
    // Descripción de la línea de Cuentas x Pagar: "Proveedor - Serie - Número"
    // (antes solo mostraba serie+número, sin identificar al proveedor).
    const ocSingle   = state.oc.find(o => o.id === f.oc_id);
    const provSingle = state.proveedores.find(p => p.id === ocSingle?.proveedor_id);
    const descCxP    = [provSingle?.name, f.serie, f.numero].filter(Boolean).join(' - ');
    // Retención ISR — lee el campo editable (pre-poblado automático en
    // openPagoOC() vía retencionISRFactura()); si el campo está oculto/vacío
    // no hay retención. La CxP se extingue por el monto completo, pero el
    // efectivo que sale (vía Pagos Pendientes) es el monto MENOS la retención,
    // y la retención va a la cuenta 21104002.
    const retIsrEl = document.getElementById('pago-retencion-isr');
    const retencion = Math.min(
      (retIsrEl && retIsrEl.closest('#pago-retencion-isr-wrap')?.style.display !== 'none') ? (parseFloat(retIsrEl.value)||0) : 0,
      monto
    );
    const lineas = [
      { cuenta_id: ctaPorPagar?.id||null, cuenta_codigo: ctaPorPagar?.codigo||'CXP', cuenta_nombre: ctaPorPagar?.nombre||'Cuentas x Pagar', debe: monto, haber: 0, descripcion: descCxP },
    ];
    if (retencion > 0) {
      const ctaRetIsr = ctaRetencionISR();
      lineas.push({ cuenta_id: ctaRetIsr?.id||null, cuenta_codigo: ctaRetIsr?.codigo||'21104002', cuenta_nombre: ctaRetIsr?.nombre||'Retenciones ISR por Pagar', debe: 0, haber: retencion, descripcion: `Retención ISR — ${descCxP}` });
    }
    lineas.push({ cuenta_id: ctaTransitoria?.id||null, cuenta_codigo: ctaTransitoria?.codigo||'PAGOS-PEND', cuenta_nombre: ctaTransitoria?.nombre||'Pagos Pendientes', debe: 0, haber: monto - retencion, descripcion: `Pendiente de confirmar — ${cuentaBancaria?.name||''}` });
    return lineas;
  }

  // Multi-factura — una línea de CxP por factura (puede caer en cuentas
  // distintas si las facturas son de proveedores/monedas distintas) + una
  // sola línea de la cuenta transitoria por el monto total escrito en el
  // formulario. Todas las facturas de un mismo pago múltiple comparten
  // moneda (validado al abrir el modal en openPagoProveedor()/
  // openPagoDesdeCompras()).
  const distribs = [];
  document.querySelectorAll('#pago-dist-tbody input').forEach(el => {
    const v = parseFloat(el.value)||0;
    if (v > 0) distribs.push({ factura_id: el.dataset.factura, monto: v });
  });
  if (!distribs.length) return [];

  const lineas = distribs.map(d => {
    const f = state.ocFacturas.find(x => x.id === d.factura_id);
    const ctaPorPagar = ctaPorPagarOC(f?.oc_id);
    // Misma descripción "Proveedor - Serie - Número" por factura (pueden ser
    // de proveedores distintos en un pago múltiple).
    const ocMulti   = state.oc.find(o => o.id === f?.oc_id);
    const provMulti = state.proveedores.find(p => p.id === ocMulti?.proveedor_id);
    const descCxP   = [provMulti?.name, f?.serie, f?.numero].filter(Boolean).join(' - ');
    return { cuenta_id: ctaPorPagar?.id||null, cuenta_codigo: ctaPorPagar?.codigo||'CXP', cuenta_nombre: ctaPorPagar?.nombre||'Cuentas x Pagar', debe: d.monto, haber: 0, descripcion: descCxP };
  });
  // Retención ISR — calculada automáticamente por factura (no editable en
  // modo múltiple, a diferencia del modo single; cada factura puede tener
  // su propia retención según su régimen/neto). Se agrupa en una sola línea.
  const totalRetencion = distribs.reduce((s, d) => s + Math.min(retencionISRFactura(d.factura_id), d.monto), 0);
  if (totalRetencion > 0) {
    const ctaRetIsr = ctaRetencionISR();
    lineas.push({ cuenta_id: ctaRetIsr?.id||null, cuenta_codigo: ctaRetIsr?.codigo||'21104002', cuenta_nombre: ctaRetIsr?.nombre||'Retenciones ISR por Pagar', debe: 0, haber: parseFloat(totalRetencion.toFixed(2)), descripcion: 'Retención ISR — pago múltiple' });
  }
  lineas.push({ cuenta_id: ctaTransitoria?.id||null, cuenta_codigo: ctaTransitoria?.codigo||'PAGOS-PEND', cuenta_nombre: ctaTransitoria?.nombre||'Pagos Pendientes', debe: 0, haber: parseFloat((monto - totalRetencion).toFixed(2)), descripcion: `Pago múltiple — pendiente de confirmar (${cuentaBancaria?.name||''})` });
  return lineas;
}

// ── PAGOS OC — _pagoToggleInfoProveedor, _pagoSinAplicarProveedor, _pagoHistorial, openPagoOC, openPagoProveedor (index.html original: líneas 10506-10718) ──
// (COMPRAS — cluster _pagoToggleInfoProveedor/_pagoSinAplicarProveedor/
// _pagoHistorial/openPagoOC/openPagoProveedor es exclusivo de pagos a
// proveedor.)
// Muestra/oculta la sección "Información Proveedor" (cuenta bancaria del
// proveedor — solo informativa, ver _pagoCtaOptsProveedor). Visible para
// pagos a proveedor (OC), oculta para cobros a cliente (OV, que no tiene
// proveedor).
function _pagoToggleInfoProveedor(show) {
  const wrapTitle = document.getElementById('pago-prov-title-wrap');
  const wrapCta   = document.getElementById('pago-prov-cuenta-wrap');
  if (wrapTitle) wrapTitle.style.display = show ? '' : 'none';
  if (wrapCta)   wrapCta.style.display   = show ? '' : 'none';
}

// Pagos sin aplicar del proveedor de esta factura — visibilidad directa
// dentro del modal de "Registrar Pago", para poder usar un pago ya
// existente (ej. de una factura que se canceló y se desasignó) en vez de
// crear uno nuevo. "Usar este pago" cierra el modal de registrar pago y
// aplica directo vía asignarPagoOC() — mismo mecanismo que el módulo Pagos.
function _pagoSinAplicarProveedor(proveedorId, facturaId) {
  const wrap = document.getElementById('pago-sinaplicar-wrap');
  const list = document.getElementById('pago-sinaplicar-list');
  if (!wrap || !list) return;
  const disponibles = (state.pagosOC||[]).filter(p => !p.factura_id && p.proveedor_id === proveedorId);
  if (!disponibles.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  list.innerHTML = disponibles.map(p => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:7px;background:#FFFBEB;border:1px solid #FDE68A;margin-bottom:6px;font-size:12px">
      <div>
        ${p.num_pago?`<span style="font-family:'DM Mono',monospace;font-size:11px;font-weight:700;color:var(--accent);margin-right:8px">${p.num_pago}</span>`:''}
        <span style="font-weight:500">${fmtDate(p.fecha)}</span>
        <span style="color:var(--text2);margin:0 8px">·</span>
        <span>${p.forma||'—'}</span>
        <strong style="font-family:'DM Mono',monospace;color:var(--green);margin-left:10px">${fmtMoney(p.monto, p.moneda||'GTQ')}</strong>
      </div>
      <button class="btn btn-sm btn-primary" onclick="closeModal('modal-pago');asignarPagoOC('${p.id}','${facturaId}')">Usar este pago</button>
    </div>`).join('');
}

function _pagoHistorial(facturaId) {
  const pagos = (state.pagosOC||[]).filter(p=>p.factura_id===facturaId);
  const wrap  = document.getElementById('pago-historial-wrap');
  const hist  = document.getElementById('pago-historial');
  if (pagos.length) {
    wrap.style.display = 'block';
    hist.innerHTML = pagos.map(p => {
      const cta = (state.nomenclatura||[]).find(n=>n.id===p.cuenta_id);
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:7px;background:var(--surface2);margin-bottom:6px;font-size:12px">
        <div>
          ${p.num_pago?`<span style="font-family:'DM Mono',monospace;font-size:11px;font-weight:700;color:var(--accent);margin-right:8px">${p.num_pago}</span>`:''}
          <span style="font-weight:500">${fmtDate(p.fecha)}</span>
          <span style="color:var(--text2);margin:0 8px">·</span>
          <span>${p.metodo||p.forma||'—'}</span>
          <span style="color:var(--text2);margin:0 8px">·</span>
          <span>${cta?.codigo?cta.codigo+' '+cta.nombre:p.notas||'—'}</span>
          ${p.referencia?`<span style="color:var(--text3);margin-left:8px;font-family:'DM Mono',monospace;font-size:11px">${p.referencia}</span>`:''}
        </div>
        <strong style="font-family:'DM Mono',monospace;color:var(--green)">${fmtGTQ(p.monto)}</strong>
      </div>`;
    }).join('');
  } else { wrap.style.display = 'none'; }
}

// Single factura payment
async function openPagoOC(facturaId) {
  const f      = state.ocFacturas.find(x=>x.id===facturaId);
  if (!f) return;
  // Última línea de defensa (30/Ago/2026): los botones y selectores ya
  // excluyen las canceladas, pero si se llega acá desde un panel
  // desactualizado o desde consola, no se puede pagar una factura anulada.
  if (f.status === 'cancelada') {
    toast(`La factura ${f.num_interno||f.numero||''} está cancelada — no se puede pagar.`,'error');
    return;
  }
  const oc     = state.oc.find(o=>o.id===f.oc_id);
  const prov   = state.proveedores.find(p=>p.id===oc?.proveedor_id);
  const pagos  = (state.pagosOC||[]).filter(p=>p.factura_id===facturaId);
  const pagado = pagos.reduce((s,p)=>s+Number(p.monto||0),0);
  const total  = Number(f.total||0);
  const pend   = Math.max(0, total - pagado);
  const monedaOC = getMonedaOC(oc?.id);

  const _numPago = await nextNumPago();
  document.getElementById('pago-num-correlativo').textContent = _numPago;
  document.getElementById('pago-factura-id').dataset.numPago = _numPago;
  document.getElementById('pago-modo').value       = 'single';
  document.getElementById('pago-factura-id').value = facturaId;
  document.getElementById('pago-factura-id').dataset.tipo = 'OC';
  document.getElementById('pago-proveedor-id').value = prov?.id||'';
  document.getElementById('modal-pago-title').textContent = 'Registrar Pago';
  document.getElementById('pago-fact-info').textContent =
    `${f.serie||''}${f.numero||''} — ${prov?.name||''} | ${oc?.numero||''}`;
  document.getElementById('pago-fact-total').textContent    = fmtMoney(total, monedaOC);
  document.getElementById('pago-fact-pagado').textContent   = fmtMoney(pagado, monedaOC);
  document.getElementById('pago-fact-pendiente').textContent = fmtMoney(pend, monedaOC);
  document.getElementById('pago-fecha').value      = today();
  document.getElementById('pago-forma').value      = '';
  document.getElementById('pago-monto').value      = pend > 0 ? pend.toFixed(2) : '';
  document.getElementById('pago-referencia').value = '';
  document.getElementById('pago-notas').value      = '';
  // Retención ISR — automática, editable. Solo se muestra el campo si el
  // proveedor está en Régimen Opcional Simplificado y la factura quedó
  // marcada "Sujeto a Retención ISR" al generarse.
  const retIsr = retencionISRFactura(facturaId);
  const retIsrWrap  = document.getElementById('pago-retencion-isr-wrap');
  const retIsrInput = document.getElementById('pago-retencion-isr');
  if (retIsrWrap && retIsrInput) {
    retIsrWrap.style.display = retIsr > 0 ? '' : 'none';
    retIsrInput.value = retIsr > 0 ? retIsr.toFixed(2) : '';
  }
  _pagoSetMoneda(monedaOC);
  _pagoSetCuentaOrigen(monedaOC);
  document.getElementById('pago-cuenta').innerHTML = _pagoCtaOptsProveedor(prov?.id);
  _pagoToggleInfoProveedor(true);
  document.getElementById('pago-distribucion-wrap').style.display = 'none';
  _pagoSinAplicarProveedor(prov?.id, facturaId);
  _pagoHistorial(facturaId);
  pagoTab('info');
  openModal('modal-pago');
}

// Multi-factura payment — all pending facturas for a proveedor
function openPagoProveedor(ocId) {
  const oc   = state.oc.find(o=>o.id===ocId);
  if (!oc) return;
  const prov = state.proveedores.find(p=>p.id===oc.proveedor_id);
  // Modo multi: la retención (si aplica) se calcula automáticamente por
  // factura dentro de buildLineasPago() — no hay un único campo editable
  // porque cada factura puede tener su propia retención.
  const retIsrWrapMulti = document.getElementById('pago-retencion-isr-wrap');
  if (retIsrWrapMulti) retIsrWrapMulti.style.display = 'none';

  // Get ALL pending facturas for this proveedor
  const provOCs    = (state.oc||[]).filter(o=>o.proveedor_id===oc.proveedor_id);
  const provOCIds  = provOCs.map(o=>o.id);
  const facturasP  = (state.ocFacturas||[])
    .filter(f => provOCIds.includes(f.oc_id))
    .sort((a,b)=>new Date(a.fecha)-new Date(b.fecha));

  const facturasPendientes = facturasP.filter(f => {
    // Las canceladas no son pagables (30/Ago/2026). Sin este filtro aparecían
    // en el selector de facturas a pagar como si siguieran vigentes.
    if (f.status === 'cancelada') return false;
    const pagado = (state.pagosOC||[]).filter(p=>p.factura_id===f.id).reduce((s,p)=>s+Number(p.monto||0),0);
    return Number(f.total||0) - pagado > 0;
  });

  if (!facturasPendientes.length) { toast('No hay facturas pendientes de pago','error'); return; }

  // Todas las facturas pendientes de este proveedor deben compartir moneda —
  // igual que el flujo de openPagoDesdeCompras(), no tiene sentido mezclar
  // facturas USD y GTQ en un solo pago/asiento.
  const monedasProv = [...new Set(facturasPendientes.map(f => getMonedaOC(f.oc_id)))];
  if (monedasProv.length > 1) {
    toast('Este proveedor tiene facturas pendientes en distintas monedas — regístralas por separado desde el Libro de Compras','error');
    return;
  }
  const monedaProv = monedasProv[0]||'GTQ';

  document.getElementById('pago-modo').value        = 'multi';
  document.getElementById('pago-factura-id').value  = '';
  document.getElementById('pago-factura-id').dataset.tipo = 'OC';
  document.getElementById('pago-proveedor-id').value = prov?.id||'';
  document.getElementById('modal-pago-title').textContent = 'Registrar Pago — Múltiples Facturas';
  document.getElementById('pago-fact-info').textContent   = prov?.name||'';
  // El widget de "pagos sin aplicar" solo aplica a UNA factura a la vez
  // (single-mode) — en multi-factura se oculta para no confundir.
  document.getElementById('pago-sinaplicar-wrap').style.display = 'none';
  const totalPend = facturasPendientes.reduce((s,f) => {
    const pagado = (state.pagosOC||[]).filter(p=>p.factura_id===f.id).reduce((ss,p)=>ss+Number(p.monto||0),0);
    return s + Math.max(0, Number(f.total||0)-pagado);
  },0);
  document.getElementById('pago-fact-total').textContent    = `${facturasPendientes.length} facturas`;
  document.getElementById('pago-fact-pagado').textContent   = '—';
  document.getElementById('pago-fact-pendiente').textContent = fmtMoney(totalPend, monedaProv);
  document.getElementById('pago-fecha').value       = today();
  document.getElementById('pago-forma').value       = '';
  document.getElementById('pago-monto').value       = '';
  document.getElementById('pago-referencia').value  = '';
  document.getElementById('pago-notas').value       = '';
  _pagoSetMoneda(monedaProv);
  _pagoSetCuentaOrigen(monedaProv);
  document.getElementById('pago-cuenta').innerHTML  = _pagoCtaOptsProveedor(oc?.proveedor_id);
  _pagoToggleInfoProveedor(true);
  document.getElementById('pago-historial-wrap').style.display = 'none';

  // Render distribution table
  document.getElementById('pago-distribucion-wrap').style.display = 'block';
  document.getElementById('pago-dist-tbody').innerHTML = facturasPendientes.map(f => {
    const pagado = (state.pagosOC||[]).filter(p=>p.factura_id===f.id).reduce((s,p)=>s+Number(p.monto||0),0);
    const saldo  = Math.max(0, Number(f.total||0) - pagado);
    const fOC    = provOCs.find(o=>o.id===f.oc_id);
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:7px 10px;font-family:'DM Mono',monospace;font-size:11px">
        ${f.serie||''}${f.numero||''}<br>
        <span style="color:var(--text3);font-size:10px">${fOC?.numero||''}</span>
      </td>
      <td style="padding:7px 10px;font-size:11px">${fmtDate(f.fecha)}</td>
      <td style="padding:7px 10px;text-align:right;font-family:'DM Mono',monospace">${fmtMoney(Number(f.total||0), monedaProv)}</td>
      <td style="padding:7px 10px;text-align:right;font-family:'DM Mono',monospace;color:var(--accent);font-weight:600">${fmtMoney(saldo, monedaProv)}</td>
      <td style="padding:7px 8px">
        <input type="number" step="0.01" min="0" max="${saldo.toFixed(2)}"
          id="dist-${f.id}" value="0.00" placeholder="0.00"
          data-saldo="${saldo.toFixed(2)}" data-factura="${f.id}"
          oninput="calcDistribucion()"
          style="padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:'DM Mono',monospace;font-size:12px;width:120px;text-align:right"/>
      </td>
    </tr>`;
  }).join('');

  pagoTab('info');
  openModal('modal-pago');
}

// ── PAGOS OC — savePago (index.html original: líneas 10761-10981) ──
// (COMPRAS — guarda pago a proveedor/OC. Su equivalente en Ventas es
// openPago/saveCobro más abajo, en la sección PAGOS.)
async function savePago() {
  try {
  const modo       = document.getElementById('pago-modo').value;
  const facturaId  = document.getElementById('pago-factura-id').value;
  const tipo       = document.getElementById('pago-factura-id').dataset.tipo;
  const fecha      = document.getElementById('pago-fecha').value;
  const metodo     = document.getElementById('pago-forma').value;
  // Cuenta de Origen = cuenta propia de la empresa — es la que se usa para el asiento contable real
  const cuenta_id  = document.getElementById('pago-cuenta-origen').value;
  // Cuenta Bancaria Proveedor = solo informativa (se anexa a las notas del pago)
  const cuenta_id_raw = document.getElementById('pago-cuenta').value;
  const cuentaEl   = document.getElementById('pago-cuenta');
  const selOpt     = cuentaEl.options[cuentaEl.selectedIndex];
  const bancoInfo  = cuenta_id_raw.startsWith('prov-')
    ? [selOpt?.dataset?.banco, selOpt?.dataset?.tipo, selOpt?.dataset?.num].filter(Boolean).join(' · ')
    : null;
  const monto      = parseFloat(document.getElementById('pago-monto').value);
  const referencia = document.getElementById('pago-referencia')?.value.trim()||'';
  const notas      = document.getElementById('pago-notas').value.trim();
  const provId     = document.getElementById('pago-proveedor-id').value;
  // Moneda real de la factura/OC que se está pagando (ver _pagoSetMoneda) —
  // el monto del formulario está en ESTA moneda, no siempre en GTQ.
  const moneda     = document.getElementById('pago-factura-id').dataset.moneda || 'GTQ';
  const esUSD      = moneda === 'USD';

  if (!fecha||!cuenta_id||!metodo||isNaN(monto)||monto<=0) {
    toast('Completa fecha, cuenta de origen, forma de pago y monto','error'); return;
  }

  if (modo === 'single') {
    // Validate factura is not fully paid
    const fCheck  = state.ocFacturas.find(x=>x.id===facturaId);
    const pagosCheck = (state.pagosOC||[]).filter(p=>p.factura_id===facturaId);
    const pagadoCheck = pagosCheck.reduce((s,p)=>s+Number(p.monto||0),0);
    if (fCheck && pagadoCheck >= Number(fCheck.total||0)) {
      toast('Esta factura ya está completamente pagada','error'); return;
    }
  }

  if (tipo === 'OC') {
    if (modo === 'single') {
      // Single factura payment
      const f    = state.ocFacturas.find(x=>x.id===facturaId);
      const oc   = state.oc.find(o=>o.id===f?.oc_id);
      const prov = state.proveedores.find(p=>p.id===document.getElementById('pago-proveedor-id').value);

      const num_pago = document.getElementById('pago-factura-id').dataset.numPago || await nextNumPago();
      // OJO: la columna real se llama "forma", no "metodo" — un desajuste de
      // nombre que hacía fallar CADA intento de guardar un pago (Supabase
      // rechaza inserts con columnas inexistentes).
      //
      // Pagos a proveedores (OC) se guardan en erp_pagos_oc, NO en erp_pagos
      // — son tablas separadas a propósito: erp_pagos_oc.factura_id apunta a
      // erp_oc_facturas, mientras que erp_pagos.factura_id apunta a
      // erp_invoices (ventas). Antes ambos flujos escribían en la misma
      // tabla erp_pagos, cuya llave foránea solo permitía valores de
      // erp_invoices — por eso CADA pago a proveedor fallaba con 409
      // (violación de llave foránea), aunque el pago fuera válido.
      const { data: pagoInsertado, error: ePago } = await sb.from('erp_pagos_oc').insert({
        factura_id: facturaId, proveedor_id: oc?.proveedor_id||null,
        fecha, forma: metodo, cuenta_id, monto, referencia, num_pago,
        notas: [notas, bancoInfo?`Banco: ${bancoInfo}`:''].filter(Boolean).join(' | ') || null,
        moneda,
      }).select().single();
      if (ePago) { toast('Error guardando pago: '+ePago.message,'error'); return; }

      // Update factura estado
      await loadAll();
      const pagado = (state.pagosOC||[]).filter(p=>p.factura_id===facturaId).reduce((s,p)=>s+Number(p.monto||0),0);
      const estadoPago = pagado >= Number(f?.total||0) ? 'pagado' : 'parcial';
      await sb.from('erp_oc_facturas').update({ monto_pagado: pagado, estado_pago: estadoPago }).eq('id', facturaId);

      // Diferencial cambiario — si la factura es USD y el TC de hoy difiere
      // del TC vigente cuando se emitió la factura, la diferencia entre lo
      // que se registró en Cuentas x Pagar y lo que realmente se paga en GTQ
      // se registra como ganancia/pérdida cambiaria (mismo patrón que
      // asientoAnticipoOC).
      if (esUSD && f?.fecha) {
        const tcPago    = getTCFecha(fecha);
        const tcFactura = getTCFecha(f.fecha);
        if (Math.abs(tcPago - tcFactura) > 0.0001) {
          await asientoDiferencialCambiario({
            montoUSD: monto, tcOriginal: tcFactura, tcLiquidacion: tcPago, fecha,
            referencia: `Factura ${f?.serie||''}${f?.numero||''} — ${oc?.numero||''}`,
            referencia_id: pagoInsertado?.id||facturaId, tipo: 'pago',
          });
        }
      }

      // Accounting entry — mismas líneas que se mostraron en el tab "Información Contable".
      // moneda: la real de la factura/OC (no forzada a GTQ) — así crearAsiento()
      // calcula el equivalente en GTQ para el balance Y conserva el monto real
      // por línea (monto_orig/moneda_orig), necesario para poder conciliar la
      // cuenta bancaria de origen cuando está configurada en USD.
      //
      // referencia_id: pagoInsertado?.id — enlaza el asiento directamente con
      // la fila de erp_pagos_oc recién creada (antes se guardaba null, lo que
      // hacía imposible encontrar "los asientos de este pago" desde el
      // detalle de la Nota de Pago). Ver asientosDePago().
      await crearAsiento({
        diario:'BANCOS', fecha,
        descripcion: `Pago factura ${f?.serie||''}${f?.numero||''} — ${prov?.name||''} | ${metodo}${referencia?' Ref:'+referencia:''}`,
        referencia: referencia||`PAGO-${f?.serie||''}${f?.numero||''}`, referencia_id: pagoInsertado?.id||null, moneda,
        lineas: buildLineasPago(),
      });

      await loadAll();
      toast(estadoPago==='pagado' ? '✓ Factura pagada completamente' : `✓ Pago de ${fmtMoney(monto, moneda)} registrado`);
      closeModal('modal-pago');
    } else {
      // Multi-factura
      const distribs = [];
      document.querySelectorAll('#pago-dist-tbody input').forEach(el => {
        const v = parseFloat(el.value)||0;
        if (v > 0) distribs.push({ factura_id: el.dataset.factura, monto: v });
      });
      const totalDist = distribs.reduce((s,d)=>s+d.monto,0);
      if (Math.abs(totalDist - monto) > 0.01) {
        toast(`El total distribuido (${fmtMoney(totalDist, moneda)}) no coincide con el monto (${fmtMoney(monto, moneda)})`,'error'); return;
      }
      if (!distribs.length) { toast('Asigna al menos una factura','error'); return; }

      // Guarda cada pago individual por factura, CADA UNO con su propio
      // asiento (antes era un solo asiento combinado para todas las
      // distribuciones, con referencia_id null — eso hacía imposible
      // reversar/desasignar UNA sola factura del pago múltiple sin tocar
      // las demás). Comparten num_pago para poder agruparse visualmente,
      // pero cada fila de erp_pagos_oc y su asiento son independientes y
      // reversables por separado — mismo requisito que single-mode.
      const num_pago_multi = document.getElementById('pago-factura-id').dataset.numPago || await nextNumPago();
      const tcPagoMulti = esUSD ? getTCFecha(fecha) : 1;
      const ctaTransitoriaMulti = transitoriaNomenclatura(moneda, 'pago');
      const cuentaBancariaMulti = (state.cuentas||[]).find(c => c.id === cuenta_id);
      for (const d of distribs) {
        const f    = state.ocFacturas.find(x=>x.id===d.factura_id);
        const ocF  = state.oc.find(o=>o.id===f?.oc_id);
        const provF = state.proveedores.find(p=>p.id===ocF?.proveedor_id);
        // Pagos a proveedores (OC) van a erp_pagos_oc, no a erp_pagos (ver
        // nota en el modo single arriba). Antes este insert tampoco
        // revisaba si fallaba — seguía de largo marcando la factura como
        // pagada y generando el asiento contable aunque el pago nunca se
        // hubiera guardado. Ahora se detiene y avisa en el primer error.
        const { data: pagoMultiRow, error: ePagoMulti } = await sb.from('erp_pagos_oc').insert({
          factura_id: d.factura_id, proveedor_id: ocF?.proveedor_id||null,
          num_pago: num_pago_multi,
          fecha, forma: metodo, cuenta_id, monto: d.monto, referencia, notas, moneda,
        }).select().single();
        if (ePagoMulti) {
          toast(`Error guardando pago de factura ${f?.serie||''}${f?.numero||''}: ${ePagoMulti.message}`,'error');
          await loadAll();
          return;
        }
        // Update factura estado
        const pagosAnt = (state.pagosOC||[]).filter(p=>p.factura_id===d.factura_id);
        const totalPag = pagosAnt.reduce((s,p)=>s+Number(p.monto||0),0) + d.monto;
        const totalFac = Number(f?.total||0);
        const estadoPago = totalPag >= totalFac ? 'pagado' : 'parcial';
        await sb.from('erp_oc_facturas').update({ monto_pagado: totalPag, estado_pago: estadoPago }).eq('id', d.factura_id);

        const ctaPorPagarF = ctaPorPagarOC(f?.oc_id);
        const descCxP = [provF?.name, f?.serie, f?.numero].filter(Boolean).join(' - ');
        await crearAsiento({
          diario:'BANCOS', fecha,
          descripcion: `Pago factura ${f?.serie||''}${f?.numero||''} — ${provF?.name||''} | ${metodo}${referencia?' Ref:'+referencia:''} · Nota ${num_pago_multi}`,
          referencia: referencia||`PAGO-${f?.serie||''}${f?.numero||''}`, referencia_id: pagoMultiRow?.id||null, moneda,
          lineas: [
            { cuenta_id: ctaPorPagarF?.id||null, cuenta_codigo: ctaPorPagarF?.codigo||'CXP', cuenta_nombre: ctaPorPagarF?.nombre||'Cuentas x Pagar', debe: d.monto, haber: 0, descripcion: descCxP },
            { cuenta_id: ctaTransitoriaMulti?.id||null, cuenta_codigo: ctaTransitoriaMulti?.codigo||'PAGOS-PEND', cuenta_nombre: ctaTransitoriaMulti?.nombre||'Pagos Pendientes', debe: 0, haber: d.monto, descripcion: `Pendiente de confirmar — ${cuentaBancariaMulti?.name||''}` },
          ],
        });

        // Diferencial cambiario por factura (cada una puede tener su propia
        // fecha/TC de emisión, aunque compartan moneda) — referencia_id
        // apunta al pago de ESTA factura, no a la factura misma, para poder
        // encontrarlo y reversarlo al desasignar solo esta aplicación.
        if (esUSD && f?.fecha) {
          const tcFactura = getTCFecha(f.fecha);
          if (Math.abs(tcPagoMulti - tcFactura) > 0.0001) {
            await asientoDiferencialCambiario({
              montoUSD: d.monto, tcOriginal: tcFactura, tcLiquidacion: tcPagoMulti, fecha,
              referencia: `Factura ${f?.serie||''}${f?.numero||''} — ${ocF?.numero||''}`,
              referencia_id: pagoMultiRow?.id||d.factura_id, tipo: 'pago',
            });
          }
        }
      }

      await loadAll();
      toast(`✓ Pago registrado — ${distribs.length} facturas, ${fmtMoney(monto, moneda)}`);
      closeModal('modal-pago');
    }
  } else {
    // OV pago — ahora también contabiliza (Cobros Pendientes / Cuentas x
    // Cobrar + diferencial cambiario si aplica), vía asientoPagoVenta().
    // Antes este branch solo insertaba erp_pagos sin generar ningún
    // asiento, aunque asientoPagoVenta() ya existía en el código como
    // "hook" preparado y nunca conectado — ver registrarPagoConAsiento().
    const fCli = state.facturas.find(x=>x.id===facturaId);
    const {data: pagoVenta, error} = await sb.from('erp_pagos').insert({
      factura_id: facturaId, cliente_id: fCli?.customer_id||null,
      fecha, forma: metodo, cuenta_id, monto, referencia, notas,
    }).select().single();
    if (error) { toast('Error: '+error.message,'error'); return; }
    await loadAll();
    await asientoPagoVenta(pagoVenta.id);
    await loadAll();
    const f      = state.facturas.find(x=>x.id===facturaId);
    const pagado = totalPagado(facturaId);
    if (pagado >= Number(f.total)) {
      await sb.from('erp_invoices').update({status:'pagada'}).eq('id',facturaId);
      await loadAll(); await syncOrderStatus(f?.order_id); await loadAll();
      toast('¡Factura pagada completamente!');
    } else { toast('Pago registrado'); }
    closeModal('modal-pago');
  }
  } catch(e) {
    alert('Error en savePago:\n' + e.message + '\n\n' + e.stack?.substring(0,300));
  }
}

// ── PROVEEDORES (CRUD completo) (index.html original: líneas 11549-11756) ──
// ═══ PROVEEDORES ═══
function renderProveedores() {
  const q = (document.getElementById('search-proveedores')?.value||'').toLowerCase();
  const data = state.proveedores.filter(p =>
    (p.name||'').toLowerCase().includes(q) || (p.nit||'').toLowerCase().includes(q)
  );
  const tbody = document.getElementById('tbl-proveedores');
  if (!tbody) return;
  tbody.innerHTML = data.length ? data.map(p => `<tr>
    <td class="td-mono">${p.nit||'—'}</td>
    <td style="font-weight:500" onclick="editProveedor('${p.id}')">
      <div style="color:var(--accent)">${p.name}</div>
      ${p.address?`<div style="font-size:11px;color:var(--text3)">${p.address}</div>`:''}
    </td>
    <td class="hide-mobile" style="font-size:12px">
      ${p.fact_nombre?`<div style="font-weight:500">${p.fact_nombre}</div>`:''}
      ${p.fact_email?`<div style="color:var(--text3);font-size:11px">${p.fact_email}</div>`:''}
      ${!p.fact_nombre && !p.fact_email ? '—' : ''}
    </td>
    <td class="hide-mobile" style="font-size:12px">${p.phone||p.fact_tel||'—'}</td>
    <td class="hide-mobile" style="font-size:12px;color:var(--text2)">${p.email||'—'}</td>
    <td><div class="td-actions">
      <button class="btn btn-sm btn-danger" onclick="deleteProveedor('${p.id}')">Eliminar</button>
    </div></td>
  </tr>`).join('') :
  '<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◎</div><p>Sin proveedores registrados</p></div></td></tr>';
}

function provTab(tab) {
  ['general','contab','produccion','otros'].forEach(t => {
    document.getElementById(`prov-panel-${t}`).style.visibility = t===tab ? 'visible' : 'hidden';
    const btn = document.getElementById(`prov-tab-${t}`);
    btn.style.background   = t===tab ? 'var(--bg)' : 'transparent';
    btn.style.color        = t===tab ? 'var(--accent)' : 'var(--text3)';
    btn.style.borderBottom = t===tab ? '2px solid var(--accent)' : 'none';
  });
}

function openNewProveedor() {
  document.getElementById('prov-id').value = '';
  ['prov-id','prov-nit','prov-name','prov-address','prov-address2','prov-estado','prov-pais','prov-fact-nombre','prov-fact-email','prov-fact-tel','prov-prod-nombre','prov-prod-email','prov-prod-tel','prov-phone','prov-email','prov-notes'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('prov-pais').value = 'GT';
  document.getElementById('prov-moneda').value  = 'GTQ';
  document.getElementById('prov-moneda2').value = '';
  document.getElementById('prov-regimen-isr').value = 'general';
  document.getElementById('prov-incoterms').innerHTML = incotermsOpts();
  document.getElementById('prov-terminos').innerHTML  = terminosPagoOpts();
  provTab('general');
  document.getElementById('prov-bodega-pred').innerHTML = '<option value="">— Seleccionar bodega —</option>' + (state.bodegas||[]).filter(b=>b.activa!==false).map(b=>`<option value="${b.id}">${(b.codigo?b.codigo+' — ':'')+b.nombre}</option>`).join('');
  document.getElementById('prov-banco').value          = '';
  document.getElementById('prov-tipo-cuenta').value   = '';
  document.getElementById('prov-num-cuenta').value    = '';
  document.getElementById('prov-pl-configurado').checked      = false;
  document.getElementById('prov-factura-configurada').checked = false;
  document.getElementById('prov-banco').value      = '';
  document.getElementById('prov-tipo-cuenta').value = '';
  document.getElementById('prov-num-cuenta').value  = '';
  onProvMonedaChange();
  document.getElementById('modal-proveedor-title').textContent = 'Nuevo Proveedor';
  openModal('modal-proveedor');
}

function editProveedor(id) {
  const p = state.proveedores.find(x => x.id === id);
  if (!p) return;
  document.getElementById('prov-id').value       = p.id;
  document.getElementById('prov-nit').value      = p.nit||'';
  document.getElementById('prov-name').value     = p.name||'';
  document.getElementById('prov-address').value     = p.address||'';
  document.getElementById('prov-address2').value    = p.address2||'';
  document.getElementById('prov-estado').value      = p.estado||'';
  document.getElementById('prov-pais').value        = p.pais||'Guatemala';
  document.getElementById('prov-fact-nombre').value = p.fact_nombre||'';
  document.getElementById('prov-fact-email').value  = p.fact_email||'';
  document.getElementById('prov-fact-tel').value    = p.fact_tel||'';
  document.getElementById('prov-prod-nombre').value = p.prod_nombre||'';
  document.getElementById('prov-prod-email').value  = p.prod_email||'';
  document.getElementById('prov-prod-tel').value    = p.prod_tel||'';
  document.getElementById('prov-phone').value    = p.phone||'';
  document.getElementById('prov-email').value    = p.email||'';
  document.getElementById('prov-notes').value    = p.notes||'';
  document.getElementById('prov-incoterms').innerHTML = incotermsOpts(p.incoterms_default||'');
  document.getElementById('prov-terminos').innerHTML  = terminosPagoOpts(p.terminos_pago||'');
  provTab('general');
  provTab('general');
  document.getElementById('prov-bodega-pred').innerHTML = '<option value="">— Seleccionar bodega —</option>' + (state.bodegas||[]).filter(b=>b.activa!==false).map(b=>`<option value="${b.id}"${b.id===p.bodega_id?' selected':''}>` + (b.codigo?b.codigo+' — ':'') + b.nombre + '</option>').join('');
  document.getElementById('prov-banco').value          = p.banco||'';
  document.getElementById('prov-tipo-cuenta').value   = p.tipo_cuenta||'';
  document.getElementById('prov-num-cuenta').value    = p.num_cuenta||'';
  document.getElementById('prov-pl-configurado').checked      = p.pl_configurado      || false;
  document.getElementById('prov-factura-configurada').checked = p.factura_configurada || false;
  document.getElementById('prov-banco').value      = p.banco||'';
  document.getElementById('prov-tipo-cuenta').value = p.tipo_cuenta||'';
  document.getElementById('prov-num-cuenta').value  = p.num_cuenta||'';
  document.getElementById('prov-moneda').value   = p.moneda||'GTQ';
  document.getElementById('prov-moneda2').value  = p.moneda2||'';
  document.getElementById('prov-regimen-isr').value = p.regimen_isr||'general';
  onProvMonedaChange();
  if (p.moneda2) document.getElementById('prov-moneda2').value = p.moneda2;
  document.getElementById('modal-proveedor-title').textContent = 'Editar Proveedor';
  openModal('modal-proveedor');
}

// Get moneda for an OC item — from producto.proveedores_compra[proveedor]
function getMonedaOCItem(productoId, proveedorId) {
  return resolveMoneda(proveedorId, productoId, 'compra').moneda;
}

// Get moneda for an entire OC — uses first item's moneda (all items should match)
function getMonedaOC(ocId) {
  const oc    = state.oc.find(o => o.id === ocId);
  const items = state.ocItems.filter(i => i.oc_id === ocId);
  if (!items.length) return 'GTQ';
  const first = items[0];
  return getMonedaOCItem(first.producto_id, oc?.proveedor_id);
}
// ── País onchange — hace NIT opcional para extranjeros ──────────
function onProvPaisChange() {
  const pais    = document.getElementById('prov-pais').value;
  const esLocal = !pais || pais === 'GT';
  const label   = document.getElementById('prov-nit-label');
  const input   = document.getElementById('prov-nit');
  if (label) label.textContent = esLocal ? 'NIT *' : 'Tax ID / NIT (opcional)';
  if (input) input.placeholder = esLocal ? '1234567-8' : 'Tax ID del extranjero (opcional)';
}

function onProvMonedaChange() {
  const principal = document.getElementById('prov-moneda').value;
  const sel2      = document.getElementById('prov-moneda2');
  const current2  = sel2.value;
  sel2.innerHTML  = '<option value="">— Solo moneda principal —</option>' +
    ['GTQ','USD'].filter(m => m !== principal)
      .map(m => `<option value="${m}">${m === 'GTQ' ? 'GTQ — Quetzal' : 'USD — Dólar'}</option>`).join('');
  if (current2 && current2 !== principal) sel2.value = current2;
}

async function saveProveedor() {
  try {
    const id   = document.getElementById('prov-id').value;
    const nit   = document.getElementById('prov-nit').value.trim();
    const name  = document.getElementById('prov-name').value.trim();
    const pais  = document.getElementById('prov-pais').value;
    const esLocal = !pais || pais === 'GT';
    if (esLocal && !nit) { toast('NIT es requerido para proveedores de Guatemala','error'); return; }
    if (!name) { toast('El nombre es requerido','error'); return; }

    // NIT uniqueness check (solo si tiene NIT)
    if (nit) {
      const duplicate = state.proveedores.find(p => p.nit === nit && p.id !== id);
      if (duplicate) {
        toast(`Ya existe un proveedor con NIT ${nit}: "${duplicate.name}"`, 'error');
        return;
      }
    }

    const moneda  = document.getElementById('prov-moneda').value;
    const moneda2 = document.getElementById('prov-moneda2').value;
    const row = {
      nit, name, moneda,
      moneda2:      moneda2 || null,
      regimen_isr:  document.getElementById('prov-regimen-isr')?.value || 'general',
      address:      document.getElementById('prov-address').value.trim(),
      address2:     document.getElementById('prov-address2').value.trim(),
      estado:       document.getElementById('prov-estado').value.trim(),
      pais:         document.getElementById('prov-pais').value.trim(),
      fact_nombre:  document.getElementById('prov-fact-nombre').value.trim(),
      fact_email:   document.getElementById('prov-fact-email').value.trim(),
      fact_tel:     document.getElementById('prov-fact-tel').value.trim(),
      prod_nombre:  document.getElementById('prov-prod-nombre').value.trim(),
      prod_email:   document.getElementById('prov-prod-email').value.trim(),
      prod_tel:     document.getElementById('prov-prod-tel').value.trim(),
      phone:        document.getElementById('prov-phone').value.trim(),
      email:        document.getElementById('prov-email').value.trim(),
      notes:             document.getElementById('prov-notes').value.trim(),
      incoterms_default:    document.getElementById('prov-incoterms')?.value||null,
      terminos_pago:        document.getElementById('prov-terminos')?.value||null,
      bodega_id:           document.getElementById('prov-bodega-pred')?.value||null,
      banco:               document.getElementById('prov-banco')?.value.trim()||null,
      tipo_cuenta:         document.getElementById('prov-tipo-cuenta')?.value||null,
      num_cuenta:          document.getElementById('prov-num-cuenta')?.value.trim()||null,
      pl_configurado:       document.getElementById('prov-pl-configurado')?.checked||false,
      factura_configurada:  document.getElementById('prov-factura-configurada')?.checked||false,
      banco:                document.getElementById('prov-banco')?.value.trim()||null,
      tipo_cuenta:          document.getElementById('prov-tipo-cuenta')?.value||null,
      num_cuenta:           document.getElementById('prov-num-cuenta')?.value.trim()||null,
    };
    let err;
    if (id) ({ error:err } = await sb.from('erp_proveedores').update(row).eq('id',id));
    else    ({ error:err } = await sb.from('erp_proveedores').insert(row));
    if (err) {
      alert('Error al guardar proveedor:\n\n' + err.message + '\nCode: ' + (err.code||'') + '\nDetails: ' + (err.details||''));
      return;
    }
    toast('✓ Proveedor guardado');
    closeModal('modal-proveedor');
    await loadAll();
  } catch(e) {
    alert('Error inesperado en saveProveedor:\n\n' + e.message + '\n\n' + e.stack);
  }
}

async function deleteProveedor(id) {
  if (!confirm('¿Eliminar este proveedor?')) return;
  const {error} = await sb.from('erp_proveedores').delete().eq('id',id);
  if (error) { toast('Error: '+error.message,'error'); return; }
  toast('Proveedor eliminado');
  await loadAll();
}

// ── LIBRO DE COMPRAS (index.html original: líneas 15093-15502) ──
// ═══ LIBRO DE COMPRAS ═══
// IVA_RATE vive ahora en js/constantes.js

function calcCompraIVA() {
  const neto  = parseFloat(document.getElementById('cmp-neto').value)||0;
  const iva   = neto * IVA_RATE;
  const total = neto + iva;
  document.getElementById('cmp-iva-display').textContent  = fmtMoney(iva);
  document.getElementById('cmp-iva').value                = iva.toFixed(2);
  document.getElementById('cmp-total-display').textContent = fmtMoney(total);
  document.getElementById('cmp-total').value              = total.toFixed(2);
}

function onCompraProveedorChange() {
  const id   = document.getElementById('cmp-proveedor').value;
  const prov = state.proveedores.find(p => p.id === id);
  document.getElementById('cmp-nit-display').textContent = prov?.nit || '—';
}

function populateCompraProveedorSelect(selectedId='') {
  const opts = state.proveedores.map(p =>
    `<option value="${p.id}">${p.name}${p.nit?' · NIT: '+p.nit:''}</option>`
  ).join('');
  const sel = document.getElementById('cmp-proveedor');
  sel.innerHTML = '<option value="">— Seleccionar proveedor —</option>' + opts;
  if (selectedId) sel.value = selectedId;
  onCompraProveedorChange();
}

function populateCompraOCSelect(ocId='') {
  const sel = document.getElementById('cmp-oc-id');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Sin OC relacionada —</option>' +
    (state.oc||[])
      .filter(o => o.status !== 'cancelada' && o.numero) // las OC en borrador (sin número aún) no aplican para facturar
      .sort((a,b) => (b.numero||'').localeCompare(a.numero||''))
      .map(o => {
        const prov = state.proveedores.find(p=>p.id===o.proveedor_id);
        return `<option value="${o.id}">${o.numero} — ${prov?.name||'?'}</option>`;
      }).join('');
  if (ocId) sel.value = ocId;
}

// Recalcula la fecha de vencimiento sugerida (fecha + dias_credito de la OC)
// cada vez que cambia la OC ligada o la fecha del documento. Solo autocompleta
// si el campo está vacío o si el valor actual coincide con un cálculo previo
// (guardado en data-auto) — así no pisa una fecha que el usuario ya editó
// a mano, igual que el flujo de "Generar Factura" desde la OC.
function _recalcCompraVencimientoSugerido() {
  const ocId  = document.getElementById('cmp-oc-id')?.value;
  const fecha = document.getElementById('cmp-fecha')?.value;
  const vencInput = document.getElementById('cmp-fecha-vencimiento');
  const hint      = document.getElementById('cmp-venc-hint');
  if (!vencInput) return;
  const oc = ocId ? (state.oc||[]).find(x=>x.id===ocId) : null;
  const dias = oc?.dias_credito ?? null;
  if (!oc || !dias || !fecha) {
    if (hint) hint.textContent = '';
    return;
  }
  const d = new Date(fecha); d.setDate(d.getDate()+Number(dias));
  const sugerido = d.toISOString().split('T')[0];
  const wasAuto = !vencInput.value || vencInput.value === vencInput.dataset.auto;
  if (wasAuto) {
    vencInput.value = sugerido;
    vencInput.dataset.auto = sugerido;
  }
  if (hint) hint.textContent = `Sugerido según ${dias} días de crédito de la OC (editable)`;
}

function onCompraFechaChange() {
  _recalcCompraVencimientoSugerido();
}

function onCompraOCChange() {
  const ocId = document.getElementById('cmp-oc-id')?.value;
  if (!ocId) { _recalcCompraVencimientoSugerido(); return; }
  const oc   = (state.oc||[]).find(x=>x.id===ocId);
  if (!oc) return;
  // Auto-fill proveedor from OC
  const pvSel = document.getElementById('cmp-proveedor');
  if (pvSel && oc.proveedor_id) {
    pvSel.value = oc.proveedor_id;
    onCompraProveedorChange();
  }
  _recalcCompraVencimientoSugerido();
}

function openNewCompra() {
  document.getElementById('cmp-id').value    = '';
  document.getElementById('cmp-fecha').value = today();
  document.getElementById('cmp-tipo').value  = '';
  document.getElementById('cmp-serie').value = '';
  document.getElementById('cmp-numero').value= '';
  document.getElementById('cmp-neto').value  = '';
  document.getElementById('cmp-iva').value   = '';
  document.getElementById('cmp-total').value = '';
  document.getElementById('cmp-notas').value = '';
  document.getElementById('cmp-iva-display').textContent   = '$0.00';
  document.getElementById('cmp-total-display').textContent = '$0.00';
  document.getElementById('cmp-nit-display').textContent   = '—';
  const vencInput = document.getElementById('cmp-fecha-vencimiento');
  if (vencInput) { vencInput.value = ''; vencInput.dataset.auto = ''; }
  const vencHint = document.getElementById('cmp-venc-hint');
  if (vencHint) vencHint.textContent = '';
  document.getElementById('modal-compra-title').textContent = 'Nuevo Registro de Compra';
  populateCompraProveedorSelect();
  populateCompraOCSelect();
  openModal('modal-compra');
}

function editCompra(id) {
  const c = state.compras.find(x => x.id === id);
  document.getElementById('cmp-id').value    = c.id;
  document.getElementById('cmp-fecha').value = c.fecha||'';
  document.getElementById('cmp-tipo').value  = c.tipo||'';
  document.getElementById('cmp-serie').value = c.serie||'';
  document.getElementById('cmp-numero').value= c.numero||'';
  document.getElementById('cmp-neto').value  = c.valor_neto||'';
  document.getElementById('cmp-notas').value = c.notas||'';
  // Si ya hay una fila espejo en erp_oc_facturas (factura_id), su
  // fecha_vencimiento es la fuente real — precargarla aquí.
  const focVinculada = c.factura_id ? (state.ocFacturas||[]).find(f=>f.id===c.factura_id) : null;
  const vencInput = document.getElementById('cmp-fecha-vencimiento');
  if (vencInput) { vencInput.value = focVinculada?.fecha_vencimiento || ''; vencInput.dataset.auto = ''; }
  const vencHint = document.getElementById('cmp-venc-hint');
  if (vencHint) vencHint.textContent = '';
  document.getElementById('modal-compra-title').textContent = 'Editar Registro';
  populateCompraProveedorSelect(c.proveedor_id||'');
  populateCompraOCSelect(c.oc_id||'');
  calcCompraIVA();
  openModal('modal-compra');
}

async function saveCompra() {
  const id         = document.getElementById('cmp-id').value;
  const fecha      = document.getElementById('cmp-fecha').value;
  const tipo       = document.getElementById('cmp-tipo').value;
  const numero     = document.getElementById('cmp-numero').value.trim();
  const provId     = document.getElementById('cmp-proveedor').value;
  const valor_neto = parseFloat(document.getElementById('cmp-neto').value);
  if (!fecha || !tipo || !numero || !provId || isNaN(valor_neto)) {
    toast('Fecha, tipo, número, proveedor y valor neto son requeridos','error'); return;
  }
  const valor_iva   = parseFloat(document.getElementById('cmp-iva').value)||0;
  const valor_total = parseFloat(document.getElementById('cmp-total').value)||0;
  const oc_id       = document.getElementById('cmp-oc-id')?.value || null;
  const serie       = document.getElementById('cmp-serie').value.trim();
  const notas       = document.getElementById('cmp-notas').value.trim();
  const fecha_vencimiento = document.getElementById('cmp-fecha-vencimiento')?.value || null;

  const existing   = id ? state.compras.find(x=>x.id===id) : null;
  let factura_id   = existing?.factura_id || null;

  // Si hay una OC ligada, mantener sincronizada la fila espejo en
  // erp_oc_facturas — es la única fuente que lee la proyección de Flujo de
  // Caja (por fecha_vencimiento) y el seguimiento de pagos/saldo. Antes,
  // una factura cargada desde este modal (Libro de Compras → Nuevo Registro
  // de Compra) nunca creaba esta fila, así que quedaba invisible para esos
  // dos reportes aunque sí apareciera en el Libro de Compras.
  if (oc_id) {
    const oc          = state.oc.find(o=>o.id===oc_id);
    const dias_credito = oc?.dias_credito ?? null;
    const vencCalc = fecha_vencimiento || (() => {
      if (!dias_credito) return null;
      const d = new Date(fecha); d.setDate(d.getDate()+Number(dias_credito));
      return d.toISOString().split('T')[0];
    })();
    const focRow = {
      oc_id, serie, numero, fecha,
      fecha_vencimiento: vencCalc,
      tipo, total: valor_total, notas,
      dias_credito,
    };
    if (factura_id) {
      const { error: eFocUpd } = await sb.from('erp_oc_facturas').update(focRow).eq('id', factura_id);
      if (eFocUpd) { toast('Error sincronizando factura de OC: '+eFocUpd.message,'error'); return; }
    } else {
      const { data: focArr, error: eFocIns } = await sb.from('erp_oc_facturas')
        .insert({ ...focRow, status:'pendiente', num_interno: nextFacturaInterna() }).select();
      if (eFocIns) { toast('Error creando factura de OC: '+eFocIns.message,'error'); return; }
      factura_id = focArr[0]?.id || null;
    }
  }

  const row = {
    fecha, tipo, serie, numero,
    proveedor_id: provId,
    valor_neto, valor_iva, valor_total,
    oc_id, factura_id, notas,
  };
  let err;
  if (id) { ({error:err} = await sb.from('erp_compras').update(row).eq('id',id)); }
  else     { ({error:err} = await sb.from('erp_compras').insert(row)); }
  if (err) { toast('Error: '+err.message,'error'); return; }
  toast('Registro guardado');
  closeModal('modal-compra');
  await loadAll();
}

async function deleteCompra(id) {
  if (!confirm('¿Eliminar este registro?')) return;
  const {error} = await sb.from('erp_compras').delete().eq('id',id);
  if (error) { toast('Error: '+error.message,'error'); return; }
  toast('Registro eliminado');
  await loadAll();
}

const TIPO_LABEL = { FC:'FC', NC:'NC', ND:'ND' };

function toggleAllCompras(el) {
  document.querySelectorAll('.compra-check').forEach(cb => {
    cb.checked = el.checked;
  });
  onCompraCheckChange();
}

function onCompraCheckChange() {
  const checked = document.querySelectorAll('.compra-check:checked');
  const btn     = document.getElementById('btn-pago-compras');
  const count   = document.getElementById('pago-compras-count');
  if (!btn) return;
  if (checked.length === 0) { btn.style.display = 'none'; return; }

  // Validate same proveedor and moneda
  const provIds  = [...new Set([...checked].map(c=>c.dataset.proveedor))];
  const monedas  = [...new Set([...checked].map(c=>c.dataset.moneda))];

  if (provIds.length > 1) {
    btn.style.background = '#FEF2F2'; btn.style.color = '#DC2626'; btn.style.borderColor = '#FECACA';
    btn.title = 'Las facturas deben ser del mismo proveedor';
  } else if (monedas.length > 1) {
    btn.style.background = '#FEF2F2'; btn.style.color = '#DC2626'; btn.style.borderColor = '#FECACA';
    btn.title = 'Las facturas deben ser de la misma moneda';
  } else {
    btn.style.background = '#EFF6FF'; btn.style.color = '#3B82F6'; btn.style.borderColor = '#BFDBFE';
    btn.title = '';
  }
  count.textContent = checked.length;
  btn.style.display = '';
}

async function openPagoDesdeCompras() {
  const checked = [...document.querySelectorAll('.compra-check:checked')];
  if (!checked.length) { toast('Selecciona al menos una factura','error'); return; }

  const provIds = [...new Set(checked.map(c=>c.dataset.proveedor).filter(Boolean))];
  const monedas = [...new Set(checked.map(c=>c.dataset.moneda||'GTQ'))];
  if (provIds.length > 1) { toast('Todas las facturas deben ser del mismo proveedor','error'); return; }
  if (monedas.length > 1) { toast('Todas las facturas deben ser de la misma moneda','error'); return; }

  const provId  = provIds[0]||'';
  const moneda  = monedas[0]||'GTQ';
  const prov    = state.proveedores.find(p=>p.id===provId);
  const totalPend = checked.reduce((s,c)=>s+parseFloat(c.dataset.saldo||0),0);

  const _numPago3 = await nextNumPago();
  document.getElementById('pago-num-correlativo').textContent = _numPago3;
  document.getElementById('pago-modo').value         = 'multi';
  const retIsrWrapMulti3 = document.getElementById('pago-retencion-isr-wrap');
  if (retIsrWrapMulti3) retIsrWrapMulti3.style.display = 'none';
  document.getElementById('pago-factura-id').value   = '';
  document.getElementById('pago-factura-id').dataset.tipo = 'OC';
  document.getElementById('pago-factura-id').dataset.numPago = _numPago3;
  document.getElementById('pago-proveedor-id').value = provId;
  document.getElementById('modal-pago-title').textContent = `Registrar Pago — ${prov?.name||'Proveedor'}`;
  document.getElementById('pago-fact-info').textContent   = `${prov?.name||'—'} · ${moneda} · ${checked.length} factura(s)`;
  document.getElementById('pago-fact-total').textContent    = `${checked.length} facturas`;
  document.getElementById('pago-fact-pagado').textContent   = '—';
  document.getElementById('pago-fact-pendiente').textContent = fmtMoney(totalPend, moneda);
  document.getElementById('pago-fecha').value        = today();
  document.getElementById('pago-forma').value        = '';
  document.getElementById('pago-monto').value        = totalPend.toFixed(2);
  document.getElementById('pago-referencia').value   = '';
  document.getElementById('pago-notas').value        = '';
  const _prov3 = state.proveedores.find(p=>p.id===provId);
  _pagoSetMoneda(moneda);
  _pagoSetCuentaOrigen(moneda);
  document.getElementById('pago-cuenta').innerHTML = _pagoCtaOptsProveedor(_prov3?.id);
  _pagoToggleInfoProveedor(true);
  document.getElementById('pago-historial-wrap').style.display   = 'none';
  document.getElementById('pago-distribucion-wrap').style.display = 'block';

  // Build distribution table
  let rows = '';
  checked.forEach((cb, idx) => {
    const compraId  = cb.dataset.id;
    const facturaId = cb.dataset.factura||'';
    const saldo     = parseFloat(cb.dataset.saldo||0);
    const c         = state.compras.find(x=>x.id===compraId);
    const oc        = c?.oc_id ? (state.oc||[]).find(o=>o.id===c.oc_id) : null;
    const distId    = facturaId ? `dist-${facturaId}` : `dist-c-${compraId}`;
    rows += `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:7px 10px;font-family:'DM Mono',monospace;font-size:11px">
        ${c?.serie||''}${c?.numero||''}<br>
        <span style="color:var(--text3);font-size:10px">${oc?.numero||''}</span>
      </td>
      <td style="padding:7px 10px;font-size:11px">${c?.fecha?fmtDate(c.fecha):'—'}</td>
      <td style="padding:7px 10px;text-align:right;font-family:'DM Mono',monospace">${fmtMoney(Number(c?.valor_total||0), c?.moneda||moneda)}</td>
      <td style="padding:7px 10px;text-align:right;font-family:'DM Mono',monospace;color:var(--accent);font-weight:600">${fmtMoney(saldo, c?.moneda||moneda)}</td>
      <td style="padding:7px 8px">
        <input type="number" step="0.01" min="0" max="${saldo.toFixed(2)}"
          id="${distId}" value="${saldo.toFixed(2)}"
          data-saldo="${saldo.toFixed(2)}"
          data-factura="${facturaId}"
          data-compra="${compraId}"
          oninput="calcDistribucion()"
          style="padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:'DM Mono',monospace;font-size:12px;width:120px;text-align:right"/>
      </td>
    </tr>`;
  });
  document.getElementById('pago-dist-tbody').innerHTML = rows;
  calcDistribucion();
  pagoTab('info');
  openModal('modal-pago');
}

function renderCompras() {
  const q   = (document.getElementById('search-compras')?.value||'').toLowerCase();
  const tp  = document.getElementById('filter-compras-tipo')?.value||'';
  const mes = document.getElementById('filter-compras-mes')?.value||'';

  let data = [...state.compras].sort((a,b) => new Date(a.fecha) - new Date(b.fecha));
  const estadoFilt = document.getElementById('filter-compras-estado')?.value||'';
  data = data.filter(c => {
    const prov    = state.proveedores.find(p => p.id === c.proveedor_id);
    const factura = c.factura_id ? state.ocFacturas.find(f=>f.id===c.factura_id) : null;
    const pagado  = factura ? (state.pagosOC||[]).filter(p=>p.factura_id===factura.id).reduce((s,p)=>s+Number(p.monto||0),0) : 0;
    const saldo   = factura ? Math.max(0, Number(factura.total||c.valor_total||0) - pagado) : Number(c.valor_total||0);
    const estadoC = factura?.status === 'cancelada' ? 'cancelada' : (saldo<=0?'pagado':pagado>0?'parcial':'pendiente');
    return (!tp  || c.tipo === tp) &&
           (!mes || (c.fecha||'').startsWith(mes)) &&
           (!estadoFilt || estadoC === estadoFilt) &&
           (!q   || (c.numero||'').toLowerCase().includes(q) ||
                    (prov?.name||'').toLowerCase().includes(q) ||
                    (prov?.nit||'').toLowerCase().includes(q));
  });

  let sumTotal = 0;
  const tbody = document.getElementById('tbl-compras');
  if (!tbody) return;

  tbody.innerHTML = data.length ? data.map(c => {
    const prov    = state.proveedores.find(p => p.id === c.proveedor_id);
    const oc      = c.oc_id ? (state.oc||[]).find(o=>o.id===c.oc_id) : null;
    const factura = c.factura_id ? state.ocFacturas.find(f=>f.id===c.factura_id) : null;
    const pagado  = factura ? (state.pagosOC||[]).filter(p=>p.factura_id===factura.id).reduce((s,p)=>s+Number(p.monto||0),0) : 0;
    const total   = Number(c.valor_total||0);
    const saldo   = factura ? Math.max(0, Number(factura.total||total) - pagado) : total;
    const esPagado = saldo <= 0.01;
    // El estado se lee de la columna propia del libro (30/Ago/2026) y, como
    // respaldo, del estado de la factura — así las filas anteriores a esa
    // columna siguen mostrándose bien.
    const esCancelada = c.estado === 'cancelada' || factura?.status === 'cancelada';
    const estadoColor = esCancelada ? 'badge-gray' : esPagado ? 'badge-green' : pagado>0 ? 'badge-yellow' : 'badge-blue';
    const estadoLabel = esCancelada ? 'Cancelada' : esPagado ? 'Pagada' : pagado>0 ? 'Parcialmente Pagada' : 'Generada';
    // Las canceladas se muestran (es un libro fiscal: la anulación debe
    // verse) pero NO suman a los totales ni al IVA crédito fiscal.
    if (!esCancelada) sumTotal += total;
    const fechaFmt = fmtDate(c.fecha);
    return `<tr id="compra-row-${c.id}">
      <td style="padding:8px 10px;text-align:center">
        ${!esPagado && !esCancelada?`<input type="checkbox" class="compra-check" data-id="${c.id}"
          data-proveedor="${c.proveedor_id||''}" data-moneda="${c.moneda||'GTQ'}"
          data-saldo="${saldo.toFixed(2)}" data-factura="${c.factura_id||''}"
          onclick="onCompraCheckChange()"
          style="width:15px;height:15px;cursor:pointer;accent-color:var(--accent)"/>`:''}
      </td>
      <td style="padding:8px 10px">
        ${c.factura_id
          ? `<span onclick="verFacturaOC('${c.factura_id}')"
              style="font-family:'DM Mono',monospace;font-size:12px;font-weight:700;color:var(--accent);cursor:pointer"
              title="Ver detalles de la factura">
              ${(state.ocFacturas||[]).find(f=>f.id===c.factura_id)?.num_interno||'—'}
            </span>`
          : `<span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--text3)">—</span>`
        }
      </td>
      <td style="white-space:nowrap">${fechaFmt}</td>
      <td><span class="badge badge-blue">${c.tipo||'—'}</span></td>
      <td class="td-mono">${c.serie||'—'}</td>
      <td class="td-mono">${c.numero||'—'}</td>
      <td class="td-mono" style="font-size:12px">${prov?.nit||'—'}</td>
      <td style="font-size:13px">${prov?.name||'—'}</td>
      <td class="td-mono hide-mobile" style="font-size:11px">${oc?`<span class="badge badge-gray">${oc.numero||'Borrador'}</span>`:'—'}</td>
      <td class="td-mono" style="text-align:right;font-weight:600">${fmtMoney(total, c.moneda||'GTQ')}</td>
      <td class="td-mono" style="text-align:right;color:${esPagado?'var(--text3)':'var(--accent)'};font-weight:${esPagado?'400':'700'}">
        ${esPagado?'✓':fmtMoney(saldo, c.moneda||'GTQ')}
      </td>
      <td class="td-mono" style="white-space:nowrap;font-size:12px">${factura?.fecha_vencimiento?fmtDate(factura.fecha_vencimiento):'—'}</td>
      <td><div class="td-actions">
        <span class="badge ${estadoColor}" style="font-size:10px">${estadoLabel}</span>
        ${!c.factura_id ? `
        <button class="btn btn-sm btn-ghost" onclick="editCompra('${c.id}')">Editar</button>
        <button class="btn btn-sm btn-danger" onclick="deleteCompra('${c.id}')">Eliminar</button>
        ` : ''}
      </div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="13"><div class="empty-state"><div class="empty-icon">▣</div><p>Sin registros de compra</p></div></td></tr>';

  // Totals row — colspan 9 covers checkbox..OC, then Total / Saldo / Vencimiento / Estado
  const tfoot = document.getElementById('tfoot-compras');
  if (tfoot) tfoot.innerHTML = data.length ? `<tr style="background:var(--surface2);font-weight:600">
    <td colspan="9" style="padding:10px 14px;font-size:12px;color:var(--text2)">TOTALES (${data.length} registro${data.length!==1?'s':''})</td>
    <td class="td-mono" style="text-align:right;padding:10px 14px">${fmtMoney(sumTotal)}</td>
    <td></td>
    <td></td>
    <td></td>
  </tr>` : '';
}

// ── OC — estado (currentOCId, currentVerFacturaOCId) + nextRecepcionNum (index.html original: líneas 16560-16575) ──
let currentOCId = null;
// Factura OC actualmente mostrada en el modal "modal-ver-factura-oc" — el
// botón "Imprimir Factura" del header (estático en el HTML, fuera del
// innerHTML que arma verFacturaOC()) lo necesita para saber cuál factura
// imprimir.
let currentVerFacturaOCId = null;

// ── Correlativos ──
async function nextRecepcionNum() {
  // REC-YYYY-NNNN, único en erp_oc_recepciones
  const year = new Date().getFullYear();
  const { data } = await sb.from('erp_oc_recepciones').select('numero').ilike('numero', `REC-${year}-%`);
  const nums = (data||[]).map(r => parseInt((r.numero||'').slice(-4))||0);
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `REC-${year}-${String(next).padStart(4,'0')}`;
}

// ── OC — helpers (provName, ocRecibidoQty, ocFacturadoTotal, etc.), SC (Solicitud de Cotización), filtro de estado OC, renderOC (index.html original: líneas 16611-16836) ──
function provName(id) {
  const p = state.proveedores.find(x=>x.id===id);
  return p ? p.name : '—';
}
function ocRecibidoQty(ocId, prodId) {
  return state.ocRecepcionItems
    .filter(ri => {
      const r = state.ocRecepciones.find(r=>r.id===ri.recepcion_id);
      return r?.oc_id === ocId && ri.producto_id === prodId;
    })
    .reduce((s,ri)=>s+Number(ri.cantidad||0),0);
}
function ocFacturadoTotal(ocId) {
  return state.ocFacturas.filter(f=>f.oc_id===ocId && f.status!=='cancelada')
    .reduce((s,f)=>s+Number(f.total||0),0);
}
// Valor total "recibido" en la OC, para efectos de saldo por facturar.
// Productos físicos: cantidad realmente recibida × precio unitario.
// Servicios: no hay recepción física — se cuenta la cantidad pedida completa
// desde que la OC se confirma (igual criterio que en openFacturaOC/calcFocTotales).
function ocValorRecibido(ocId) {
  return state.ocItems.filter(i=>i.oc_id===ocId)
    .reduce((s,i) => {
      const prod = state.productos.find(p => p.id === i.producto_id);
      const qty  = prod?.tipo === 'servicio' ? Number(i.cantidad||0) : ocRecibidoQty(ocId, i.producto_id);
      return s + (qty * Number(i.precio_unit||0));
    }, 0);
}
// Saldo pendiente por facturar = valor recibido - lo ya facturado (no cancelado)
// ── FACTURACIÓN POR LÍNEA (30/Ago/2026, a pedido explícito) ──
// La factura de compra se valida por CANTIDAD, no solo por valor: "no se
// puede facturar más kilogramos de los recibidos físicamente; el valor puede
// variar pero la cantidad no".
//
// Estas dos funciones leen erp_oc_factura_items, la tabla de detalle que
// permite acumular lo facturado producto por producto entre varias facturas
// parciales. Antes solo existía el total de la factura, así que no había
// forma de saber cuánto se llevaba facturado de cada producto.

// Cantidad ya facturada de un producto en una OC, sumando TODAS sus facturas.
//
// EXCLUYE LAS CANCELADAS (30/Ago/2026): al cancelar una factura, sus líneas
// NO se borran —el sistema maneja ciclo de vida por estados, no por borrado
// físico— así que hay que filtrarlas acá. Sin esto, cancelar una factura de
// 600 kg dejaba esos kilos contados como facturados para siempre y ya no se
// podían volver a facturar.
function ocFacturadoQty(ocId, productoId) {
  const facturasOC = (state.ocFacturas||[])
    .filter(f => f.oc_id === ocId && f.status !== 'cancelada')
    .map(f => f.id);
  return (state.ocFacturaItems||[])
    .filter(li => facturasOC.includes(li.factura_id) && li.producto_id === productoId)
    .reduce((s,li) => s + Number(li.cantidad||0), 0);
}

// Cantidad que TODAVÍA se puede facturar: recibido menos ya facturado.
// Nunca negativo — si se facturó de más (con justificación), el pendiente es
// cero, no un número negativo que se leería como un crédito a favor.
function ocPendienteFacturarLinea(ocId, productoId) {
  return Math.max(0, ocRecibidoQty(ocId, productoId) - ocFacturadoQty(ocId, productoId));
}

// Lee las líneas marcadas del modal de factura. Solo devuelve las que están
// tildadas y con cantidad > 0 — así se puede facturar parcialmente por línea
// (ej. el jersey rojo hoy y el verde la semana que viene) sin obligar a que
// todas las líneas de la OC estén en cada factura.
function getFocLineas(ocId, monedaOC) {
  const out = [];
  document.querySelectorAll('[id^="foc-item-row-"]').forEach(tr => {
    const idx = tr.id.replace('foc-item-row-','');
    const inc = document.getElementById(`foc-incluir-${idx}`);
    if (inc && !inc.checked) return;
    const cantidad = parseFloat(document.getElementById(`foc-cant-${idx}`)?.value) || 0;
    const precio   = parseFloat(document.getElementById(`foc-precio-${idx}`)?.value) || 0;
    if (cantidad <= 0) return;
    const prodId  = tr.dataset.productoId;
    const ocItemId= tr.dataset.ocItemId || null;
    const prod    = state.productos.find(p => p.id === prodId);
    const llevaIva= document.getElementById(`foc-iva-${idx}`)?.checked !== false;
    const totalLn = parseFloat((cantidad * precio).toFixed(4));
    const neto    = llevaIva ? parseFloat((totalLn / 1.12).toFixed(4)) : totalLn;
    out.push({
      producto_id: prodId, oc_item_id: ocItemId,
      unidad: prod?.unidad || tr.dataset.unidad || '',
      cantidad, precio_unit: precio, lleva_iva: llevaIva,
      neto, iva: parseFloat((totalLn - neto).toFixed(4)), total: totalLn,
      moneda: monedaOC,
      motivo_cantidad: null, motivo_precio: null,
      precio_oc: null, diferencia_precio: 0,
    });
  });
  return out;
}

function ocSaldoPorFacturar(ocId) {
  return ocValorRecibido(ocId) - ocFacturadoTotal(ocId);
}
function ocAnticipoTotal(ocId) {
  return state.ocAnticipos.filter(a=>a.oc_id===ocId)
    .reduce((s,a)=>s+Number(a.monto||0),0);
}

// ── SC RENDER ──
function renderSC() {
  const q  = (document.getElementById('search-sc')?.value||'').toLowerCase();
  const st = document.getElementById('filter-sc-status')?.value||'';
  const mes= document.getElementById('filter-sc-mes')?.value||'';
  const data = state.sc.filter(s=>
    (!st  || s.status===st) &&
    (!mes || (s.fecha||'').startsWith(mes)) &&
    (!q   || (s.numero||'').toLowerCase().includes(q) ||
             provName(s.proveedor_id).toLowerCase().includes(q))
  );
  const tbody = document.getElementById('tbl-sc');
  if (!tbody) return;
  tbody.innerHTML = data.length ? data.map(s=>{
    const items = state.scItems.filter(i=>i.sc_id===s.id);
    const total = items.reduce((sum,i)=>sum+Number(i.precio_est||0)*Number(i.cantidad||0),0);
    return `<tr>
      <td class="td-mono" style="font-weight:600;color:var(--accent)">${s.numero||'—'}</td>
      <td>${provName(s.proveedor_id)}</td>
      <td class="hide-mobile">${fmtDate(s.fecha)}</td>
      <td class="hide-mobile">${s.entrega?fmtDate(s.entrega):'—'}</td>
      <td class="td-mono">${fmtMoney(total)}</td>
      <td><span class="badge ${OC_STATUS_COLOR[s.status]||'badge-gray'}">${OC_STATUS_LABEL[s.status]||s.status}</span></td>
      <td><div class="td-actions">
        ${s.status==='borrador'||s.status==='enviada' ? `<button class="btn btn-sm btn-ghost" onclick="confirmarSCById('${s.id}')">→ Confirmar OC</button>` : ''}
        <button class="btn btn-sm btn-ghost" onclick="editSC('${s.id}')">Editar</button>
        <button class="btn btn-sm btn-danger" onclick="deleteSC('${s.id}')">Eliminar</button>
      </div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="7"><div class="empty-state"><p>Sin solicitudes de cotización</p></div></td></tr>';
}

// ── FILTRO DE ESTADO OC (multi-selección) ──
// Reemplaza al <select> de un solo valor (26/Ago/2026, a pedido explícito).
// Sin checks marcados = sin filtro = se ven todas, igual que el antiguo
// "Todos los estados". Así el comportamiento por defecto no cambia.
function ocStatusSeleccionados() {
  return [...document.querySelectorAll('.oc-status-chk:checked')].map(c => c.value);
}

function toggleOCStatusFilter(ev) {
  ev?.stopPropagation();
  const menu = document.getElementById('oc-status-filter-menu');
  if (!menu) return;
  const abierto = menu.style.display === 'block';
  menu.style.display = abierto ? 'none' : 'block';
  // Cerrar al hacer clic fuera. Se registra una sola vez por apertura.
  if (!abierto) {
    const cerrar = e => {
      if (!document.getElementById('oc-status-filter-wrap')?.contains(e.target)) {
        menu.style.display = 'none';
        document.removeEventListener('click', cerrar);
      }
    };
    setTimeout(() => document.addEventListener('click', cerrar), 0);
  }
}

function toggleOCStatusAll(chk) {
  document.querySelectorAll('.oc-status-chk').forEach(c => { c.checked = false; });
  if (!chk.checked) chk.checked = false;
  onOCStatusChange();
}

function onOCStatusChange() {
  const sel = ocStatusSeleccionados();
  const all = document.getElementById('oc-status-all');
  if (all) all.checked = sel.length === 0;
  const lbl = document.getElementById('oc-status-filter-label');
  if (lbl) {
    lbl.textContent = sel.length === 0
      ? 'Todos los estados'
      : (sel.length === 1 ? (OC_STATUS_LABEL[sel[0]] || sel[0]) : `${sel.length} estados`);
  }
  renderOC();
}

// ── OC RENDER ──
function renderOC() {
  const q  = (document.getElementById('search-oc')?.value||'').toLowerCase();
  const sts= ocStatusSeleccionados();
  const mes= document.getElementById('filter-oc-mes')?.value||'';
  const data = state.oc.filter(o=>
    (!sts.length || sts.includes(o.status)) &&
    (!mes || (o.fecha||'').startsWith(mes)) &&
    (!q   || (o.numero||'').toLowerCase().includes(q) ||
             provName(o.proveedor_id).toLowerCase().includes(q))
  );
  const tbody = document.getElementById('tbl-oc');
  if (!tbody) return;
  tbody.innerHTML = data.length ? data.map(o=>{
    // Estado de PAGO — independiente del estado de flujo (o.status), que
    // nunca representa si ya se pagó. Se calcula dinámicamente desde sus
    // facturas + pagosOC (igual que la pestaña Facturas del panel de la
    // OC), así que refleja de inmediato cualquier asignación/desasignación
    // hecha desde el módulo Pagos, sin depender de un campo propio en
    // erp_oc que haya que mantener sincronizado aparte.
    const facturasOC = (state.ocFacturas||[]).filter(f=>f.oc_id===o.id && f.status!=='cancelada');
    let pagoBadge = '';
    if (facturasOC.length) {
      const totalFact = facturasOC.reduce((s,f)=>s+Number(f.total||0),0);
      const totalPag  = facturasOC.reduce((s,f)=>{
        const pagado = (state.pagosOC||[]).filter(p=>p.factura_id===f.id).reduce((ss,p)=>ss+Number(p.monto||0),0);
        return s + pagado;
      },0);
      const esPagada  = totalPag >= totalFact - 0.01;
      const esParcial = totalPag > 0 && !esPagada;
      pagoBadge = `<span class="badge ${esPagada?'badge-green':esParcial?'badge-yellow':'badge-blue'}">${esPagada?'Pagada':esParcial?'Pago Parcial':'Pendiente'}</span>`;
    } else {
      pagoBadge = `<span style="color:var(--text3);font-size:12px">Sin facturar</span>`;
    }
    return `<tr style="cursor:pointer" onclick="showOCPanel('${o.id}')">
      <td class="td-mono" style="font-weight:600;color:var(--accent)">${o.numero||'<span style="font-style:italic;opacity:.7">Borrador</span>'}</td>
      <td style="white-space:nowrap">${fmtDate(o.fecha)}</td>
      <td>${provName(o.proveedor_id)}</td>
      <td class="hide-mobile" style="font-size:12px;color:var(--text2)">${o.representante||'—'}</td>
      <td class="hide-mobile" style="white-space:nowrap">${o.entrega?fmtDate(o.entrega):'—'}</td>
      <td><span class="badge ${OC_STATUS_COLOR[o.status]||'badge-gray'}">${OC_STATUS_LABEL[o.status]||o.status}</span>${o.recepcion_cerrada?'<span class="badge badge-yellow" style="font-size:9px;margin-left:4px" title="Cerrada aceptando un faltante — no se recibió todo lo pedido">con faltante</span>':''}</td>
      <td>${pagoBadge}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="7"><div class="empty-state"><p>Sin órdenes de compra</p></div></td></tr>';
  if (currentOCId) renderOCPanel(currentOCId);
}


// ── OC — showOCPanel, confirmarOC, cancelarOC, pagos/facturas OC (asientos, detalle, impresión) (index.html original: líneas 16998-18196) ──
function showOCPanel(ocId) {
  currentOCId = ocId;
  const oc = state.oc.find(x=>x.id===ocId);
  const hasRecepciones = state.ocRecepciones.some(r=>r.oc_id===ocId);
  document.getElementById('oc-detail-panel') && (document.getElementById('oc-detail-panel').style.display='none');
  openModal('modal-oc-panel');
  document.getElementById('oc-panel-title').textContent = `${oc.numero||'Borrador'} — ${provName(oc.proveedor_id)}`;
  const bodegaNombre  = oc.bodega_id ? (state.bodegas||[]).find(b=>b.id===oc.bodega_id)?.nombre : null;
  const terminosLabel = { inmediato:'Pago Inmediato', '15':'15 días', '30':'30 días', '45':'45 días', '60':'60 días' };
  const terminosText  = oc.terminos_pago ? terminosLabel[oc.terminos_pago]||oc.terminos_pago : null;
  document.getElementById('oc-panel-sub').innerHTML = `Fecha: ${fmtDate(oc.fecha)} &nbsp;·&nbsp; <span class="badge ${OC_STATUS_COLOR[oc.status]||'badge-gray'}">${OC_STATUS_LABEL[oc.status]||oc.status}</span>${oc.recepcion_cerrada?' <span class="badge badge-yellow" style="font-size:10px" title="Cerrada aceptando un faltante — no se recibió todo lo pedido">cerrada con faltante</span>':''}${bodegaNombre?` &nbsp;·&nbsp; <span style="font-size:11px;color:var(--text2)">📦 ${bodegaNombre}</span>`:''}${terminosText?` &nbsp;·&nbsp; <span style="font-size:11px;color:var(--text2)">💳 ${terminosText}</span>`:''}${oc.representante?` &nbsp;·&nbsp; <span style="font-size:11px;color:var(--text2)">👤 ${oc.representante}</span>`:''}`;

  const isBorrador   = oc.status === 'borrador';
  const isConfirmada = oc.status === 'confirmada' || oc.status === 'recibiendo' || oc.status === 'completada';
  const isCancelada  = oc.status === 'cancelada';

  // Detect if ALL items are services — no reception needed
  const ocItems = state.ocItems.filter(i => i.oc_id === ocId);
  const esServicio = ocItems.length > 0 && ocItems.every(i => {
    const prod = state.productos.find(p => p.id === i.producto_id);
    return prod?.tipo === 'servicio';
  });

  const canReceive = isConfirmada && !esServicio && oc.status !== 'completada';
  // Para habilitar factura, la recepción debe estar realmente confirmada — una
  // recepción en borrador (ej. escaneo de PL a medio terminar) no cuenta como
  // "producto recibido" todavía.
  const hasRecepcionesConfirmadas = state.ocRecepciones.some(r=>r.oc_id===ocId && r.status==='completada');
  // Servicios: factura disponible al confirmar; físicos: requieren recepción confirmada.
  // El tope es por CANTIDAD PENDIENTE DE FACTURAR (30/Ago/2026), no por saldo
  // en valor: antes esto usaba ocSaldoPorFacturar(), la validación por VALOR
  // que se reemplazó al pasar a facturación por línea. Con precios distintos
  // al de la orden el saldo en dinero se agota antes que los kilos, y el botón
  // desaparecía dejando material recibido sin poder facturar.
  const hayPendientePorFacturar = esServicio
    ? ocSaldoPorFacturar(ocId) > 0.01   // servicios: no hay cantidad recibida, el tope sigue siendo el valor
    : (state.ocItems||[]).filter(i => i.oc_id === ocId)
        .some(i => ocPendienteFacturarLinea(ocId, i.producto_id) > 0.001);
  const canInvoice = isConfirmada && (esServicio || hasRecepcionesConfirmadas) && hayPendientePorFacturar;

  // Confirmar — solo en borrador
  const btnConf = document.getElementById('btn-confirmar-oc');
  if (btnConf) { btnConf.style.display = isBorrador ? '' : 'none'; }

  // Editar — mismo criterio que Confirmar: solo tiene sentido mientras
  // sigue en borrador (15/Ago/2026, a pedido explícito).
  const btnEdit = document.getElementById('btn-editar-oc');
  if (btnEdit) { btnEdit.style.display = isBorrador ? '' : 'none'; }

  // Reabastecer (15/Ago/2026, a pedido explícito): solo aplica a OC de
  // servicio de subcontrato con receta asociada (planificarSubcontrato ya
  // guarda receta_id al generarla). CAMBIO (20/Ago/2026, a pedido
  // explícito — "yo puedo confirmar una OP, una OC aunque no haya
  // reabastecido materia prima"): Confirmar YA NO se deshabilita por
  // reabastecimiento incompleto. El botón Reabastecer queda visible
  // siempre que la receta lo requiera, esté o no completo, y esté o no
  // ya confirmada la OC — así se puede seguir asignando MP conforme se
  // va enviando, incluso después de confirmar.
  const btnReabOC = document.getElementById('btn-oc-reabastecer');
  if (btnConf) btnConf.disabled = false;
  if (btnReabOC) {
    const recetaOC = (state.recetas||[]).find(r=>r.id===oc.receta_id);
    const cantidadOC = Number(ocItems[0]?.cantidad||0);
    const estOC = recetaOC && cantidadOC ? estadoReabastecimiento('oc', ocId, recetaOC, cantidadOC) : { requiere:false, completo:true };
    if (estOC.requiere) {
      btnReabOC.style.display = '';
      const cubiertos = estOC.detalle.filter(d=>d.completo).length;
      btnReabOC.textContent = estOC.completo ? '✓ Reabastecido' : `🔄 Reabastecer (${cubiertos}/${estOC.detalle.length})`;
    } else {
      btnReabOC.style.display = 'none';
    }
  }

  // Recibir — solo para productos físicos confirmados
  const btnRec = document.getElementById('btn-recibir');
  if (btnRec) btnRec.style.display = canReceive ? '' : 'none';

  // Factura — servicios: al confirmar; físicos: tras recepción
  document.getElementById('btn-factura-oc').style.display = canInvoice ? '' : 'none';

  // Anticipo — no en cancelada
  const btnAnt = document.getElementById('btn-anticipo');
  if (btnAnt) btnAnt.style.display = isCancelada ? 'none' : '';

  // Cancelar — solo si no hay recepciones y no está ya cancelada
  const btnCan = document.getElementById('btn-cancelar-oc');
  if (btnCan) btnCan.style.display = (!hasRecepciones && !isCancelada) ? '' : 'none';

  // Show service badge on panel if applicable
  const sub = document.getElementById('oc-panel-sub');
  if (esServicio && sub && !sub.innerHTML.includes('Servicio')) {
    sub.innerHTML += ' &nbsp;·&nbsp; <span class="badge badge-blue">Servicio</span>';
  }

  renderOCPanel(ocId);
}

async function confirmarOC() {
  const oc = state.oc.find(x=>x.id===currentOCId);
  if (!oc) return;

  const ocItems  = state.ocItems.filter(i => i.oc_id === currentOCId);
  const esServicio = ocItems.every(i => state.productos.find(p=>p.id===i.producto_id)?.tipo === 'servicio');

  // REABASTECIMIENTO (candado ELIMINADO 20/Ago/2026, a pedido explícito:
  // "yo puedo confirmar una OP, una OC aunque no haya reabastecido materia
  // prima"). Antes bloqueaba Confirmar hasta tener el 100% de los insumos
  // asignados — ahora se puede confirmar con reabastecimiento parcial o en
  // cero, y se sigue asignando MP después con 🔄 Reabastecer (cada
  // asignación contabiliza su propio consumo al momento, ver
  // confirmarAsignacionLotes). Solo se avisa, no se bloquea.
  const recetaOC = (state.recetas||[]).find(r=>r.id===oc.receta_id);
  const cantidadOC = Number(ocItems[0]?.cantidad||0);
  if (recetaOC && cantidadOC) {
    const estOC = estadoReabastecimiento('oc', currentOCId, recetaOC, cantidadOC);
    if (estOC.requiere && !estOC.completo) {
      if (!confirm('Todavía falta reabastecimiento por asignar para esta OC. ¿Confirmar de todas formas? Podés seguir asignando lotes después.')) return;
    }
  }

  const label = oc.numero || 'esta OC (aún sin número)';
  const msg = esServicio
    ? `¿Confirmar ${oc.numero?`la OC ${label}`:label}?\n\nAl ser una OC de servicio, podrás ingresar la factura directamente.`
    : `¿Confirmar ${oc.numero?`la OC ${label}`:label}?\n\nEsto habilitará la recepción de productos.`;
  if (!confirm(msg)) return;

  const newStatus = esServicio ? 'completada' : 'confirmada';
  // Las OC nacen en 'borrador' sin numero asignado — tanto si las crea el
  // usuario a mano como si las genera el motor de planificación
  // automática. El correlativo real solo se asigna aquí, al confirmar,
  // para que un borrador descartado nunca "queme" un número.
  const update = { status: newStatus };
  if (!oc.numero) update.numero = await nextOCNum();
  await sb.from('erp_oc').update(update).eq('id', currentOCId);
  logAuditoria('compras', 'confirmar', 'OC', currentOCId, update.numero || oc.numero);
  toast(`OC ${update.numero||oc.numero} confirmada`);
  await loadAll();

  // Asistente de Planificación (15/Ago/2026, a pedido explícito): si esta
  // OC es justo el paso actual del asistente, avanza sola al siguiente
  // documento en vez del refresh normal del panel.
  // REDISEÑO (30/Ago/2026): ver nota equivalente en el cambio de estado de
  // la OP — la navegación del asistente ya no se mueve sola al confirmar.
  // Se deja seguir el refresh normal del panel.

  showOCPanel(currentOCId);
}

async function cancelarOC() {
  const oc = state.oc.find(x=>x.id===currentOCId);
  if (!oc) return;
  const hasRec = state.ocRecepciones.some(r=>r.oc_id===currentOCId);
  if (hasRec) { toast('No se puede cancelar — ya tiene recepciones registradas','error'); return; }
  const label = oc.numero || 'esta OC (aún sin número)';
  const motivo = prompt(`¿Motivo de cancelación de ${oc.numero?`la OC ${label}`:label}? (opcional)`);
  if (motivo === null) return; // user pressed Cancel
  await sb.from('erp_oc').update({
    status: 'cancelada',
    notas: [oc.notas, motivo ? `Cancelada: ${motivo}` : 'Cancelada'].filter(Boolean).join(' | ')
  }).eq('id', currentOCId);
  logAuditoria('compras', 'cancelar', 'OC', currentOCId, oc.numero, { motivo });
  toast(`${oc.numero?`OC ${oc.numero}`:'OC'} cancelada`);
  await loadAll();
  showOCPanel(currentOCId);
}

// Cancelación "suave" de una factura de proveedor: cambia el status a
// 'cancelada' y, si la factura ya estaba contabilizada (asientoFacturaCompra
// se disparó al generarla), postea un asiento de REVERSA — patrón estándar
// de reversa del sistema: swap debe/haber por línea del asiento original,
// mismo diario, mismo referencia_id. Nunca se edita ni se borra el asiento original ya
// posteado (no se editan asientos posteados); la reversa es un asiento
// nuevo e independiente que lo neutraliza.
async function cancelarFacturaOC(facturaId) {
  const f = (state.ocFacturas||[]).find(x=>x.id===facturaId);
  if (!f) { toast('Factura no encontrada','error'); return; }
  if (f.status === 'cancelada') { toast('Esta factura ya está cancelada','error'); return; }
  const pagosF = (state.pagosOC||[]).filter(p=>p.factura_id===facturaId);
  if (pagosF.length) { toast('No se puede cancelar — tiene pagos aplicados. Desasígnalos primero desde Pagos.','error'); return; }
  const motivo = prompt(`¿Motivo de cancelación de la factura ${f.num_interno||f.numero}? (opcional)`);
  if (motivo === null) return; // usuario canceló el prompt
  const { error } = await sb.from('erp_oc_facturas').update({
    status: 'cancelada',
    notas: [f.notas, motivo ? `Cancelada: ${motivo}` : 'Cancelada'].filter(Boolean).join(' | ')
  }).eq('id', facturaId);
  if (error) { toast('Error: '+error.message,'error'); return; }

  // LIBRO DE COMPRAS (30/Ago/2026, a pedido explícito). El registro NO se
  // borra —es un libro fiscal y la anulación debe poder verse— pero se marca
  // como cancelado para que deje de sumar a los totales y al IVA crédito
  // fiscal. Sin esto, una factura anulada seguía declarándose como vigente.
  const { error: errLibro } = await sb.from('erp_compras')
    .update({ estado: 'cancelada' }).eq('factura_id', facturaId);
  if (errLibro) {
    console.error('Error marcando la compra como cancelada en el Libro de Compras:', errLibro.message);
    alert(
      'ATENCIÓN — La factura se canceló pero su registro en el LIBRO DE COMPRAS ' +
      'no pudo marcarse como anulado.\n\n' + errLibro.message + '\n\n' +
      'El libro seguirá declarando esta compra como vigente, incluido su IVA ' +
      'crédito fiscal. Corríjalo antes de cerrar el período.'
    );
  }

  // Reversar el/los asiento(s) ya posteados para esta factura (Asiento de
  // Factura de Compra: Gasto/Inventario + IVA Crédito Fiscal contra
  // Cuentas por Pagar Proveedores).
  const asientosFactura = (state.asientos||[]).filter(a => a.referencia_id === facturaId);
  for (const a of asientosFactura) {
    const lineasOrig = (state.asientoLineas||[]).filter(l => l.asiento_id === a.id);
    if (!lineasOrig.length) continue;
    await crearAsiento({
      diario: 'COMPRAS', fecha: today(),
      descripcion: `REVERSA — ${a.descripcion}`,
      referencia: a.referencia, referencia_id: facturaId,
      moneda: 'GTQ', tipo_cambio: 1,
      lineas: lineasOrig.map(l => ({
        cuenta_id:     l.cuenta_id,
        cuenta_codigo: l.cuenta_codigo,
        cuenta_nombre: l.cuenta_nombre,
        debe:  l.haber,  // swapped
        haber: l.debe,   // swapped
        descripcion: `Reversa: ${l.descripcion||''}`,
      })),
    });
  }

  toast(`Factura ${f.num_interno||f.numero} cancelada${asientosFactura.length?' — asiento de reversa generado':''}`);
  await loadAll();
}

// ══════════════════════════════════════════════════════════════
// DESASIGNAR / ASIGNAR PAGOS — modelo tipo Odoo: un pago es un registro
// independiente contra el proveedor, no contra una factura. Aquí NO se creó
// una tabla de aplicaciones aparte: cada fila de erp_pagos_oc YA ES una
// aplicación (1 fila = 1 pago aplicado a 1 factura, o sin aplicar si
// factura_id es null). "Desasignar" libera esa fila (factura_id → null) y
// mueve su monto a la cuenta de compensación "Pagos Sin Aplicar a
// Proveedor"; "Asignar" hace lo inverso contra una factura (nueva o
// distinta). El asiento original del pago (CxP ↔ Transitoria/Banco) NUNCA
// se toca — el dinero sí salió del banco, eso no cambia; lo único que se
// mueve es a qué factura se le atribuye ese pago dentro de Cuentas x Pagar.
// ══════════════════════════════════════════════════════════════

// Saldo sin aplicar de un pago: en este modelo, una fila con factura_id=null
// está 100% sin aplicar (todo su monto); una fila con factura_id ya asignado
// está 100% aplicada (saldo 0) — no hay aplicación parcial dentro de una
// misma fila (ver asignarPagoOC: una aplicación parcial separa el remanente
// en una fila nueva, sin aplicar).
function saldoSinAplicarPagoOC(pagoId) {
  const p = (state.pagosOC||[]).find(x=>x.id===pagoId);
  if (!p) return 0;
  return p.factura_id ? 0 : Number(p.monto||0);
}

async function desasignarPagoOC(pagoId) {
  const p = (state.pagosOC||[]).find(x=>x.id===pagoId);
  if (!p) { toast('Pago no encontrado','error'); return; }
  if (!p.factura_id) { toast('Este pago ya está sin aplicar','error'); return; }
  const f    = (state.ocFacturas||[]).find(x=>x.id===p.factura_id);
  const prov = (state.proveedores||[]).find(x=>x.id===p.proveedor_id);
  if (!confirm(`¿Desasignar el pago ${p.num_pago||''} (${fmtMoney(p.monto, p.moneda||'GTQ')}) de la factura ${f?.num_interno||f?.numero||''}?\n\nEl monto quedará disponible para aplicarlo a otra factura del mismo proveedor.`)) return;

  const ctaPorPagar   = ctaPorPagarOC(f?.oc_id);
  const ctaSinAplicar = sinAplicarNomenclatura(p.moneda||'GTQ', 'pago');

  // Reinstala el saldo pendiente de la factura (Haber CxP) y mueve el monto
  // a la cuenta de compensación (Debe Pagos Sin Aplicar) — no toca el lado
  // Banco/Transitoria del asiento original.
  await crearAsiento({
    diario: 'BANCOS', fecha: today(),
    descripcion: `Desasignación de pago ${p.num_pago||''} — ${f?.serie||''}${f?.numero||''} — ${prov?.name||''}`,
    referencia: `DESASIGNA-${p.num_pago||pagoId}`, referencia_id: pagoId,
    moneda: p.moneda||'GTQ', tipo_cambio: 1,
    lineas: [
      { cuenta_id: ctaPorPagar?.id||null, cuenta_codigo: ctaPorPagar?.codigo||'CXP', cuenta_nombre: ctaPorPagar?.nombre||'Cuentas x Pagar', debe: 0, haber: Number(p.monto||0), descripcion: `Reinstala saldo — ${f?.serie||''}${f?.numero||''}` },
      { cuenta_id: ctaSinAplicar?.id||null, cuenta_codigo: ctaSinAplicar?.codigo||'PAGOS-SIN-APLICAR', cuenta_nombre: ctaSinAplicar?.nombre||'Pagos Sin Aplicar a Proveedor', debe: Number(p.monto||0), haber: 0, descripcion: `Pago ${p.num_pago||''} sin aplicar` },
    ],
  });

  // Reversar el diferencial cambiario de este pago, si existió (ver
  // savePago(): referencia_id apunta al id del pago, no de la factura).
  const asientosDiff = (state.asientos||[]).filter(a => a.referencia_id === pagoId && a.diario === DIARIO_CAMBIARIO);
  for (const a of asientosDiff) {
    const lineasOrig = (state.asientoLineas||[]).filter(l => l.asiento_id === a.id);
    if (!lineasOrig.length) continue;
    await crearAsiento({
      diario: DIARIO_CAMBIARIO, fecha: today(),
      descripcion: `REVERSA — ${a.descripcion}`,
      referencia: a.referencia, referencia_id: pagoId,
      moneda: 'GTQ', tipo_cambio: 1,
      lineas: lineasOrig.map(l => ({ cuenta_id:l.cuenta_id, cuenta_codigo:l.cuenta_codigo, cuenta_nombre:l.cuenta_nombre, debe:l.haber, haber:l.debe, descripcion:`Reversa: ${l.descripcion||''}` })),
    });
  }

  // Libera el pago — ya no queda ligado a ninguna factura.
  await sb.from('erp_pagos_oc').update({ factura_id: null }).eq('id', pagoId);

  // Recalcular estado de la factura que quedó liberada.
  if (f) {
    const pagadoRestante = (state.pagosOC||[]).filter(x=>x.factura_id===f.id && x.id!==pagoId).reduce((s,x)=>s+Number(x.monto||0),0);
    await sb.from('erp_oc_facturas').update({
      monto_pagado: pagadoRestante,
      estado_pago: pagadoRestante<=0 ? 'pendiente' : (pagadoRestante >= Number(f.total||0) ? 'pagado' : 'parcial'),
    }).eq('id', f.id);
  }

  toast(`Pago ${p.num_pago||''} desasignado — disponible para aplicar a otra factura`);
  await loadAll();
}

// Aplica un pago sin aplicar (o su remanente) a una factura — `monto`
// opcional: por default aplica lo máximo posible (el menor entre el saldo
// del pago y el saldo pendiente de la factura). Si aplica menos que el
// monto total del pago, la fila original se divide: la porción aplicada se
// queda ligada a la factura, y el remanente se separa en una fila nueva,
// todavía sin aplicar — así una misma fila de erp_pagos_oc nunca queda
// "parcialmente aplicada".
async function asignarPagoOC(pagoId, facturaId, montoAplicar) {
  const p = (state.pagosOC||[]).find(x=>x.id===pagoId);
  const f = (state.ocFacturas||[]).find(x=>x.id===facturaId);
  if (!p || !f) { toast('Pago o factura no encontrados','error'); return; }
  if (p.factura_id) { toast('Este pago ya está aplicado a una factura','error'); return; }
  if (f.status === 'cancelada') { toast('Esa factura está cancelada','error'); return; }
  const oc = state.oc.find(o=>o.id===f.oc_id);
  if (p.proveedor_id && oc?.proveedor_id && oc.proveedor_id !== p.proveedor_id) {
    toast('El pago y la factura son de proveedores distintos','error'); return;
  }
  const pagadoFactura = (state.pagosOC||[]).filter(x=>x.factura_id===facturaId).reduce((s,x)=>s+Number(x.monto||0),0);
  const saldoFactura = Math.max(0, Number(f.total||0) - pagadoFactura);
  const monto = Math.min(Number(montoAplicar)||Number(p.monto||0), Number(p.monto||0), saldoFactura);
  if (monto <= 0) { toast('No hay saldo pendiente que aplicar','error'); return; }

  const prov = (state.proveedores||[]).find(x=>x.id===(p.proveedor_id||oc?.proveedor_id));
  const ctaPorPagar   = ctaPorPagarOC(f.oc_id);
  const ctaSinAplicar = sinAplicarNomenclatura(p.moneda||'GTQ', 'pago');

  await crearAsiento({
    diario: 'BANCOS', fecha: today(),
    descripcion: `Aplicación de pago ${p.num_pago||''} — ${f.serie||''}${f.numero} — ${prov?.name||''}`,
    referencia: `APLICA-${p.num_pago||pagoId}`, referencia_id: pagoId,
    moneda: p.moneda||'GTQ', tipo_cambio: 1,
    lineas: [
      { cuenta_id: ctaSinAplicar?.id||null, cuenta_codigo: ctaSinAplicar?.codigo||'PAGOS-SIN-APLICAR', cuenta_nombre: ctaSinAplicar?.nombre||'Pagos Sin Aplicar a Proveedor', debe: 0, haber: monto, descripcion: `Pago ${p.num_pago||''} aplicado` },
      { cuenta_id: ctaPorPagar?.id||null, cuenta_codigo: ctaPorPagar?.codigo||'CXP', cuenta_nombre: ctaPorPagar?.nombre||'Cuentas x Pagar', debe: monto, haber: 0, descripcion: `Aplicado a ${f.serie||''}${f.numero}` },
    ],
  });

  // Diferencial cambiario contra la factura nueva, si aplica (mismo
  // criterio que en savePago(): TC de la fecha del pago vs. TC de la fecha
  // de la factura).
  if ((p.moneda||'GTQ') === 'USD' && f.fecha) {
    const tcPago    = getTCFecha(p.fecha);
    const tcFactura = getTCFecha(f.fecha);
    if (Math.abs(tcPago - tcFactura) > 0.0001) {
      await asientoDiferencialCambiario({
        montoUSD: monto, tcOriginal: tcFactura, tcLiquidacion: tcPago, fecha: today(),
        referencia: `Factura ${f.serie||''}${f.numero} — ${oc?.numero||''}`,
        referencia_id: pagoId, tipo: 'pago',
      });
    }
  }

  if (monto < Number(p.monto||0)) {
    const remanente = Number(p.monto||0) - monto;
    await sb.from('erp_pagos_oc').update({ factura_id: facturaId, monto }).eq('id', pagoId);
    await sb.from('erp_pagos_oc').insert({
      proveedor_id: p.proveedor_id||oc?.proveedor_id||null, fecha: p.fecha, forma: p.forma, cuenta_id: p.cuenta_id,
      monto: remanente, referencia: p.referencia, num_pago: p.num_pago, moneda: p.moneda,
      notas: `Remanente sin aplicar de ${p.num_pago||''}`,
    });
  } else {
    await sb.from('erp_pagos_oc').update({ factura_id: facturaId }).eq('id', pagoId);
  }

  const nuevoPagado = pagadoFactura + monto;
  await sb.from('erp_oc_facturas').update({
    monto_pagado: nuevoPagado,
    estado_pago: nuevoPagado >= Number(f.total||0) ? 'pagado' : 'parcial',
  }).eq('id', facturaId);

  toast(`✓ Pago aplicado a ${f.serie||''}${f.numero}`);
  await loadAll();
}

function imprimirOC() {
  const oc   = state.oc.find(x=>x.id===currentOCId);
  if (!oc) return;
  const prov  = state.proveedores.find(p=>p.id===oc.proveedor_id);
  const items = state.ocItems.filter(i=>i.oc_id===currentOCId);
  const bodega = oc.bodega_id ? (state.bodegas||[]).find(b=>b.id===oc.bodega_id) : null;
  const bodegaProv = bodega?.proveedor_id ? state.proveedores.find(p=>p.id===bodega.proveedor_id) : null;

  const fechaFmt   = fmtDate(oc.fecha);
  const entregaFmt = fmtDate(oc.entrega);
  const terminosLabel = { inmediato:'Pago Inmediato', '15':'15 días', '30':'30 días', '45':'45 días', '60':'60 días' };
  const terminosText  = oc.terminos_pago ? (terminosLabel[oc.terminos_pago]||oc.terminos_pago) : '—';
  const subtotal  = items.reduce((s,i) => s + (Number(i.total_orig||0) || Number(i.cantidad||0)*Number(i.precio_unit||0)), 0);
  const monedaDoc = items[0]?.moneda || 'GTQ';

  const infoRow = (label, val) => val ? `<div class="info-row"><span class="info-label">${label}</span><span class="info-val">${val}</span></div>` : '';

  const win = window.open('','_blank','width=900,height=700');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8"/>
    <title>OC ${oc.numero||'Borrador'}</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Inter',sans-serif;font-size:12px;color:#1A1C21;padding:32px;background:#fff}
      .doc-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;padding-bottom:18px;border-bottom:2px solid #101820}
      .brand{font-size:11px;color:#5E6470;margin-top:4px}
      .oc-num{font-size:26px;font-weight:700;color:#C84B2F;font-family:monospace}
      .oc-fecha{font-size:11px;color:#5E6470;text-align:right;margin-top:4px}
      .two-col{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:20px 0}
      .col-title{font-size:9px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;color:#9EA4B0;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #E2E4E9}
      .info-row{display:flex;flex-direction:column;margin-bottom:6px}
      .info-label{font-size:9px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#9EA4B0;margin-bottom:1px}
      .info-val{font-size:12px;font-weight:500;color:#1A1C21}
      .meta-row{display:flex;gap:40px;padding:12px 16px;background:#F4F5F7;border-radius:6px;margin-bottom:20px}
      .meta-item{display:flex;flex-direction:column;gap:2px}
      .section-title{font-size:9px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;color:#9EA4B0;margin:20px 0 8px}
      table{width:100%;border-collapse:collapse;margin-bottom:20px}
      thead th{background:#F4F5F7;padding:8px 12px;text-align:left;font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#5E6470;border-bottom:1px solid #E2E4E9}
      tbody td{padding:9px 12px;border-bottom:1px solid #F0F1F3;font-size:12px}
      tbody tr:last-child td{border-bottom:none}
      .num{text-align:right;font-family:monospace}
      .totals{margin-left:auto;width:280px;border:1px solid #E2E4E9;border-radius:8px;overflow:hidden}
      .tot-row{display:flex;justify-content:space-between;padding:8px 14px;font-size:12px}
      .tot-row:not(:last-child){border-bottom:1px solid #F0F1F3}
      .tot-final{background:#101820;color:#fff;font-weight:700;font-size:13px}
      .footer{margin-top:48px;padding-top:20px;border-top:1px solid #E2E4E9;display:grid;grid-template-columns:1fr 1fr;gap:40px}
      .firma-nombre{font-size:11px;font-weight:600;color:#1A1C21;margin-bottom:32px}
      .firma-linea{border-top:1px solid #9EA4B0;padding-top:6px;font-size:10px;color:#9EA4B0;text-align:center}
      .badge{display:inline-block;padding:3px 10px;border-radius:4px;font-size:10px;font-weight:600}
      .status-confirmada{background:#ECFDF5;color:#16A34A}
      .status-borrador{background:#F0F1F3;color:#5E6470}
      ${oc.notas?'.notas{margin-top:12px;padding:10px 14px;background:#FFFBEB;border-radius:6px;font-size:11px;color:#5E6470}':''}
      @media print{body{padding:16px} @page{margin:12mm}}
    </style>
  </head><body>

    <!-- HEADER: Logo + OC número + fecha -->
    <div class="doc-header">
      <div>
        <h1 style="font-size:20px;font-weight:700">Orden de Compra</h1>
        <div class="brand">TEXTILES CIRCULARES, S.A.</div>
      </div>
      <div style="text-align:right">
        <div class="oc-num">${oc.numero||'BORRADOR'}</div>
        <div class="oc-fecha">Fecha de Emisión: ${fechaFmt}</div>
        <div style="margin-top:6px"><span class="badge status-${oc.status||'borrador'}">${OC_STATUS_LABEL[oc.status]||oc.status}</span></div>
      </div>
    </div>

    <!-- DOS COLUMNAS: Proveedor | Lugar de Entrega -->
    <div class="two-col">
      <div>
        <div class="col-title">Proveedor</div>
        ${infoRow('Proveedor', prov?.name)}
        ${infoRow('NIT', prov?.nit)}
        ${infoRow('Contacto (Producción)', prov?.prod_nombre)}
        ${infoRow('Dirección 1', prov?.address)}
        ${infoRow('Dirección 2', prov?.address2)}
        ${infoRow('Estado / País', [prov?.estado, prov?.pais].filter(Boolean).join(' / '))}
        ${infoRow('Teléfono', prov?.prod_tel)}
        ${infoRow('Email', prov?.prod_email)}
      </div>
      <div>
        <div class="col-title">Lugar de Entrega</div>
        ${infoRow('Bodega', bodega?.nombre)}
        ${infoRow('Empresa', bodegaProv?.name)}
        ${infoRow('Dirección 1', bodega?.direccion)}
        ${infoRow('Dirección 2', bodega?.direccion2)}
        ${infoRow('Teléfono', bodega?.telefono)}
      </div>
    </div>

    <!-- FILA META: Fecha entrega | Incoterms | Forma de pago -->
    <div class="meta-row">
      <div class="meta-item">
        <span class="info-label">Fecha de Entrega</span>
        <span class="info-val">${entregaFmt}</span>
      </div>
      <div class="meta-item">
        <span class="info-label">Incoterms</span>
        <span class="info-val">${oc.incoterms||'—'}</span>
      </div>
      <div class="meta-item">
        <span class="info-label">Forma de Pago</span>
        <span class="info-val">${terminosText}</span>
      </div>
    </div>

    ${oc.notas?`<div class="notas"><strong>Notas:</strong> ${oc.notas}</div>`:''}

    <!-- LÍNEAS DE PRODUCTO -->
    <div class="section-title">Detalle de Productos / Servicios</div>
    <table>
      <thead><tr>
        <th>#</th><th>Código</th><th>Descripción</th><th>Unidad</th>
        <th class="num">Cantidad</th><th class="num">Precio Unit.</th><th class="num">Total</th>
      </tr></thead>
      <tbody>
        ${items.map((i,idx)=>{
          const p = state.productos.find(x=>x.id===i.producto_id);
          const moneda = i.moneda || monedaDoc;
          const totalOrig = Number(i.total_orig||0) || Number(i.cantidad||0)*Number(i.precio_unit||0);
          return `<tr>
            <td style="color:#9EA4B0">${idx+1}</td>
            <td style="font-family:monospace;font-size:11px">${p?.codigo_interno||p?.code||'—'}</td>
            <td>${p?.description||prodName(i.producto_id)}</td>
            <td>${i.unidad||'—'}</td>
            <td class="num">${Number(i.cantidad||0).toFixed(3)}</td>
            <td class="num">${fmtMoney(i.precio_unit, moneda)}</td>
            <td class="num" style="font-weight:600">${fmtMoney(totalOrig, moneda)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>

    <div class="totals">
      <div class="tot-row"><span>Subtotal</span><span style="font-family:monospace">${fmtMoney(subtotal, monedaDoc)}</span></div>
      <div class="tot-row tot-final"><span>TOTAL</span><span style="font-family:monospace">${fmtMoney(subtotal, monedaDoc)}</span></div>
    </div>

    <!-- FIRMAS -->
    <div class="footer">
      <div>
        <div class="firma-nombre">${oc.representante||'—'}</div>
        <div class="firma-linea">Elaborado por</div>
      </div>
      <div>
        <div class="firma-nombre">&nbsp;</div>
        <div class="firma-linea">Autorizado por</div>
      </div>
    </div>

  </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(()=>win.print(), 600);
}

function closeOCPanel() {
  closeModal('modal-oc-panel');
  currentOCId = null;
}

// ── Asientos contables generados por un pago a proveedor (erp_pagos_oc) ──
// El asiento BANCOS principal enlaza referencia_id -> p.id (ver savePago()).
// En pagos múltiples un solo asiento BANCOS cubre varias filas de
// erp_pagos_oc, así que además se busca por el marcador "Nota ${num_pago}"
// dentro de la descripción (embebido siempre por el sistema, ver savePago()).
// El diferencial cambiario (si aplica) enlaza referencia_id -> factura_id,
// no -> pago, así que se acota además por fecha para no traer diferenciales
// de otros pagos a la misma factura en fechas distintas.
function asientosDePago(p) {
  if (!p) return [];
  const list = (state.asientos||[]).filter(a =>
    a.referencia_id === p.id ||
    (a.diario === 'BANCOS' && p.num_pago && (a.descripcion||'').includes(`Nota ${p.num_pago}`)) ||
    (a.diario === DIARIO_CAMBIARIO && a.referencia_id === p.factura_id && a.fecha === p.fecha)
  );
  return list.sort((x,y) => (x.numero||'').localeCompare(y.numero||''));
}

// Arma el bloque de tabla(s) Cuenta/Descripción/Monto Original/Debe/Haber
// para cada asiento asociado a un pago — mismo formato de columnas que el
// tab "Información Contable" del modal Registrar Pago (renderPagoApuntesPreview).
// Todos los asientos relacionados con una factura de OC: el asiento propio
// de la factura (asientoFacturaCompra, referencia_id -> facturaId — incluye
// también cualquier diferencial cambiario, que también enlaza referencia_id
// -> facturaId) MÁS los asientos de cada uno de sus pagos (vía
// asientosDePago(), que ya sabe encontrar single-mode, multi-mode, etc.).
function asientosDeFactura(facturaId) {
  if (!facturaId) return [];
  const pagos = (state.pagosOC||[]).filter(p => p.factura_id === facturaId);
  const directos = (state.asientos||[]).filter(a => a.referencia_id === facturaId);
  const dePagos   = pagos.flatMap(p => asientosDePago(p));
  const seen = new Set();
  const todos = [...directos, ...dePagos].filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id); return true;
  });
  return todos.sort((x,y) => (x.numero||'').localeCompare(y.numero||''));
}

function _pagoAsientosHTML(p, forPrint) {
  return _asientosTablaHTML(asientosDePago(p), forPrint, 'este pago');
}

function _facturaAsientosHTML(facturaId, forPrint) {
  return _asientosTablaHTML(asientosDeFactura(facturaId), forPrint, 'esta factura');
}

// Tabla Cuenta/Descripción/Monto Original/Debe/Haber por cada asiento —
// mismo formato que el tab "Información Contable" del modal Registrar Pago
// (ver renderPagoApuntesPreview). Reutilizado tanto por el detalle de Nota
// de Pago como por el detalle de Factura OC, y por sus respectivos
// documentos de impresión (forPrint=true usa colores hex fijos en vez de
// variables CSS, ya que la ventana de impresión no carga la hoja de estilos
// de la app).
function _asientosTablaHTML(asientos, forPrint, contexto) {
  if (!asientos.length) {
    return `<div style="padding:${forPrint?'16px 0':'32px 24px'};text-align:center;color:${forPrint?'#9EA4B0':'var(--text3)'};font-size:12px">
      No se encontraron asientos contables asociados a ${contexto||'esto'}.
    </div>`;
  }
  const border = forPrint ? '#E2E4E9' : 'var(--border)';
  const text3  = forPrint ? '#9EA4B0' : 'var(--text3)';
  const text2  = forPrint ? '#5E6470' : 'var(--text2)';
  const accent = forPrint ? '#C84B2F' : 'var(--accent)';
  return asientos.map(a => {
    const lineas = (state.asientoLineas||[]).filter(l => l.asiento_id === a.id);
    const monedaAsi = a.moneda || 'GTQ';
    let totalDebe = 0, totalHaber = 0;
    const filas = lineas.map(l => {
      totalDebe  += Number(l.debe_gtq||0);
      totalHaber += Number(l.haber_gtq||0);
      const montoOriginal = Number(l.monto_orig||0) > 0
        ? Number(l.monto_orig)
        : (Number(l.debe||0) > 0 ? Number(l.debe) : Number(l.haber||0));
      return `<tr style="border-bottom:1px solid ${border}">
        <td style="padding:6px 10px;font-size:11px;font-family:'DM Mono',monospace">${l.cuenta_codigo||'—'} ${l.cuenta_nombre||''}</td>
        <td style="padding:6px 10px;font-size:11px;color:${text3}">${l.descripcion||'—'}</td>
        <td style="padding:6px 10px;text-align:right;font-family:'DM Mono',monospace;font-size:11px">${fmtMoney(montoOriginal, l.moneda_orig||monedaAsi)}</td>
        <td style="padding:6px 10px;text-align:right;font-family:'DM Mono',monospace;font-size:11px">${Number(l.debe||0)>0?fmtGTQ(Number(l.debe||0)):''}</td>
        <td style="padding:6px 10px;text-align:right;font-family:'DM Mono',monospace;font-size:11px">${Number(l.haber||0)>0?fmtGTQ(Number(l.haber||0)):''}</td>
      </tr>`;
    }).join('');
    return `<div style="margin-bottom:18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-size:12px;font-weight:700;font-family:'DM Mono',monospace;color:${accent}">${a.numero||'—'} · ${a.diario||''}</div>
        <div style="font-size:11px;color:${text3}">${fmtDate(a.fecha)}</div>
      </div>
      <div style="font-size:11px;color:${text2};margin-bottom:6px">${a.descripcion||''}</div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="border-bottom:1.5px solid ${border}">
          <th style="padding:6px 10px;text-align:left;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${text3}">Cuenta</th>
          <th style="padding:6px 10px;text-align:left;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${text3}">Descripción</th>
          <th style="padding:6px 10px;text-align:right;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${text3}">Monto Original</th>
          <th style="padding:6px 10px;text-align:right;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${text3}">Debe (GTQ)</th>
          <th style="padding:6px 10px;text-align:right;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${text3}">Haber (GTQ)</th>
        </tr></thead>
        <tbody>${filas}</tbody>
        <tfoot><tr>
          <td colspan="3"></td>
          <td style="padding:6px 10px;text-align:right;font-weight:700;font-size:11px;font-family:'DM Mono',monospace;border-top:1.5px solid ${border}">${fmtMoney(totalDebe,'GTQ')}</td>
          <td style="padding:6px 10px;text-align:right;font-weight:700;font-size:11px;font-family:'DM Mono',monospace;border-top:1.5px solid ${border}">${fmtMoney(totalHaber,'GTQ')}</td>
        </tr></tfoot>
      </table>
    </div>`;
  }).join('');
}

// ── VER PAGO OC (popup de detalle, click en el No. de Nota de Pago) ──
// Overlay dinámico (document.createElement) — los pagos a proveedor viven
// en erp_pagos_oc (state.pagosOC), separado de erp_pagos (cobros de
// clientes).
function verDetallePago(pagoId) {
  const p = (state.pagosOC||[]).find(x => x.id === pagoId);
  if (!p) { toast('Pago no encontrado','error'); return; }
  const f    = (state.ocFacturas||[]).find(x => x.id === p.factura_id);
  const oc   = f ? (state.oc||[]).find(o => o.id === f.oc_id) : null;
  const prov = oc ? (state.proveedores||[]).find(pr => pr.id === oc.proveedor_id) : null;
  const cta  = (state.cuentas||[]).find(c => c.id === p.cuenta_id);
  const formaLabel = { transferencia:'Transferencia Bancaria', cheque:'Cheque', efectivo:'Efectivo', deposito:'Depósito' }[p.forma] || p.forma || '—';

  const html = `
    <div class="modal modal-lg">
      <!-- Header — mismo tamaño (modal-lg, 860px) que el detalle de Factura OC -->
      <div class="modal-header">
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text3);letter-spacing:0.1em;margin-bottom:4px">Nota de Pago</div>
          <div style="font-family:'DM Mono',monospace;font-size:22px;font-weight:700;color:var(--accent)">${p.num_pago||'—'}</div>
          <div style="font-size:13px;color:var(--text2);margin-top:4px">${prov?.name||'—'}${f?` · ${f.serie||''}${f.numero||''}`:''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="imprimirPago('${p.id}')">🖨 Imprimir Pago</button>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
        </div>
      </div>

      <!-- TABS -->
      <div style="display:flex;border-bottom:2px solid var(--border);background:var(--surface2)">
        <button id="vpago-tab-info" onclick="vpagoTab('info')"
          style="padding:10px 18px;font-size:13px;font-weight:600;border:none;background:var(--bg);border-bottom:2px solid var(--accent);color:var(--accent);cursor:pointer;margin-bottom:-2px">
          💰 Información de Pago
        </button>
        <button id="vpago-tab-contable" onclick="vpagoTab('contable')"
          style="padding:10px 18px;font-size:13px;font-weight:600;border:none;background:transparent;color:var(--text3);cursor:pointer;margin-bottom:-2px">
          📊 Información Contable
        </button>
      </div>

      <!-- Ambos tabs se apilan en la misma celda de grid, igual que en el
           modal Registrar Pago, para que la ventana no cambie de tamaño al
           alternar entre tabs. -->
      <div style="display:grid">
      <div id="vpago-panel-info" style="grid-column:1;grid-row:1">
        <!-- Datos -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px 24px;border-bottom:1.5px solid var(--border)">
          <div><span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3)">Fecha</span>
            <div style="font-weight:600">${fmtDate(p.fecha)}</div></div>
          <div><span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3)">Monto</span>
            <div style="font-family:'DM Mono',monospace;font-weight:700;color:var(--green)">${fmtMoney(p.monto, p.moneda||'GTQ')}</div></div>
          <div><span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3)">Forma de Pago</span>
            <div>${formaLabel}</div></div>
          <div><span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3)">Cuenta de Origen</span>
            <div>${cta?.name||'—'}</div></div>
          <div><span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3)">Banco Destino</span>
            <div>${prov?.banco||'—'}</div></div>
          <div><span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3)">Cuenta</span>
            <div style="font-family:'DM Mono',monospace">${prov?.num_cuenta||'—'}</div></div>
          <div><span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3)">Referencia Banco</span>
            <div style="font-family:'DM Mono',monospace">${p.referencia||'—'}</div></div>
          <div><span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3)">Orden de Compra</span>
            <div style="font-family:'DM Mono',monospace">${oc?.numero||'—'}</div></div>
        </div>
        ${p.notas ? `<div style="padding:16px 24px">
          <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3)">Notas</span>
          <div style="font-size:13px;margin-top:4px">${p.notas}</div>
        </div>` : ''}
      </div>
      <div id="vpago-panel-contable" style="grid-column:1;grid-row:1;padding:16px 24px;visibility:hidden">
        ${_pagoAsientosHTML(p, false)}
      </div>
      </div>

      <!-- Footer -->
      <div class="modal-footer">
        ${f ? `<button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove();verFacturaOC('${f.id}')">🧾 Ver Factura</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.modal-overlay').remove()">Cerrar</button>
      </div>
    </div>`;

  // .open es la clase que hace visible un .modal-overlay (la clase base
  // arranca en opacity:0/pointer-events:none — ver openModal()/closeModal()
  // y la regla CSS .modal-overlay.open). Sin agregarla, este overlay se
  // queda invisible aunque sí esté en el DOM — esto es lo que hacía que
  // "no se despliegue la ventana" al hacer click en la Nota de Pago.
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:2000';
  overlay.innerHTML = html;
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

function vpagoTab(tab) {
  document.getElementById('vpago-panel-info').style.visibility     = tab==='info'     ? 'visible' : 'hidden';
  document.getElementById('vpago-panel-contable').style.visibility = tab==='contable' ? 'visible' : 'hidden';
  document.getElementById('vpago-tab-info').style.background       = tab==='info'     ? 'var(--bg)' : 'transparent';
  document.getElementById('vpago-tab-info').style.color            = tab==='info'     ? 'var(--accent)' : 'var(--text3)';
  document.getElementById('vpago-tab-info').style.borderBottom     = tab==='info'     ? '2px solid var(--accent)' : 'none';
  document.getElementById('vpago-tab-contable').style.background   = tab==='contable' ? 'var(--bg)' : 'transparent';
  document.getElementById('vpago-tab-contable').style.color        = tab==='contable' ? 'var(--accent)' : 'var(--text3)';
  document.getElementById('vpago-tab-contable').style.borderBottom = tab==='contable' ? '2px solid var(--accent)' : 'none';
}

// ── IMPRIMIR PAGO — documento con 2 secciones: Información de Pago +
// Información Contable (asientos generados). Mismo patrón que imprimirOC():
// ventana nueva, HTML autocontenido, window.print() automático.
function imprimirPago(pagoId) {
  const p = (state.pagosOC||[]).find(x => x.id === pagoId);
  if (!p) { toast('Pago no encontrado','error'); return; }
  const f    = (state.ocFacturas||[]).find(x => x.id === p.factura_id);
  const oc   = f ? (state.oc||[]).find(o => o.id === f.oc_id) : null;
  const prov = oc ? (state.proveedores||[]).find(pr => pr.id === oc.proveedor_id) : null;
  const cta  = (state.cuentas||[]).find(c => c.id === p.cuenta_id);
  const formaLabel = { transferencia:'Transferencia Bancaria', cheque:'Cheque', efectivo:'Efectivo', deposito:'Depósito' }[p.forma] || p.forma || '—';

  const infoRow = (label, val) => val ? `<div class="info-row"><span class="info-label">${label}</span><span class="info-val">${val}</span></div>` : '';

  const win = window.open('','_blank','width=900,height=700');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8"/>
    <title>Nota de Pago ${p.num_pago||''}</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Inter',sans-serif;font-size:12px;color:#1A1C21;padding:32px;background:#fff}
      .doc-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;padding-bottom:18px;border-bottom:2px solid #101820}
      .brand{font-size:11px;color:#5E6470;margin-top:4px}
      .doc-num{font-size:26px;font-weight:700;color:#C84B2F;font-family:monospace}
      .doc-fecha{font-size:11px;color:#5E6470;text-align:right;margin-top:4px}
      .two-col{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:20px 0}
      .col-title{font-size:9px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;color:#9EA4B0;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #E2E4E9}
      .info-row{display:flex;flex-direction:column;margin-bottom:6px}
      .info-label{font-size:9px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#9EA4B0;margin-bottom:1px}
      .info-val{font-size:12px;font-weight:500;color:#1A1C21}
      .section-title{font-size:9px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;color:#9EA4B0;margin:24px 0 8px;padding-top:16px;border-top:2px solid #101820}
      table{width:100%;border-collapse:collapse;margin-bottom:12px}
      thead th{background:#F4F5F7;padding:6px 10px;text-align:left;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#5E6470;border-bottom:1px solid #E2E4E9}
      tbody td{padding:6px 10px;border-bottom:1px solid #F0F1F3;font-size:11px}
      tbody tr:last-child td{border-bottom:none}
      tfoot td{padding:6px 10px;font-size:11px;font-weight:700;border-top:1.5px solid #E2E4E9}
      .num{text-align:right;font-family:monospace}
      .asiento-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
      .asiento-num{font-size:11px;font-weight:700;font-family:monospace;color:#C84B2F}
      .asiento-fecha{font-size:10px;color:#9EA4B0}
      .asiento-desc{font-size:10px;color:#5E6470;margin-bottom:6px}
      .notas{margin-top:12px;padding:10px 14px;background:#FFFBEB;border-radius:6px;font-size:11px;color:#5E6470}
      @media print{body{padding:16px} @page{margin:12mm}}
    </style>
  </head><body>

    <!-- HEADER -->
    <div class="doc-header">
      <div>
        <h1 style="font-size:20px;font-weight:700">Nota de Pago</h1>
        <div class="brand">TEXTILES CIRCULARES, S.A.</div>
      </div>
      <div style="text-align:right">
        <div class="doc-num">${p.num_pago||'—'}</div>
        <div class="doc-fecha">Fecha de Pago: ${fmtDate(p.fecha)}</div>
      </div>
    </div>

    <!-- SECCIÓN 1: INFORMACIÓN DE PAGO -->
    <div class="section-title" style="border-top:none;padding-top:0;margin-top:16px">Información de Pago</div>
    <div class="two-col">
      <div>
        <div class="col-title">Proveedor</div>
        ${infoRow('Proveedor', prov?.name)}
        ${infoRow('NIT', prov?.nit)}
        ${infoRow('Orden de Compra', oc?.numero)}
        ${infoRow('Factura', f?`${f.serie||''}${f.numero||''}`:null)}
      </div>
      <div>
        <div class="col-title">Detalle del Pago</div>
        ${infoRow('Monto', fmtMoney(p.monto, p.moneda||'GTQ'))}
        ${infoRow('Forma de Pago', formaLabel)}
        ${infoRow('Cuenta de Origen', cta?.name)}
        ${infoRow('Banco Destino', prov?.banco)}
        ${infoRow('Cuenta', prov?.num_cuenta)}
        ${infoRow('Referencia Banco', p.referencia)}
      </div>
    </div>
    ${p.notas ? `<div class="notas"><strong>Notas:</strong> ${p.notas}</div>` : ''}

    <!-- SECCIÓN 2: INFORMACIÓN CONTABLE -->
    <div class="section-title">Información Contable — Asientos Generados</div>
    ${_pagoAsientosHTML(p, true)}

  </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(()=>win.print(), 600);
}

// Proporción real de IVA de una factura de OC — valor_iva/valor_neto de
// erp_compras (el registro que se llenó en Libro de Compras, que sí respeta
// el checkbox de "lleva IVA" de cada línea del formulario). El detalle por
// línea de verFacturaOC()/imprimirFacturaOC() no sabe cuál línea llevó IVA
// (ese checkbox no se persiste por línea, solo el agregado), así que en vez
// de asumir 12% fijo en TODAS las líneas (lo que inflaba el total de líneas
// por encima del Total Factura real en facturas sin IVA, o con IVA parcial),
// se usa esta proporción real — si la factura no lleva IVA, ivaReal es 0 y
// el detalle por línea también muestra 0, coincidiendo con el Total Factura.
// Si no se encuentra el registro de compra (no debería pasar), cae de
// regreso al 12% estándar (IVA_RATE) como antes.
function facturaIvaRatio(facturaId) {
  const compra   = (state.compras||[]).find(c => c.factura_id === facturaId);
  const netoReal = compra ? Number(compra.valor_neto||0) : 0;
  const ivaReal  = compra ? Number(compra.valor_iva||0)  : 0;
  return netoReal > 0 ? (ivaReal / netoReal) : IVA_RATE;
}

// ── VER FACTURA OC (popup de detalle, click en el número de factura) ──
function verFacturaOC(facturaId) {
  const f = (state.ocFacturas||[]).find(x => x.id === facturaId);
  if (!f) return;
  currentVerFacturaOCId = facturaId;
  const oc     = state.oc.find(o => o.id === f.oc_id);
  const prov   = state.proveedores.find(p => p.id === oc?.proveedor_id);
  const pagos  = (state.pagosOC||[]).filter(p => p.factura_id === facturaId);
  const pagado = pagos.reduce((s,p)=>s+Number(p.monto||0),0);
  const total  = Number(f.total||0);
  const saldo  = Math.max(0, total - pagado);
  const esCancelada = f.status === 'cancelada';
  const esPagada  = !esCancelada && saldo <= 0.01;
  const esParcial = !esCancelada && pagado > 0 && !esPagada;
  const statusLabel = esCancelada ? 'Cancelada' : esPagada ? 'Pagada' : esParcial ? 'Pagada Parcialmente' : 'Generada';
  const statusColor = esCancelada ? '#9CA3AF' : esPagada ? '#16A34A' : esParcial ? '#D97706' : '#2563EB'; // gris / verde / naranja / azul
  const monedaOC = getMonedaOC(f.oc_id);
  const tipoMap = { FC:'Factura cambiaria', FE:'Factura especial', FCAM:'Factura cambiaria' };
  const formaLabel = { transferencia:'Transferencia Bancaria', cheque:'Cheque', efectivo:'Efectivo', deposito:'Depósito' };

  // Detalle por línea — fuente: state.ocItems de la OC (el esquema no
  // separa items por factura cuando una OC se factura en partes). El IVA
  // por línea usa la proporción REAL de la
  // factura (facturaIvaRatio — respeta si la factura llevó IVA o no), no un
  // 12% fijo: aplicar 12% a TODAS las líneas inflaba el Total de línea por
  // encima del Total Factura real en facturas sin IVA (o con IVA parcial).
  const ivaRatio = facturaIvaRatio(facturaId);
  const items = (state.ocItems||[]).filter(i => i.oc_id === f.oc_id);
  const itemsHtml = items.map(i => {
    const prod = (state.productos||[]).find(p => p.id === i.producto_id);
    const esServicio = prod?.tipo === 'servicio';
    const qty = esServicio ? Number(i.cantidad||0) : ocRecibidoQty(f.oc_id, i.producto_id);
    const precioUnit = Number(i.precio_unit||0);
    const precioTotal = qty * precioUnit;
    // precioTotal YA incluye IVA (criterio Guatemala) — hay que EXTRAER
    // el neto, no agregar IVA encima. ivaRatio=iva/neto (facturaIvaRatio),
    // total=neto*(1+ivaRatio) -> neto=total/(1+ivaRatio).
    const neto = ivaRatio > 0 ? precioTotal / (1 + ivaRatio) : precioTotal;
    const iva  = precioTotal - neto;
    const lineaTotal = precioTotal;
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px 12px;font-size:13px">${prod?.description||'—'}</td>
      <td style="padding:8px 12px;text-align:right;font-family:'DM Mono',monospace">${qty.toFixed(3)}</td>
      <td style="padding:8px 12px;text-align:right;font-family:'DM Mono',monospace">${fmtMoney(precioUnit, monedaOC)}</td>
      <td style="padding:8px 12px;text-align:right;font-family:'DM Mono',monospace">${fmtMoney(precioTotal, monedaOC)}</td>
      <td style="padding:8px 12px;text-align:right;font-family:'DM Mono',monospace">${fmtMoney(neto, monedaOC)}</td>
      <td style="padding:8px 12px;text-align:right;font-family:'DM Mono',monospace">${fmtMoney(iva, monedaOC)}</td>
      <td style="padding:8px 12px;text-align:right;font-family:'DM Mono',monospace;font-weight:600">${fmtMoney(lineaTotal, monedaOC)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:12px">Sin líneas</td></tr>`;

  document.getElementById('vfoc-title').textContent = f.num_interno || '—';

  // Contenido del tab "Información de Factura" — el mismo layout que ya
  // existía (ribbon de estado, datos, detalle por línea, pagos), ahora
  // dentro de un panel propio para poder alternarlo con el nuevo tab
  // "Información Contable".
  const infoHtml = `
    <!-- Ribbon de estado — entre el título y la primera tabla de información -->
    <div style="padding:10px 16px;border-radius:8px;text-align:center;font-weight:700;font-size:13px;letter-spacing:0.03em;margin-bottom:16px;background:${statusColor};color:#fff">${statusLabel}</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:20px">
      <div style="padding:12px 16px;border-right:1px solid var(--border);border-bottom:1px solid var(--border)">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Serie</div>
        <div style="font-size:16px;font-weight:700;font-family:'DM Mono',monospace">${f.serie||'—'}</div>
      </div>
      <div style="padding:12px 16px;border-bottom:1px solid var(--border)">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Factura</div>
        <div style="font-size:16px;font-weight:700;font-family:'DM Mono',monospace">${f.numero||'—'}</div>
      </div>
      <div style="padding:12px 16px;border-right:1px solid var(--border);border-bottom:1px solid var(--border)">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Proveedor</div>
        <div style="font-size:14px;font-weight:500">${prov?.name||'—'}</div>
      </div>
      <div style="padding:12px 16px;border-bottom:1px solid var(--border)">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Fecha</div>
        <div style="font-size:14px;font-weight:500">${fmtDate(f.fecha)}</div>
      </div>
      <div style="padding:12px 16px;border-right:1px solid var(--border)">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Tipo</div>
        <div style="font-size:13px">${tipoMap[f.tipo]||f.tipo||'—'}</div>
      </div>
      <div style="padding:12px 16px">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Vencimiento</div>
        <div style="font-size:13px">${f.fecha_vencimiento?fmtDate(f.fecha_vencimiento):'—'}</div>
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--border);grid-column:1 / -1">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Orden de Compra</div>
        <div style="font-size:14px;font-weight:500;font-family:'DM Mono',monospace">${oc?.numero||'—'}</div>
      </div>
    </div>

    <div style="font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:8px">Detalle</div>
    <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--surface2)">
          <th style="padding:7px 12px;text-align:left;font-size:11px">Producto</th>
          <th style="padding:7px 12px;text-align:right;font-size:11px">Cantidad</th>
          <th style="padding:7px 12px;text-align:right;font-size:11px">Precio Unitario</th>
          <th style="padding:7px 12px;text-align:right;font-size:11px">Precio Total</th>
          <th style="padding:7px 12px;text-align:right;font-size:11px">Neto</th>
          <th style="padding:7px 12px;text-align:right;font-size:11px">IVA</th>
          <th style="padding:7px 12px;text-align:right;font-size:11px">Total</th>
        </tr></thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:var(--surface2);font-weight:600">
        <span>Total Factura</span>
        <span style="font-family:'DM Mono',monospace;font-size:18px">${fmtMoney(total, monedaOC)}</span>
      </div>
    </div>

    <div style="font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:8px">Pagos</div>
    <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:12px">
      ${pagos.length ? pagos.map(p => {
        const cta = state.cuentas.find(c => c.id === p.cuenta_id);
        return `<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:10px 16px;border-bottom:1px solid var(--border);font-size:13px">
          <div style="color:var(--text2);line-height:1.6">
            <div><strong style="color:var(--text)">Fecha de pago:</strong> ${fmtDate(p.fecha)}</div>
            <div><strong style="color:var(--text)">Banco de origen:</strong> ${cta?.name||'—'}</div>
            <div><strong style="color:var(--text)">Forma de pago:</strong> ${formaLabel[p.forma]||p.forma||'—'}</div>
            <div style="margin-top:6px"><strong style="color:var(--text)">Banco destino:</strong> ${prov?.banco||'—'}${prov?.num_cuenta?' - '+prov.num_cuenta:''}</div>
          </div>
          <span style="font-family:'DM Mono',monospace;font-weight:600;color:var(--green);white-space:nowrap;margin-left:16px">${fmtMoney(p.monto, monedaOC)}</span>
        </div>`;
      }).join('') : '<div style="padding:12px 16px;color:var(--text3);font-size:13px">Sin pagos registrados</div>'}
      <div style="display:flex;justify-content:flex-end;padding:10px 16px;background:var(--surface2);font-size:13px">
        <div style="display:flex;gap:20px">
          <span>Pagado: <strong style="color:var(--green)">${fmtMoney(pagado, monedaOC)}</strong></span>
          <span>Saldo: <strong style="color:${esPagada?'var(--text3)':'var(--accent)'}">${fmtMoney(saldo, monedaOC)}</strong></span>
        </div>
      </div>
    </div>
    ${f.notas ? `<div style="font-size:12px;color:var(--text2)"><strong>Notas:</strong> ${f.notas}</div>` : ''}
  `;

  document.getElementById('vfoc-body').innerHTML = `
    <!-- TABS -->
    <div style="display:flex;border-bottom:2px solid var(--border);background:var(--surface2)">
      <button id="vfoc-tab-info" onclick="vfocTab('info')"
        style="padding:10px 18px;font-size:13px;font-weight:600;border:none;background:var(--bg);border-bottom:2px solid var(--accent);color:var(--accent);cursor:pointer;margin-bottom:-2px">
        📄 Información de Factura
      </button>
      <button id="vfoc-tab-contable" onclick="vfocTab('contable')"
        style="padding:10px 18px;font-size:13px;font-weight:600;border:none;background:transparent;color:var(--text3);cursor:pointer;margin-bottom:-2px">
        📊 Información Contable
      </button>
    </div>

    <!-- Ambos tabs se apilan en la misma celda de grid, igual que en el
         modal Registrar Pago / detalle de Nota de Pago, para que la ventana
         no cambie de tamaño al alternar entre tabs. -->
    <div style="display:grid">
      <div id="vfoc-panel-info" style="grid-column:1;grid-row:1;padding:20px">${infoHtml}</div>
      <div id="vfoc-panel-contable" style="grid-column:1;grid-row:1;padding:20px;visibility:hidden">
        ${_facturaAsientosHTML(facturaId, false)}
      </div>
    </div>
  `;

  // Acciones del footer — mismas reglas que tenía el viewer anterior de
  // Libro de Compras (verDetalleFactura(), ya eliminado), salvo "Editar
  // Factura" que se quitó a pedido del usuario: Cancelar solo si no está
  // cancelada, no está pagada y no tiene pagos registrados; Pagar solo si
  // no está cancelada ni pagada (aunque también hay un botón "Pagar"
  // independiente en el tab Facturas del panel de OC — este es para cuando
  // se llega aquí desde Libro de Compras, que no tiene esa columna).
  document.getElementById('vfoc-footer-actions').innerHTML = `
    ${!esCancelada && !esPagada && pagado<=0 ? `<button class="btn btn-danger btn-sm" onclick="closeModal('modal-ver-factura-oc');cancelarFacturaOC('${facturaId}')">✕ Cancelar Factura</button>` : ''}
    ${!esCancelada && !esPagada ? `<button class="btn btn-primary btn-sm" onclick="closeModal('modal-ver-factura-oc');openPagoOC('${facturaId}')">💳 Pagar Factura</button>` : ''}
  `;

  vfocTab('info');
  openModal('modal-ver-factura-oc');
}

function vfocTab(tab) {
  document.getElementById('vfoc-panel-info').style.visibility     = tab==='info'     ? 'visible' : 'hidden';
  document.getElementById('vfoc-panel-contable').style.visibility = tab==='contable' ? 'visible' : 'hidden';
  document.getElementById('vfoc-tab-info').style.background       = tab==='info'     ? 'var(--bg)' : 'transparent';
  document.getElementById('vfoc-tab-info').style.color            = tab==='info'     ? 'var(--accent)' : 'var(--text3)';
  document.getElementById('vfoc-tab-info').style.borderBottom     = tab==='info'     ? '2px solid var(--accent)' : 'none';
  document.getElementById('vfoc-tab-contable').style.background   = tab==='contable' ? 'var(--bg)' : 'transparent';
  document.getElementById('vfoc-tab-contable').style.color        = tab==='contable' ? 'var(--accent)' : 'var(--text3)';
  document.getElementById('vfoc-tab-contable').style.borderBottom = tab==='contable' ? '2px solid var(--accent)' : 'none';
}

// ── IMPRIMIR FACTURA OC — documento con 2 secciones: Información de
// Factura + Información Contable (asientos generados por la factura y sus
// pagos). Mismo patrón que imprimirOC()/imprimirPago(): ventana nueva, HTML
// autocontenido, window.print() automático.
function imprimirFacturaOC(facturaId) {
  const f = (state.ocFacturas||[]).find(x => x.id === facturaId);
  if (!f) { toast('Factura no encontrada','error'); return; }
  const oc     = state.oc.find(o => o.id === f.oc_id);
  const prov   = state.proveedores.find(p => p.id === oc?.proveedor_id);
  const pagos  = (state.pagosOC||[]).filter(p => p.factura_id === facturaId);
  const pagado = pagos.reduce((s,p)=>s+Number(p.monto||0),0);
  const total  = Number(f.total||0);
  const saldo  = Math.max(0, total - pagado);
  const monedaOC = getMonedaOC(f.oc_id);
  const tipoMap = { FC:'Factura cambiaria', FE:'Factura especial', FCAM:'Factura cambiaria' };
  const formaLabel = { transferencia:'Transferencia Bancaria', cheque:'Cheque', efectivo:'Efectivo', deposito:'Depósito' };

  // Mismo criterio que verFacturaOC(): IVA por línea con la proporción real
  // de la factura (facturaIvaRatio), no un 12% fijo — ver comentario ahí.
  const ivaRatio = facturaIvaRatio(facturaId);
  const items = (state.ocItems||[]).filter(i => i.oc_id === f.oc_id);
  const itemsRows = items.map(i => {
    const prod = (state.productos||[]).find(p => p.id === i.producto_id);
    const esServicio = prod?.tipo === 'servicio';
    const qty = esServicio ? Number(i.cantidad||0) : ocRecibidoQty(f.oc_id, i.producto_id);
    const precioUnit = Number(i.precio_unit||0);
    const precioTotal = qty * precioUnit;
    // precioTotal YA incluye IVA (criterio Guatemala) — hay que EXTRAER
    // el neto, no agregar IVA encima. ivaRatio=iva/neto (facturaIvaRatio),
    // total=neto*(1+ivaRatio) -> neto=total/(1+ivaRatio).
    const neto = ivaRatio > 0 ? precioTotal / (1 + ivaRatio) : precioTotal;
    const iva  = precioTotal - neto;
    const lineaTotal = precioTotal;
    return `<tr>
      <td>${prod?.description||'—'}</td>
      <td class="num">${qty.toFixed(3)}</td>
      <td class="num">${fmtMoney(precioUnit, monedaOC)}</td>
      <td class="num">${fmtMoney(precioTotal, monedaOC)}</td>
      <td class="num">${fmtMoney(neto, monedaOC)}</td>
      <td class="num">${fmtMoney(iva, monedaOC)}</td>
      <td class="num" style="font-weight:600">${fmtMoney(lineaTotal, monedaOC)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" style="text-align:center;color:#9EA4B0">Sin líneas</td></tr>`;

  const pagosRows = pagos.length ? pagos.map(p => {
    const cta = state.cuentas.find(c => c.id === p.cuenta_id);
    return `<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid #F0F1F3;font-size:11px">
      <div style="color:#5E6470;line-height:1.6">
        <div><strong style="color:#1A1C21">Fecha de pago:</strong> ${fmtDate(p.fecha)}</div>
        <div><strong style="color:#1A1C21">Banco de origen:</strong> ${cta?.name||'—'}</div>
        <div><strong style="color:#1A1C21">Forma de pago:</strong> ${formaLabel[p.forma]||p.forma||'—'}</div>
        <div><strong style="color:#1A1C21">Banco destino:</strong> ${prov?.banco||'—'}${prov?.num_cuenta?' - '+prov.num_cuenta:''}</div>
      </div>
      <span style="font-weight:600;color:#16A34A;white-space:nowrap;margin-left:16px">${fmtMoney(p.monto, monedaOC)}</span>
    </div>`;
  }).join('') : '<div style="color:#9EA4B0;font-size:11px">Sin pagos registrados</div>';

  const win = window.open('','_blank','width=900,height=700');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8"/>
    <title>Factura ${f.num_interno||''}</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Inter',sans-serif;font-size:12px;color:#1A1C21;padding:32px;background:#fff}
      .doc-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;padding-bottom:18px;border-bottom:2px solid #101820}
      .brand{font-size:11px;color:#5E6470;margin-top:4px}
      .doc-num{font-size:26px;font-weight:700;color:#C84B2F;font-family:monospace}
      .doc-footer{margin-top:32px;padding-top:12px;border-top:1px solid #E2E4E9;font-size:10px;color:#9EA4B0;text-align:center}
      .two-col{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:20px 0}
      .col-title{font-size:9px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;color:#9EA4B0;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #E2E4E9}
      .info-row{display:flex;flex-direction:column;margin-bottom:6px}
      .info-label{font-size:9px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#9EA4B0;margin-bottom:1px}
      .info-val{font-size:12px;font-weight:500;color:#1A1C21}
      .section-title{font-size:9px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;color:#9EA4B0;margin:24px 0 8px;padding-top:16px;border-top:2px solid #101820}
      table{width:100%;border-collapse:collapse;margin-bottom:12px}
      thead th{background:#F4F5F7;padding:6px 10px;text-align:left;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#5E6470;border-bottom:1px solid #E2E4E9}
      tbody td{padding:6px 10px;border-bottom:1px solid #F0F1F3;font-size:11px}
      tbody tr:last-child td{border-bottom:none}
      .num{text-align:right;font-family:monospace}
      .totals{margin-left:auto;width:280px;border:1px solid #E2E4E9;border-radius:8px;overflow:hidden;margin-bottom:16px}
      .tot-row{display:flex;justify-content:space-between;padding:8px 14px;font-size:12px}
      .tot-row:not(:last-child){border-bottom:1px solid #F0F1F3}
      .tot-final{background:#101820;color:#fff;font-weight:700;font-size:13px}
      .notas{margin-top:12px;padding:10px 14px;background:#FFFBEB;border-radius:6px;font-size:11px;color:#5E6470}
      @media print{body{padding:16px} @page{margin:12mm}}
    </style>
  </head><body>

    <!-- HEADER -->
    <div class="doc-header">
      <div>
        <h1 style="font-size:20px;font-weight:700">Factura ${f.num_interno||''}</h1>
        <div class="brand">TEXTILES CIRCULARES, S.A.</div>
      </div>
      <div style="text-align:right">
        <div class="doc-num">${f.serie||''} - ${f.numero||''}</div>
      </div>
    </div>

    <!-- SECCIÓN 1: INFORMACIÓN DE FACTURA -->
    <div class="section-title" style="border-top:none;padding-top:0;margin-top:16px">Información de Factura</div>
    <div class="two-col">
      <div>
        <div class="col-title">Proveedor / Factura</div>
        <div class="info-row"><span class="info-label">Proveedor</span><span class="info-val">${prov?.name||'—'}</span></div>
        <div class="info-row"><span class="info-label">Tipo</span><span class="info-val">${tipoMap[f.tipo]||f.tipo||'—'}</span></div>
        <div class="info-row"><span class="info-label">Vencimiento</span><span class="info-val">${f.fecha_vencimiento?fmtDate(f.fecha_vencimiento):'—'}</span></div>
        <div class="info-row"><span class="info-label">Orden de Compra</span><span class="info-val">${oc?.numero||'—'}</span></div>
      </div>
      <div>
        <div class="col-title">Pagos</div>
        ${pagosRows}
        <div style="display:flex;justify-content:flex-end;gap:16px;margin-top:8px;font-size:11px">
          <span>Pagado: <strong style="color:#16A34A">${fmtMoney(pagado, monedaOC)}</strong></span>
          <span>Saldo: <strong>${fmtMoney(saldo, monedaOC)}</strong></span>
        </div>
      </div>
    </div>

    <table>
      <thead><tr>
        <th>Producto</th><th class="num">Cantidad</th><th class="num">Precio Unit.</th>
        <th class="num">Precio Total</th><th class="num">Neto</th><th class="num">IVA</th><th class="num">Total</th>
      </tr></thead>
      <tbody>${itemsRows}</tbody>
    </table>
    <div class="totals">
      <div class="tot-row tot-final"><span>TOTAL FACTURA</span><span style="font-family:monospace">${fmtMoney(total, monedaOC)}</span></div>
    </div>
    ${f.notas ? `<div class="notas"><strong>Notas:</strong> ${f.notas}</div>` : ''}

    <!-- SECCIÓN 2: INFORMACIÓN CONTABLE -->
    <div class="section-title">Información Contable — Asientos Generados</div>
    ${_facturaAsientosHTML(facturaId, true)}

    <div class="doc-footer">Documento generado el ${fmtDate(f.fecha)}</div>

  </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(()=>win.print(), 600);
}

// ── DEVOLUCIONES — devolucionesRECDeOC (de Recepción de OC) (index.html original: líneas 18218-18230) ──
// (COMPRAS)
// Devoluciones tipo REC (de Recepción de OC) ligadas a una OC específica.
function devolucionesRECDeOC(ocId) {
  const recIds = (state.ocRecepciones||[]).filter(r => r.oc_id === ocId).map(r => r.id);
  const items = (state.ocRecepcionItems||[]).filter(x =>
    x.estado === 'devuelto' && x.numero_devolucion && recIds.includes(x.recepcion_id));
  const numeros = [...new Set(items.map(x => x.numero_devolucion))];
  return numeros.map(num => {
    const rows = items.filter(x => x.numero_devolucion === num);
    const mov  = (state.movimientos||[]).find(m => m.referencia_tipo==='DEV-OC' && m.referencia_id===num);
    return { numero: num, origen: 'REC', fecha: mov?.fecha || null, rows };
  });
}

// ── OC — renderOCPanel, SC lines, OC lines, CRUD de SC y OC (openNewOC/editOC) (index.html original: líneas 18528-19085) ──
function renderOCPanel(ocId) {
  const items = state.ocItems.filter(i=>i.oc_id===ocId);
  // Lines
  document.getElementById('oc-panel-lines').innerHTML = items.map(i=>{
    const prod      = state.productos.find(p => p.id === i.producto_id);
    const esServicioItem = prod?.tipo === 'servicio';
    const recibido  = ocRecibidoQty(ocId, i.producto_id);
    const pedido    = Number(i.cantidad||0);
    const pendiente = Math.max(0, pedido - recibido);
    const moneda    = i.moneda || 'GTQ';
    const totalOrig = Number(i.total_orig||0) || pedido * Number(i.precio_unit||0);
    // Los servicios no se reciben físicamente — no aplica Pedido/Recibido/Pendiente
    return `<tr>
      <td>${prodName(i.producto_id)}${esServicioItem?' <span class="badge badge-blue" style="margin-left:6px;font-size:10px">Servicio</span>':''}</td>
      <td class="td-mono" style="text-align:right">${esServicioItem?'—':`${pedido.toFixed(3)} ${i.unidad||''}`}</td>
      <td class="td-mono" style="text-align:right;color:var(--green)">${esServicioItem?'—':recibido.toFixed(3)}</td>
      <td class="td-mono" style="text-align:right;color:${pendiente>0?'var(--accent)':'var(--text3)'}">${esServicioItem?'—':pendiente.toFixed(3)}</td>
      <td class="td-mono" style="text-align:right">${fmtMoney(i.precio_unit, moneda)}</td>
      <td class="td-mono" style="text-align:right;font-weight:600">${fmtMoney(totalOrig, moneda)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:12px">Sin líneas</td></tr>';

  // Recepciones — one row per recepcion, lotes in cascade
  const recs = state.ocRecepciones.filter(r=>r.oc_id===ocId);
  const STATUS_REC_COLOR = { borrador:'badge-gray', en_proceso:'badge-yellow', completada:'badge-green', cancelada:'badge-red' };
  const STATUS_REC_LABEL = { borrador:'Borrador', en_proceso:'En Proceso', completada:'Completada', cancelada:'Cancelada' };
  document.getElementById('oc-panel-recepciones').innerHTML = recs.length ? recs.map(r=>{
    const ri      = state.ocRecepcionItems.filter(x=>x.recepcion_id===r.id);
    const lotes   = [...new Set(ri.map(x=>x.lote).filter(Boolean))];
    const plCajas = (state.plCajas||[]).filter(c=>c.recepcion_id===r.id);
    const pendientes = plCajas.filter(c=>c.estado==='pendiente').length;
    const totalKg  = ri.reduce((s,x)=>s+Number(x.cantidad||0),0);

    // El No. de Packing List se ingresa por lote (no por recepción completa),
    // así que se muestra en la línea del lote — no en la línea principal.
    const loteRows = lotes.map(lote=>{
      const lineas = ri.filter(x=>x.lote===lote);
      const qty    = lineas.reduce((s,x)=>s+Number(x.cantidad||0),0);
      return `<tr style="background:var(--surface)">
        <td style="padding:4px 12px 4px 28px;font-size:11px;color:var(--text3)">↳</td>
        <td style="font-size:11px;padding:4px 8px">${fmtDate(r.fecha)}</td>
        <td class="td-mono" style="font-size:11px;color:var(--accent);padding:4px 8px">${lote}</td>
        <td style="font-size:11px;padding:4px 8px">${prodName(lineas[0]?.producto_id)}</td>
        <td style="font-size:11px;padding:4px 8px">${lineas[0]?.packing_num||'—'}</td>
        <td class="td-mono" style="font-size:11px;padding:4px 8px">${qty.toFixed(3)} ${lineas[0]?.unidad||''}</td>
      </tr>`;
    }).join('');

    const pendRow = pendientes>0 && lotes.length===0 ? `<tr style="background:var(--surface)">
      <td colspan="6" style="padding:4px 12px 4px 28px;font-size:11px;color:#D97706;font-style:italic">
        📦 ${pendientes} cajas de PL pendientes de confirmar
      </td></tr>` : '';

    return `<tr style="cursor:pointer" onclick="abrirRecepcion('${r.id}')">
      <td class="td-mono" style="font-size:12px;font-weight:700;color:var(--accent)">${r.numero||'—'}</td>
      <td style="font-size:12px">${fmtDate(r.fecha)}</td>
      <td class="td-mono" style="font-size:11px;color:var(--accent3)">${r.envio_numero||'—'}</td>
      <td style="font-size:11px">—</td>
      <td class="td-mono" style="font-size:12px">${totalKg>0?totalKg.toFixed(3)+' kg':'—'}</td>
      <td><span class="badge ${STATUS_REC_COLOR[r.status]||'badge-gray'}">${STATUS_REC_LABEL[r.status]||r.status}</span></td>
    </tr>${loteRows}${pendRow}`;
  }).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:12px">Sin recepciones</td></tr>';

  // Facturas
  const facts = state.ocFacturas.filter(f=>f.oc_id===ocId);
  const monedaOCFacturas = getMonedaOC(ocId);
  document.getElementById('oc-panel-facturas').innerHTML = facts.map(f=>{
    const pagosF  = (state.pagosOC||[]).filter(p=>p.factura_id===f.id);
    const pagado   = pagosF.reduce((s,p)=>s+Number(p.monto||0),0);
    const saldo    = Math.max(0, Number(f.total||0) - pagado);
    const esPagada = saldo <= 0.01;
    const esParcial = pagado > 0 && !esPagada;
    // FIX (30/Ago/2026, reportado en vivo): esta lista nunca miraba f.status,
    // así que una factura CANCELADA seguía mostrándose como "Generada" y con
    // su botón de Pagar activo — se podía pagar una factura anulada.
    // El estado cancelado manda sobre el de pago.
    const esCancelada = f.status === 'cancelada';
    const statusLabel = esCancelada ? 'Cancelada' : esPagada ? 'Pagada' : esParcial ? 'Pagada Parcialmente' : 'Generada';
    const statusColor = esCancelada ? 'badge-red' : esPagada ? 'badge-green' : esParcial ? 'badge-yellow' : 'badge-blue';
    return `<tr style="${esCancelada?'opacity:0.55':esPagada?'opacity:0.75':''}">
      <td class="td-mono" style="font-size:11px;color:var(--accent);cursor:pointer;text-decoration:underline${esCancelada?';text-decoration-line:line-through underline':''}" onclick="verFacturaOC('${f.id}')">${f.num_interno||'—'}</td>
      <td class="td-mono">${f.serie||'—'}${f.numero||'—'}</td>
      <td>${fmtDate(f.fecha)}</td>
      <td class="td-mono">${fmtMoney(f.total, monedaOCFacturas)}</td>
      <td class="td-mono" style="color:var(--green)">${pagado>0
        ? (pagosF.filter(p=>p.num_pago).map(p=>`<span style="cursor:pointer;text-decoration:underline" onclick="verDetallePago('${p.id}')" title="Ver detalle del pago">${p.num_pago}</span>`).join(', ') || fmtMoney(pagado, monedaOCFacturas))
        : '—'}</td>
      <td class="td-mono" style="color:${esCancelada||esPagada?'var(--text3)':'var(--accent)'};font-weight:${esPagada||esCancelada?'400':'700'}">${esCancelada||esPagada?'—':fmtMoney(saldo, monedaOCFacturas)}</td>
      <td><span class="badge ${statusColor}">${statusLabel}</span></td>
      <td>${esCancelada
        ? `<span style="font-size:11px;color:var(--text3)">—</span>`
        : !esPagada
          ? `<button class="btn btn-sm btn-primary" onclick="openPagoOC('${f.id}')">💳 Pagar</button>`
          : `<span style="font-size:11px;color:var(--green)">✓ Completada</span>`
      }</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:12px">Sin facturas</td></tr>';

  // Reabastecimientos — agrupados por numero (REA-YYYY-NNNN): cada
  // confirmación de asignación de lotes (una por insumo, ver
  // confirmarAsignacionLotes) inserta varias filas de erp_reabastecimiento
  // que comparten el mismo numero — se agrupan acá en una sola fila
  // clickeable, igual patrón que Recepciones agrupa por lote.
  const reabsOC = (state.reabastecimiento||[]).filter(r=>r.oc_id===ocId && r.numero);
  const reabNumeros = [...new Set(reabsOC.map(r=>r.numero))];
  document.getElementById('oc-panel-reabastecimientos').innerHTML = reabNumeros.map(num=>{
    const rows = reabsOC.filter(r=>r.numero===num);
    const totalCant = rows.reduce((s,r)=>s+Number(r.cantidad||0),0);
    const totalDevuelto = rows.reduce((s,r)=>s+cantidadDevueltaReab(r.id),0);
    const badge = totalDevuelto <= 0.0001 ? ''
      : totalDevuelto >= totalCant - 0.0001 ? ' <span style="color:#DC2626;font-weight:600">↩️ devuelto</span>'
      : ' <span style="color:#D97706;font-weight:600">↩️ devuelto parcial</span>';
    return `<tr style="cursor:pointer" onclick="verReabastecimiento('${num}')">
      <td class="td-mono" style="font-size:12px;font-weight:700;color:var(--accent)">${num}${badge}</td>
      <td style="font-size:12px">${fmtDate(rows[0]?.fecha)}</td>
      <td style="font-size:12px">${prodName(rows[0]?.insumo_id)}</td>
      <td class="td-mono" style="text-align:right;font-size:12px;font-weight:600">${totalCant.toFixed(3)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:12px">Sin reabastecimientos</td></tr>';

  // Devoluciones — junta REC (Recepción) + REA (Reabastecimiento).
  const devsOC = [...devolucionesRECDeOC(ocId), ...devolucionesREADe('oc', ocId)];
  document.getElementById('oc-panel-devoluciones').innerHTML = devsOC.length
    ? devsOC.map(d => `<tr style="cursor:pointer" onclick="verDevolucion('${d.numero}')">
        <td class="td-mono" style="font-size:12px;font-weight:700;color:var(--accent)">${d.numero}</td>
        <td style="font-size:12px">${d.origen}</td>
        <td style="font-size:12px">${d.fecha ? fmtDate(d.fecha) : '—'}</td>
      </tr>`).join('')
    : '<tr><td colspan="3" style="text-align:center;color:var(--text3);padding:12px">Sin devoluciones</td></tr>';
}

// ── SC LINES ──
let scLineCount=0;
function addSCLine(prod_id='',cantidad=0,precio=0) {
  scLineCount++;
  const id='scl_'+scLineCount;
  const opts=state.productos.filter(p=>p.puede_comprado!==false).map(p=>`<option value="${p.id}" data-unidad="${p.unidad||''}" data-precio="${(p.proveedores_compra||[])[0]?.precio||0}" data-moneda="${(p.proveedores_compra||[])[0]?.moneda||''}">${p.code||'?'} — ${p.description}</option>`).join('');
  const tr=document.createElement('tr'); tr.id=id;
  tr.innerHTML=`
    <td><select onchange="scLineProdChange(this,'${id}')" style="width:100%;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px">
      <option value="">— Seleccionar —</option>${opts}</select></td>
    <td><input type="number" step="0.001" min="0" placeholder="0" value="${cantidad||''}" oninput="calcSCTotal()" style="width:80px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px"/></td>
    <td><input type="text" id="${id}_unidad" value="" readonly style="width:70px;padding:5px 8px;background:var(--surface2);border:1.5px solid var(--border);border-radius:6px;font-size:12px"/></td>
    <td><input type="number" step="0.01" min="0" placeholder="0.00" value="${precio||''}" oninput="calcSCTotal()" style="width:90px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px"/></td>
    <td id="${id}_moneda" style="min-width:52px"></td>
    <td class="td-mono" id="${id}_tot">$0.00</td>
    <td><button class="btn btn-sm btn-danger" onclick="document.getElementById('${id}').remove();calcSCTotal()">✕</button></td>`;
  document.getElementById('sc-lines').appendChild(tr);
  if (prod_id) { tr.querySelector('select').value=prod_id; scLineProdChange(tr.querySelector('select'),id,precio); }
  calcSCTotal();
}
function scLineProdChange(sel,rowId,overridePrice) {
  const opt=sel.options[sel.selectedIndex];
  const row=document.getElementById(rowId);
  if (!row) return;
  const inputs=row.querySelectorAll('input[type=number]');
  document.getElementById(rowId+'_unidad').value=opt.getAttribute('data-unidad')||'';
  if (!overridePrice) inputs[1].value=opt.getAttribute('data-precio')||'';
  const provId=document.getElementById('sc-proveedor')?.value;
  const {moneda,fuente}=resolveMoneda(provId,sel.value,'compra');
  const mc=document.getElementById(rowId+'_moneda');
  if (mc) mc.innerHTML=monedaTag(moneda,fuente);
  calcSCTotal();
}
function calcSCTotal() {
  let total=0;
  document.querySelectorAll('#sc-lines tr').forEach(tr=>{
    const inputs=tr.querySelectorAll('input[type=number]');
    if (inputs.length<2) return;
    const t=Number(inputs[0].value||0)*Number(inputs[1].value||0);
    const cell=document.getElementById(tr.id+'_tot');
    if (cell) cell.textContent=fmtMoney(t);
    total+=t;
  });
  const el=document.getElementById('sc-total');
  if (el) el.textContent=fmtMoney(total);
}
function getSCLines() {
  const lines=[];
  document.querySelectorAll('#sc-lines tr').forEach(tr=>{
    const sel=tr.querySelector('select');
    const inputs=tr.querySelectorAll('input[type=number]');
    if (!sel?.value) return;
    lines.push({producto_id:sel.value,cantidad:parseFloat(inputs[0].value)||0,
      unidad:document.getElementById(tr.id+'_unidad')?.value||'',
      precio_est:parseFloat(inputs[1].value)||0});
  });
  return lines;
}

// ── OC LINES ──
let ocLineCount=0;
// Solo productos que el proveedor tiene asignados en su lista de compra
// (prod.proveedores_compra) — antes se mostraban TODOS los productos del
// catálogo sin importar el proveedor seleccionado en la OC.
function ocProductoOptsForProveedor(provId, selectedId='') {
  const productos = state.productos.filter(p => {
    if (p.puede_comprado === false) return false;
    if (!provId) return true; // sin proveedor elegido aún: no filtrar
    return (p.proveedores_compra||[]).some(l => l.proveedor_id === provId);
  });
  const opts = productos.map(p => {
    const lineaProv = (p.proveedores_compra||[]).find(l => l.proveedor_id === provId) || (p.proveedores_compra||[])[0];
    return `<option value="${p.id}" data-unidad="${p.unidad||''}" data-precio="${lineaProv?.precio||0}" data-moneda="${lineaProv?.moneda||''}">${p.codigo_interno||p.code||'?'} — ${p.description}</option>`;
  }).join('');
  return `<option value="">— Seleccionar —</option>${opts}`;
}

function addOCLine(prod_id='',cantidad=0,precio=0,unidad='') {
  ocLineCount++;
  const id='ocl_'+ocLineCount;
  const provId = document.getElementById('oc-proveedor')?.value || '';
  const tr=document.createElement('tr'); tr.id=id;
  let opts = ocProductoOptsForProveedor(provId);
  // Si se está cargando una línea ya guardada (editar OC) y su producto no
  // está en la lista de compra del proveedor actual (ej. se desasignó
  // después de crear la OC), se agrega igual — para no ocultar silenciosamente
  // un producto ya comprado, solo se filtra al AGREGAR líneas nuevas.
  if (prod_id && !opts.includes(`value="${prod_id}"`)) {
    const p = state.productos.find(x => x.id === prod_id);
    if (p) {
      const lineaProv = (p.proveedores_compra||[]).find(l => l.proveedor_id === provId) || (p.proveedores_compra||[])[0];
      opts += `<option value="${p.id}" data-unidad="${p.unidad||''}" data-precio="${lineaProv?.precio||0}" data-moneda="${lineaProv?.moneda||''}">⚠ ${p.codigo_interno||p.code||'?'} — ${p.description} (no asignado a este proveedor)</option>`;
    }
  }
  tr.innerHTML=`
    <td><select onchange="ocLineProdChange(this,'${id}')" style="width:100%;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px">
      ${opts}</select></td>
    <td><input type="number" step="0.001" min="0" placeholder="0" value="${cantidad||''}" oninput="calcOCTotal()" style="width:80px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px"/></td>
    <td><input type="text" id="${id}_unidad" value="${unidad||''}" style="width:70px;padding:5px 8px;background:var(--surface2);border:1.5px solid var(--border);border-radius:6px;font-size:12px" readonly/></td>
    <td><input type="number" step="0.01" min="0" placeholder="0.00" value="${precio||''}" oninput="calcOCTotal()" style="width:90px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px"/></td>
    <td id="${id}_moneda" style="min-width:52px"></td>
    <td class="td-mono" id="${id}_tot">$0.00</td>
    <td><button class="btn btn-sm btn-danger" onclick="document.getElementById('${id}').remove();calcOCTotal()">✕</button></td>`;
  document.getElementById('oc-lines').appendChild(tr);
  if (prod_id) { tr.querySelector('select').value=prod_id; ocLineProdChange(tr.querySelector('select'),id,precio); }
  calcOCTotal();
}
function ocLineProdChange(sel, rowId, overridePrice) {
  const opt    = sel.options[sel.selectedIndex];
  const row    = document.getElementById(rowId);
  if (!row) return;
  const prodId = sel.value;
  const provId = document.getElementById('oc-proveedor')?.value;

  // Unit
  document.getElementById(rowId+'_unidad').value = opt.getAttribute('data-unidad')||'';

  if (!overridePrice) {
    let precio = 0;
    let moneda = 'GTQ';

    if (prodId && provId) {
      const prod = state.productos.find(p => p.id === prodId);
      const provLine = (prod?.proveedores_compra||[]).find(l => l.proveedor_id === provId);
      if (provLine) {
        precio = Number(provLine.precio||0);
        moneda = provLine.moneda || 'GTQ';
      } else if ((prod?.proveedores_compra||[])[0]) {
        precio = Number(prod.proveedores_compra[0].precio||0);
        moneda = prod.proveedores_compra[0].moneda || 'GTQ';
      }
    }

    // ── Validar moneda consistente en la OC ──────────────────
    const otrasLineas = document.querySelectorAll('#oc-lines tr');
    for (const tr of otrasLineas) {
      if (tr.id === rowId) continue;
      const monedaOtra = tr.dataset.moneda;
      if (monedaOtra && monedaOtra !== moneda) {
        toast('No puede haber múltiples monedas en la misma Orden de Compra. Todas las líneas deben tener la misma moneda.', 'error');
        sel.value = '';
        document.getElementById(rowId+'_unidad').value = '';
        const mc = document.getElementById(rowId+'_moneda');
        if (mc) mc.innerHTML = '';
        return;
      }
    }

    // Set price input
    const precioInput = row.querySelector(`input[id="${rowId}_precio"]`) ||
                        row.querySelectorAll('input[type=number]')[1];
    if (precioInput) precioInput.value = precio || '';

    // Set moneda display and store on row
    const mc = document.getElementById(rowId+'_moneda');
    if (mc) mc.innerHTML = monedaTag(moneda, moneda === 'GTQ' ? 'default' : 'producto');
    if (row) row.dataset.moneda = moneda;
  }

  calcOCTotal();
}
function calcOCTotal() {
  let total = 0;
  let monedaGlobal = null;
  const provId = document.getElementById('oc-proveedor')?.value;

  document.querySelectorAll('#oc-lines tr').forEach(tr => {
    const inputs = tr.querySelectorAll('input[type=number]');
    const sel    = tr.querySelector('select');
    if (inputs.length < 2) return;

    const qty    = Number(inputs[0].value||0);
    const precio = Number(inputs[1].value||0);
    const t      = qty * precio;

    // Get moneda for this line
    let moneda = tr.dataset.moneda || 'GTQ';
    if (!tr.dataset.moneda && sel?.value && provId) {
      const prod = state.productos.find(p => p.id === sel.value);
      const provLine = (prod?.proveedores_compra||[]).find(l => l.proveedor_id === provId);
      moneda = provLine?.moneda || prod?.proveedores_compra?.[0]?.moneda || 'GTQ';
    }
    if (!monedaGlobal) monedaGlobal = moneda;

    const cell = document.getElementById(tr.id+'_tot');
    if (cell) cell.textContent = fmtMoney(t, moneda);
    total += t;
  });

  const el = document.getElementById('oc-total');
  if (el) el.textContent = fmtMoney(total, monedaGlobal||'GTQ');
}
function getOCLines() {
  const lines  = [];
  const provId = document.getElementById('oc-proveedor')?.value;

  document.querySelectorAll('#oc-lines tr').forEach(tr => {
    const sel    = tr.querySelector('select');
    const inputs = tr.querySelectorAll('input[type=number]');
    if (!sel?.value) return;

    const prodId      = sel.value;
    const cantidad    = parseFloat(inputs[0]?.value)||0;
    const precio_unit = parseFloat(inputs[1]?.value)||0;

    // Moneda from proveedores_compra entry
    let moneda = tr.dataset.moneda || 'GTQ';
    if (!tr.dataset.moneda && prodId && provId) {
      const prod     = state.productos.find(p => p.id === prodId);
      const provLine = (prod?.proveedores_compra||[]).find(l => l.proveedor_id === provId);
      moneda = provLine?.moneda || prod?.proveedores_compra?.[0]?.moneda || 'GTQ';
    }

    const total_orig          = parseFloat((cantidad * precio_unit).toFixed(4));
    const tc                  = tcHoy() || 1;
    const precio_unit_contable = moneda === 'USD'
      ? parseFloat((precio_unit * tc).toFixed(4))
      : precio_unit;
    const total_contable      = parseFloat((cantidad * precio_unit_contable).toFixed(4));

    lines.push({
      producto_id:          prodId,
      cantidad,
      unidad:               document.getElementById(tr.id+'_unidad')?.value||'',
      precio_unit,
      moneda,
      tc,
      precio_unit_contable,
      total_orig,
      total_contable,
    });
  });
  return lines;
}

// ── SC CRUD ──
function populateProvSelect(selId,selectedId='') {
  const opts=state.proveedores.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  const el=document.getElementById(selId);
  if (el) { el.innerHTML='<option value="">— Seleccionar —</option>'+opts; if (selectedId) el.value=selectedId; }
}

async function openNewSC() {
  document.getElementById('sc-id').value='';
  document.getElementById('sc-num').value=nextCorrelativo('SC',state.sc,'numero');
  document.getElementById('sc-fecha').value=today();
  document.getElementById('sc-entrega').value='';
  document.getElementById('sc-status').value='borrador';
  document.getElementById('sc-notas').value='';
  document.getElementById('sc-lines').innerHTML='';
  scLineCount=0;
  populateProvSelect('sc-proveedor');
  document.getElementById('modal-sc-title').textContent='Nueva Solicitud de Cotización';
  addSCLine();
  openModal('modal-sc');
}

async function editSC(id) {
  const s=state.sc.find(x=>x.id===id);
  document.getElementById('sc-id').value=s.id;
  document.getElementById('sc-num').value=s.numero||'';
  // FIX (29/Ago/2026): ver nota en fact-date — <input type="date"> exige ISO.
  document.getElementById('sc-fecha').value  = (s.fecha||'').split('T')[0];
  document.getElementById('sc-entrega').value= (s.entrega||'').split('T')[0];
  document.getElementById('sc-status').value=s.status||'borrador';
  document.getElementById('sc-notas').value=s.notas||'';
  document.getElementById('sc-lines').innerHTML='';
  scLineCount=0;
  populateProvSelect('sc-proveedor',s.proveedor_id);
  document.getElementById('modal-sc-title').textContent='Editar SC';
  state.scItems.filter(i=>i.sc_id===id).forEach(i=>addSCLine(i.producto_id,i.cantidad,i.precio_est));
  openModal('modal-sc');
}

async function saveSC(confirm=false) {
  const id=document.getElementById('sc-id').value;
  const proveedor_id=document.getElementById('sc-proveedor').value;
  const fecha=document.getElementById('sc-fecha').value;
  if (!proveedor_id||!fecha) { toast('Proveedor y fecha son requeridos','error'); return; }
  const lines=getSCLines();
  if (!lines.length) { toast('Agrega al menos un producto','error'); return; }
  const numero=document.getElementById('sc-num').value;
  const row={
    numero, proveedor_id, fecha,
    entrega:document.getElementById('sc-entrega').value||null,
    status:confirm?'confirmada':document.getElementById('sc-status').value,
    notas:document.getElementById('sc-notas').value.trim(),
  };
  let scId=id, err;
  if (id) {
    ({error:err}=await sb.from('erp_sc').update(row).eq('id',id));
    if (!err) await sb.from('erp_sc_items').delete().eq('sc_id',id);
  } else {
    const {data,error}=await sb.from('erp_sc').insert(row).select().single();
    if (error) { toast('Error: '+error.message,'error'); return; }
    scId=data.id;
  }
  if (err) { toast('Error: '+err.message,'error'); return; }
  await sb.from('erp_sc_items').insert(lines.map(l=>({...l,sc_id:scId})));
  toast(confirm?'SC confirmada':'SC guardada');
  closeModal('modal-sc');
  await loadAll();
  return scId;
}

async function confirmarSC() {
  const scId=await saveSC(true);
  if (scId) await generarOCdesdeSC(scId);
}

async function confirmarSCById(id) {
  if (!confirm('¿Confirmar esta SC y generar Orden de Compra?')) return;
  const {error}=await sb.from('erp_sc').update({status:'confirmada'}).eq('id',id);
  if (error) { toast('Error: '+error.message,'error'); return; }
  await loadAll();
  await generarOCdesdeSC(id);
}

async function generarOCdesdeSC(scId) {
  const sc=state.sc.find(x=>x.id===scId)||
    (await sb.from('erp_sc').select('*').eq('id',scId).single()).data;
  const scItems=state.scItems.filter(i=>i.sc_id===scId).length
    ? state.scItems.filter(i=>i.sc_id===scId)
    : (await sb.from('erp_sc_items').select('*').eq('sc_id',scId)).data||[];
  // Create OC
  const numero=nextCorrelativo('OC',state.oc,'numero');
  const {data:ocData,error}=await sb.from('erp_oc').insert({
    numero, proveedor_id:sc.proveedor_id, fecha:today(),
    entrega:sc.entrega||null, sc_id:scId, status:'confirmada', notas:sc.notas||'',
  }).select().single();
  if (error) { toast('Error generando OC: '+error.message,'error'); return; }
  await sb.from('erp_oc_items').insert(scItems.map(i=>({
    oc_id:ocData.id, producto_id:i.producto_id,
    cantidad:i.cantidad, unidad:i.unidad, precio_unit:i.precio_est||0,
  })));
  await loadAll();
  toast(`OC generada: ${numero}`);
  showPage('oc');
  showOCPanel(ocData.id);
}

async function deleteSC(id) {
  if (!confirm('¿Eliminar esta solicitud?')) return;
  await sb.from('erp_sc_items').delete().eq('sc_id',id);
  const {error}=await sb.from('erp_sc').delete().eq('id',id);
  if (error) { toast('Error: '+error.message,'error'); return; }
  toast('SC eliminada');
  await loadAll();
}

// ── OC CRUD ──
async function openNewOC() {
  document.getElementById('oc-id').value='';
  // BUGFIX/CAMBIO DE DISEÑO (13/Ago/2026, a pedido explícito): antes se
  // asignaba un número real (nextCorrelativo) apenas se abría el modal —
  // así, un borrador abandonado sin guardar igual "quemaba" un número. El
  // número real ahora se asigna recién en confirmarOC(), nunca antes.
  document.getElementById('oc-num').value='';
  document.getElementById('oc-fecha').value=today();
  document.getElementById('oc-entrega').value='';
  document.getElementById('oc-status').value='borrador';
  document.getElementById('oc-notas').value='';
  document.getElementById('oc-representante').value = window._currentUser?.email?.split('@')[0] || window._currentUser?.email || '';
  document.getElementById('oc-sc-ref').value='';
  document.getElementById('oc-lines').innerHTML='';
  document.getElementById('oc-moneda') && (document.getElementById('oc-moneda').value = '');
  ocLineCount=0;
  populateProvSelect('oc-proveedor');
  populateBodegaSelect('oc-bodega');
  document.getElementById('oc-terminos').value = '';
  document.getElementById('oc-incoterms').innerHTML = incotermsOpts();
  document.getElementById('modal-oc-title').textContent='Nueva Orden de Compra';
  addOCLine();
  openModal('modal-oc');
}

async function editOC(id) {
  const o = state.oc.find(x=>x.id===id);
  document.getElementById('oc-id').value     = o.id;
  document.getElementById('oc-num').value    = o.numero||'';
  document.getElementById('oc-fecha').value  = o.fecha ? fmtDate(o.fecha) : today();
  // FIX (29/Ago/2026): acá se hacía `= fmtDate(o.entrega)`, que devuelve
  // "26/Sep/2026". Un <input type="date"> solo acepta YYYY-MM-DD, así que el
  // navegador RECHAZABA el valor y el campo quedaba vacío. Al guardar,
  // saveOC lee ese campo vacío y escribe entrega=null — borrando la fecha
  // que planificarSubcontrato había heredado de la OV. Por eso la OC de
  // tintura aparecía sin entrega estimada pese a que el motor sí la ponía.
  // Mismo bug que tenía editPedido con ped-date (corregido el 26/Ago).
  document.getElementById('oc-entrega').value = (o.entrega||'').split('T')[0];
  document.getElementById('oc-status').value = o.status||'borrador';
  document.getElementById('oc-notas').value  = o.notas||'';
  document.getElementById('oc-representante').value = o.representante || window._currentUser?.email?.split('@')[0] || '';
  // CAMBIO (20/Ago/2026, a pedido explícito — "allí debes colocar siempre
  // la referencia de la orden que la solicitó"): antes este campo solo
  // mostraba la Solicitud de Compra (erp_sc) formal — que es un flujo
  // aparte y poco usado. Ahora, si la OC no viene de una SC, también
  // revisa erp_oc.op_id (la OP que la generó vía el motor de rutas) para
  // mostrar SIEMPRE la referencia real de origen, sea SC u OP.
  // 21/Ago/2026, a pedido explícito: agregado erp_oc.oc_id — cuando el
  // origen es OTRA OC (ej. OC de tejido subcontratado que generó esta OC
  // de compra de hilo), antes solo quedaba en notas como texto libre, sin
  // poder mostrarse aquí. Si la OC de origen sigue en borrador (sin
  // número asignado todavía), se muestra el id corto como referencia.
  const sc = state.sc.find(x=>x.id===o.sc_id);
  const opOrigenOC = state.op.find(x=>x.id===o.op_id);
  const ocOrigenOC = state.oc.find(x=>x.id===o.oc_id);
  // La OV se agregó como origen posible (29/Ago/2026, a pedido explícito):
  // una OC de servicio de subcontrato nace directamente de una orden de venta
  // vía el asistente de planificación, pero este campo solo sabía resolver
  // SC, OP y OC — así que en esas OC el Origen se veía VACÍO pese a tener
  // ov_id guardado. Se consulta al final para no cambiar la precedencia de
  // los orígenes que ya funcionaban.
  const ovOrigenOC = state.pedidos.find(x=>x.id===o.ov_id);
  document.getElementById('oc-sc-ref').value = sc ? sc.numero
    : (opOrigenOC ? opOrigenOC.numero
    : (ocOrigenOC ? (ocOrigenOC.numero || `OC-borrador-${ocOrigenOC.id.slice(0,8)}`)
    : (ovOrigenOC ? ovLabel(ovOrigenOC) : '')));
  document.getElementById('oc-lines').innerHTML='';
  ocLineCount=0;
  populateProvSelect('oc-proveedor', o.proveedor_id);
  populateBodegaSelect('oc-bodega', o.bodega_id);
  document.getElementById('oc-terminos').value = o.terminos_pago||'';
  document.getElementById('oc-incoterms').innerHTML = incotermsOpts(o.incoterms||'');
  document.getElementById('modal-oc-title').textContent='Editar OC';
  state.ocItems.filter(i=>i.oc_id===id).forEach(i=>addOCLine(i.producto_id,i.cantidad,i.precio_unit,i.unidad));
  openModal('modal-oc');
}

// ── OC — Packing List (Hilo), scan de recepción, devoluciones de recepción, saveOC, recepciones (guardar/ver/imprimir) (index.html original: líneas 19111-20504) ──
// ── PL CAJAS (Packing List detail for Hilo) ─────────────────────
let _plCajaCount = 0;

function onPLFileSelected() {
  const files = document.getElementById('pl-scan-file').files;
  if (!files.length) return;
  const names = Array.from(files).map(f=>f.name).join(', ');
  document.getElementById('pl-scan-file-name').textContent = names;
}

async function escanearPL() {
  const files = document.getElementById('pl-scan-file').files;
  if (!files.length) { toast('Selecciona un archivo PDF o imagen primero','error'); return; }

  const btn    = document.getElementById('btn-escanear-pl');
  const status = document.getElementById('pl-scan-status');
  btn.disabled = true;
  btn.textContent = '⏳ Analizando...';
  status.style.display = 'block';
  status.textContent = 'Leyendo documento...';

  try {
    // Convert files to base64
    const fileContents = await Promise.all(Array.from(files).map(f => new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res({ name: f.name, type: f.type, data: reader.result.split(',')[1] });
      reader.onerror = rej;
      reader.readAsDataURL(f);
    })));

    status.textContent = 'Extrayendo texto del documento...';

    let fullText = '';
    for (const f of Array.from(files)) {
      if (f.type === 'application/pdf') {
        const arrayBuffer = await f.arrayBuffer();
        const pdfjsLib = window['pdfjs-dist/build/pdf'];
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        status.textContent = `PDF cargado — ${pdf.numPages} páginas. Extrayendo texto...`;
        for (let p = 1; p <= pdf.numPages; p++) {
          const page    = await pdf.getPage(p);
          const content = await page.getTextContent();
          fullText += content.items.map(i => i.str).join(' ') + '\n';
        }
      } else {
        fullText += `[IMAGEN: ${f.name}]`;
      }
    }

    status.textContent = 'Enviando a Claude Haiku (una sola llamada)...';

    const prompt = `Eres un experto extrayendo datos de Packing Lists de KEER AMERICA CORPORATION.

El texto del documento es:
${fullText}

Las columnas del detalle SIEMPRE aparecen en este orden fijo:
ITEM | PROD_NAME | TYPE | PCK# | NET_WEIGHT | GROSS_WEIGHT | Lot number | Pkgs qty | Date Packed | Week Number

Los pesos vienen en LBS. Conviértelos a KG dividiendo entre 2.20462 (3 decimales).

Extrae en JSON exactamente así:
{
  "no_invoice": "Contract NO",
  "no_packing_list": "Packing List NO",
  "no_po": "PO solo dígitos",
  "lotes": [
    {
      "lote": "Lot number exacto",
      "cajas": [
        {
          "no_caja": "PCK# exacto",
          "conos": 36,
          "peso_neto_lbs": 251.26,
          "peso_bruto_lbs": 264.93,
          "peso_neto_kg": 113.970,
          "peso_bruto_kg": 120.167,
          "semana": 48
        }
      ]
    }
  ]
}

Agrupa las cajas por "Lot number". Incluye TODAS las cajas del documento.
Responde SOLO con el JSON, sin texto adicional, sin backticks.`;

    const response = await fetch('https://textilescirculares.netlify.app/.netlify/functions/claude-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content?.find(b => b.type === 'text')?.text || data.content?.[0]?.text || '';
    if (!text) throw new Error('Respuesta vacía. Status: ' + response.status + '\n' + JSON.stringify(data).substring(0,200));

    status.textContent = 'Procesando respuesta...';

    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g,'').trim());
    } catch {
      throw new Error('No se pudo interpretar la respuesta:\n' + text.substring(0,300));
    }

    const lotesArray = parsed.lotes || [];
    if (!lotesArray.length) throw new Error('No se encontraron cajas en el documento.');

        // Fill header fields
    if (parsed.no_invoice)      document.getElementById('pl-envio-input').value    = parsed.no_invoice;
    if (parsed.no_packing_list) document.getElementById('pl-packing-input').value  = parsed.no_packing_list;
    if (parsed.no_po)           document.getElementById('pl-po-input').value        = parsed.no_po;

    // Handle multi-lote structure
    if (parsed.lotes?.length) {
      document.getElementById('pl-cajas-tbody').innerHTML = '';
      _plCajaCount = 0;

      if (parsed.lotes.length === 1) {
        // Single lote — fill normally
        const lote = parsed.lotes[0];
        document.getElementById('pl-lote-input').value = lote.lote || '';
        for (const caja of lote.cajas) {
          addPLCaja();
          const n = _plCajaCount;
          document.getElementById(`pl-caja-${n}-num`).value    = caja.no_caja || n;
          document.getElementById(`pl-caja-${n}-conos`).value  = caja.conos || '';
          document.getElementById(`pl-caja-${n}-pb`).value     = caja.peso_bruto_kg?.toFixed(3) || '';
          document.getElementById(`pl-caja-${n}-pn`).value     = caja.peso_neto_kg?.toFixed(3) || '';
          document.getElementById(`pl-caja-${n}-pn-lbs`).value = caja.peso_neto_lbs?.toFixed(2) || (caja.peso_neto_kg ? (caja.peso_neto_kg * 2.20462).toFixed(2) : '');
          document.getElementById(`pl-caja-${n}-semana`).value = caja.semana || '';
          document.getElementById(`pl-caja-${n}-lote`).value   = lote.lote || '';
        }
      } else {
        // Multiple lotes — show alert and fill first lote, offer tabs
        const totalCajas = parsed.lotes.reduce((s,l)=>s+l.cajas.length,0);
        document.getElementById('pl-lote-input').value = parsed.lotes.map(l=>l.lote).join(', ');
        // Store all lotes data for multi-lote handling
        document.getElementById('pl-scan-area').dataset.lotesData = JSON.stringify(parsed.lotes);
        renderPLMultiLote(parsed.lotes);
      }

      calcPLTotales();
    }

    // Sync to main card
    const prodId = document.getElementById('pl-producto-id').value;
    if (parsed.no_packing_list) { const el = document.getElementById(`rec-packing-${prodId}`); if(el) el.value = parsed.no_packing_list; }
    if (parsed.no_po)           { const el = document.getElementById(`rec-envio-header`);       if(el) el.value = parsed.no_po; }

    const totalCajasExtraidas = parsed.lotes?.reduce((s,l)=>s+l.cajas.length,0) || 0;
    status.textContent = `✓ ${totalCajasExtraidas} cajas extraídas — ${parsed.lotes?.length||0} lote(s)`;
    status.style.color = '#16A34A';
    toast(`PL escaneado — ${totalCajasExtraidas} cajas, ${parsed.lotes?.length||0} lote(s)`);

  } catch(err) {
    status.textContent = '✗ Error: ' + err.message;
    status.style.color = '#DC2626';
    alert('Error al escanear PL:\n' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 Escanear PL';
  }
}

function renderPLMultiLote(lotes) {
  // Show info banner
  const area = document.getElementById('pl-scan-area');
  const existing = document.getElementById('pl-multilote-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'pl-multilote-banner';
  banner.style.cssText = 'margin-top:10px;padding:10px 14px;background:#FFFBEB;border:1.5px solid #F59E0B;border-radius:8px;font-size:12px;color:#92400E';
  banner.innerHTML = `⚠️ Este PL tiene <strong>${lotes.length} lotes diferentes</strong>. Se generará una tarjeta de recepción por lote. Lotes: ${lotes.map(l=>`<strong>${l.lote}</strong> (${l.cajas.length} cajas)`).join(' · ')}`;
  area.appendChild(banner);

  // Fill table with all cajas from all lotes, grouped by lote
  document.getElementById('pl-cajas-tbody').innerHTML = '';
  _plCajaCount = 0;
  for (const lote of lotes) {
    for (const caja of lote.cajas) {
      addPLCaja();
      const n = _plCajaCount;
      document.getElementById(`pl-caja-${n}-num`).value    = caja.no_caja || '';
      document.getElementById(`pl-caja-${n}-lote`).value   = lote.lote || '';
      document.getElementById(`pl-caja-${n}-conos`).value  = caja.conos || '';
      document.getElementById(`pl-caja-${n}-pb`).value     = caja.peso_bruto_kg?.toFixed(3) || '';
      document.getElementById(`pl-caja-${n}-pn`).value     = caja.peso_neto_kg?.toFixed(3) || '';
      document.getElementById(`pl-caja-${n}-pn-lbs`).value = caja.peso_neto_lbs?.toFixed(2) || (caja.peso_neto_kg ? (caja.peso_neto_kg * 2.20462).toFixed(2) : '');
      document.getElementById(`pl-caja-${n}-semana`).value = caja.semana || '';
    }
  }
  calcPLTotales();
}

// Store PL draft data in memory (keyed by productoId)
const _plDraftData = {};

async function guardarPLBorrador() {
  const productoId = document.getElementById('pl-producto-id').value;
  const ocId       = document.getElementById('rec-oc-id')?.value;
  const fecha      = document.getElementById('rec-fecha')?.value || today();
  const bodega_id  = document.getElementById('rec-bodega')?.value || null;
  const cajas      = [];

  document.querySelectorAll('#pl-cajas-tbody tr').forEach(tr => {
    const n  = tr.id.replace('pl-caja-row-','');
    const pn = parseFloat(document.getElementById(`pl-caja-${n}-pn`)?.value)||0;
    const pb = parseFloat(document.getElementById(`pl-caja-${n}-pb`)?.value)||0;
    const co = parseFloat(document.getElementById(`pl-caja-${n}-conos`)?.value)||0;
    if (pn > 0 || co > 0) {
      cajas.push({
        no_caja:  document.getElementById(`pl-caja-${n}-num`)?.value || String(n),
        lote:     document.getElementById(`pl-caja-${n}-lote`)?.value || '',
        conos:    co, pb, pn,
        pn_lbs:   parseFloat(document.getElementById(`pl-caja-${n}-pn-lbs`)?.value)||parseFloat((pn*2.20462).toFixed(2)),
        pb_lbs:   parseFloat(document.getElementById(`pl-caja-${n}-pb-lbs`)?.value)||parseFloat((pb*2.20462).toFixed(2)),
        semana:   parseInt(document.getElementById(`pl-caja-${n}-semana`)?.value)||null,
        recibido: document.getElementById(`pl-caja-${n}-recibido`)?.checked || false,
        rowId:    n,
      });
    }
  });

  if (!cajas.length) { toast('Ingresa al menos una caja','error'); return; }

  const packing_num = document.getElementById('pl-packing-input').value.trim();
  const poliza      = document.getElementById('pl-poliza-input').value.trim();
  const no_invoice  = document.getElementById('pl-envio-input').value.trim();

  // Group cajas by lote
  const porLote = {};
  for (const c of cajas) {
    const k = c.lote || '(sin lote)';
    if (!porLote[k]) porLote[k] = [];
    porLote[k].push(c);
  }

  const lotes = Object.entries(porLote);
  const multiLote = lotes.length > 1;

  try {
    // Delete existing pending cajas for this producto/OC
    await sb.from('erp_oc_pl')
      .delete()
      .eq('oc_id', ocId)
      .eq('producto_id', productoId)
      .eq('estado', 'pendiente');

    let totalRecCreadas = 0;

    for (const [lote, cajasLote] of lotes) {
      // Check if already have an en_proceso recepcion for this lote
      const existingRec = (state.ocRecepciones||[]).find(r =>
        r.oc_id === ocId &&
        r.status === 'en_proceso' &&
        r.lote === lote
      );

      let recepcionId, numero;
      if (existingRec) {
        recepcionId = existingRec.id;
        numero      = existingRec.numero;
      } else {
        numero = await nextRecepcionNum();
        // Add offset for multi-lote to avoid collision
        if (totalRecCreadas > 0) {
          const base = parseInt(numero.slice(-4));
          numero = numero.slice(0,-4) + String(base + totalRecCreadas).padStart(4,'0');
        }
        const { data: newRec, error: eRec } = await sb.from('erp_oc_recepciones').insert({
          oc_id: ocId,
          numero,
          fecha,
          status:    'en_proceso',
          bodega_id: bodega_id || null,
          lote,
          packing_num,
          envio_numero: no_invoice,
        }).select().single();
        if (eRec) { alert(`Error creando recepción lote ${lote}:\n${eRec.message}`); return; }
        recepcionId = newRec.id;
        totalRecCreadas++;
      }

      // Save cajas for this lote
      const cajasRows = cajasLote.map(c => ({
        recepcion_id:   recepcionId,
        oc_id:          ocId || null,
        producto_id:    productoId,
        fecha,
        packing_num,
        lote:           c.lote || lote,
        poliza,
        no_caja:        c.no_caja,
        conos:          c.conos,
        peso_bruto:     c.pb,
        peso_neto:      c.pn,
        peso_neto_lbs:  c.pn_lbs || null,
        peso_bruto_lbs: c.pb_lbs || null,
        semana:         c.semana,
        estado:         'pendiente',
      }));

      const { error: ePL } = await sb.from('erp_oc_pl').insert(cajasRows);
      if (ePL) { alert(`Error guardando cajas lote ${lote}:\n${ePL.message}`); return; }
    }

  } catch(e) {
    alert('Error inesperado:\n' + e.message); return;
  }

  // Update memory
  _plDraftData[productoId] = { packing_num, poliza, no_invoice, cajas };

  // Sync to main card
  if (packing_num) { const el = document.getElementById(`rec-packing-${productoId}`); if(el) el.value = packing_num; }
  if (poliza)      { const el = document.getElementById(`rec-poliza-${productoId}`);  if(el) el.value = poliza; }

  await loadAll();
  updatePLBadge(productoId, cajas.length, 0);
  document.getElementById('btn-confirmar-recepcion-pl').style.display = '';

  const msg = lotes.length > 1
    ? `✓ PL guardado — ${lotes.length} recepciones creadas (una por lote)`
    : `✓ PL guardado — ${cajas.length} cajas · Recepción "En Proceso" creada`;
  toast(msg);
}

async function confirmarRecepcionPL() {
  const productoId = document.getElementById('pl-producto-id').value;
  const ocId       = document.getElementById('rec-oc-id')?.value;

  // Read current checkbox states
  const cajas = [];
  document.querySelectorAll('#pl-cajas-tbody tr').forEach(tr => {
    const n        = tr.id.replace('pl-caja-row-','');
    const pn       = parseFloat(document.getElementById(`pl-caja-${n}-pn`)?.value)||0;
    const pb       = parseFloat(document.getElementById(`pl-caja-${n}-pb`)?.value)||0;
    const co       = parseFloat(document.getElementById(`pl-caja-${n}-conos`)?.value)||0;
    const recibido = document.getElementById(`pl-caja-${n}-recibido`)?.checked || false;
    const dbId     = tr.dataset.dbId || null;
    if (pn > 0 || co > 0) cajas.push({ n, pn, pb, co, recibido, dbId,
      no_caja: document.getElementById(`pl-caja-${n}-num`)?.value || n,
      lote:    document.getElementById(`pl-caja-${n}-lote`)?.value || '',
      semana:  parseInt(document.getElementById(`pl-caja-${n}-semana`)?.value)||null,
    });
  });

  const recibidas   = cajas.filter(c => c.recibido);
  const noRecibidas = cajas.filter(c => !c.recibido);
  const totalPN     = recibidas.reduce((s,c)=>s+c.pn, 0);
  const totalConos  = recibidas.reduce((s,c)=>s+c.co, 0);

  if (!recibidas.length) { toast('Marca al menos una caja como recibida','error'); return; }

  if (noRecibidas.length > 0) {
    const ok = confirm(`⚠️ ${noRecibidas.length} caja(s) sin confirmar quedarán como NO RECIBIDAS y no podrán confirmarse después.\n\n¿Continuar?`);
    if (!ok) return;
  }

  // Update estados in DB
  for (const c of cajas) {
    if (c.dbId) {
      await sb.from('erp_oc_pl').update({ estado: c.recibido ? 'recibido' : 'no_recibido' }).eq('id', c.dbId);
    }
  }

  // Store for saveRecepcion
  _plDraftData[productoId] = { ...(  _plDraftData[productoId]||{}), cajas,
    confirmado: true, recibidas, noRecibidas };

  const btn = document.querySelector(`button[onclick="openPLModal('${productoId}')"]`);
  if (btn) btn.dataset.plCajas = JSON.stringify(cajas.map(c=>({
    no_caja: c.no_caja, lote: c.lote, conos: c.co,
    pb: c.pb, pn: c.pn, semana: c.semana, recibido: c.recibido,
  })));

  // Auto-fill Recibir Ahora per lote from PL data
  const lotesEnPL = {};
  cajas.forEach(c => {
    if (!c.recibido) return;
    const loteKey = c.lote || '';
    if (!lotesEnPL[loteKey]) lotesEnPL[loteKey] = 0;
    lotesEnPL[loteKey] += c.pn;
  });

  // Fill each lote row that matches
  document.querySelectorAll('[id^="rec-lote-val-"]').forEach(el => {
    const n     = el.id.replace('rec-lote-val-','');
    const lote  = el.value.trim();
    const prod  = el.dataset.prod;
    const pn    = lotesEnPL[lote] || 0;
    if (pn > 0) {
      const qtyEl = document.getElementById(`rec-qty-${prod}-${n}`);
      if (qtyEl) qtyEl.value = pn.toFixed(3);
      // La columna "Del PL" que mostraba este subtotal por lote se eliminó
      // del row (renderRecLoteRow) a pedido del usuario — "Recibir Ahora"
      // (arriba) ya se autocompleta con este mismo valor.
    }
  });

  calcRecVerificacion();

  // Render PL cascade in section 3
  renderPLCascadeSection3(cajas, productoId);

  // Update summary badge
  const resumen = document.getElementById(`pl-resumen-${productoId}`);
  if (resumen) resumen.textContent = `${recibidas.length} cajas · ${totalPN.toFixed(3)} kg recibidas${noRecibidas.length>0?' · '+noRecibidas.length+' no recibidas':''}`;
  closeModal('modal-pl-cajas');
  toast(`✓ ${recibidas.length} cajas recibidas · ${totalPN.toFixed(3)} kg${noRecibidas.length>0?' · '+noRecibidas.length+' no recibidas':''}`);
}

// (22/Ago/2026, barrida de sistema): existía un confirmPL() duplicado acá
// — un delegador de una línea que llamaba a confirmarRecepcionPL(). Nunca
// se ejecutaba en producción (la declaración real, más abajo, siempre
// ganaba por redeclaración) y ningún onclick="" lo llamaba por su propio
// nombre — se eliminó. Al convertir el script a type="module" (Fase 1 de
// modularización), esta duplicación pasó de ser inofensiva a un
// SyntaxError fatal ("Identifier 'confirmPL' has already been declared"),
// porque los módulos de JS no permiten redeclarar el mismo identificador
// en el mismo scope, a diferencia del script clásico anterior.

function updatePLBadge(productoId, totalCajas, recibidas) {
  const resumen = document.getElementById(`pl-resumen-${productoId}`);
  if (!resumen) return;
  const pendientes = totalCajas - recibidas;
  if (pendientes > 0) {
    resumen.innerHTML = `<span style="background:#FEF3C7;color:#D97706;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700">📦 ${pendientes} cajas pendientes</span>`;
  } else if (totalCajas > 0) {
    resumen.innerHTML = `<span style="background:#DCFCE7;color:#16A34A;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700">✓ ${totalCajas} cajas confirmadas</span>`;
  }
}

async function verPLModal(productoId) {
  // Same as openPLModal but forces load from DB
  const ocId = document.getElementById('rec-oc-id')?.value;
  const existingCajas = (state.plCajas||[]).filter(c =>
    c.producto_id === productoId &&
    c.oc_id === ocId &&
    (c.estado === 'pendiente' || c.estado === 'recibido')
  );

  if (!existingCajas.length) {
    toast('No hay PL guardado para este producto','error');
    return;
  }

  // Open modal and load
  await openPLModal(productoId);
}

async function openPLModal(productoId) {
  const prod = state.productos.find(p=>p.id===productoId);
  const ocId = document.getElementById('rec-oc-id')?.value;

  document.getElementById('pl-producto-id').value  = productoId;
  document.getElementById('pl-rec-prod-id').value  = productoId;
  document.getElementById('pl-cajas-sub').textContent = (prod?.codigo_interno||prod?.code||'') + ' — ' + (prod?.description||'');

  // Pre-fill from main card
  document.getElementById('pl-packing-input').value = document.getElementById(`rec-packing-${productoId}`)?.value || '';
  document.getElementById('pl-lote-input').value    = document.getElementById(`rec-lote-${productoId}`)?.value || '';
  document.getElementById('pl-poliza-input').value  = document.getElementById(`rec-poliza-${productoId}`)?.value || '';
  document.getElementById('pl-envio-input').value   = document.getElementById('rec-envio-header')?.value || '';

  // Reset scan area
  document.getElementById('pl-scan-file').value = '';
  document.getElementById('pl-scan-file-name').textContent = 'Ningún archivo seleccionado';
  document.getElementById('pl-scan-status').style.display = 'none';
  document.getElementById('pl-scan-status').style.color = '#7C3AED';

  // Load existing pending cajas from DB
  document.getElementById('pl-cajas-tbody').innerHTML = '';
  _plCajaCount = 0;

  const existingCajas = (state.plCajas||[]).filter(c =>
    c.producto_id === productoId &&
    c.oc_id === ocId &&
    c.estado === 'pendiente'
  );

  if (existingCajas.length > 0) {
    // Load from DB
    document.getElementById('pl-packing-input').value = existingCajas[0].packing_num || '';
    document.getElementById('pl-lote-input').value    = existingCajas[0].lote || '';
    document.getElementById('pl-poliza-input').value  = existingCajas[0].poliza || '';

    for (const caja of existingCajas.sort((a,b) => (a.no_caja||'').localeCompare(b.no_caja||''))) {
      addPLCaja();
      const n = _plCajaCount;
      document.getElementById(`pl-caja-${n}-num`).value    = caja.no_caja || '';
      document.getElementById(`pl-caja-${n}-lote`).value   = caja.lote || '';
      document.getElementById(`pl-caja-${n}-conos`).value  = caja.conos || '';
      document.getElementById(`pl-caja-${n}-pb`).value     = caja.peso_bruto || '';
      document.getElementById(`pl-caja-${n}-pn`).value     = caja.peso_neto || '';
      document.getElementById(`pl-caja-${n}-pn-lbs`).value = caja.peso_neto_lbs || (caja.peso_neto ? (caja.peso_neto * 2.20462).toFixed(2) : '');
      document.getElementById(`pl-caja-${n}-semana`).value = caja.semana || '';
      // Store DB id for update
      document.getElementById(`pl-caja-row-${n}`).dataset.dbId = caja.id;
    }

    document.getElementById('btn-confirmar-recepcion-pl').style.display = '';
    toast(`PL cargado — ${existingCajas.length} cajas pendientes`,'info');
  } else {
    addPLCaja();
    document.getElementById('btn-confirmar-recepcion-pl').style.display = 'none';
  }

  calcPLTotales();
  openModal('modal-pl-cajas');
}

function closePLModal() {
  closeModal('modal-pl-cajas');
}

function addPLCaja() {
  _plCajaCount++;
  const n = _plCajaCount;
  const row = document.createElement('tr');
  row.id = `pl-caja-row-${n}`;
  row.style.borderBottom = '1px solid var(--border)';
  row.innerHTML = `
    <td style="padding:5px 8px;text-align:center;font-size:11px;color:var(--text3)">${n}</td>
    <td style="padding:5px 8px">
      <input type="text" id="pl-caja-${n}-num" placeholder="PCK#"
        style="padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-family:'DM Mono',monospace;font-size:12px;font-weight:600;width:100%;text-align:center"/>
    </td>
    <td style="padding:5px 8px">
      <input type="text" id="pl-caja-${n}-lote" placeholder="Lote"
        style="padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-family:'DM Mono',monospace;font-size:11px;width:100%"/>
    </td>
    <td style="padding:5px 8px">
      <input type="number" id="pl-caja-${n}-conos" step="1" min="0" placeholder="0"
        oninput="calcPLTotales()"
        style="padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-family:'DM Mono',monospace;font-size:12px;width:100%;text-align:right"/>
    </td>
    <td style="padding:5px 8px">
      <input type="number" id="pl-caja-${n}-pb" step="0.001" min="0" placeholder="0.000"
        oninput="calcPLTotales()"
        style="padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-family:'DM Mono',monospace;font-size:12px;width:100%;text-align:right"/>
    </td>
    <td style="padding:5px 8px">
      <input type="number" id="pl-caja-${n}-pn" step="0.001" min="0" placeholder="0.000"
        oninput="calcPLTotales();calcPLLbs(${n})"
        style="padding:4px 6px;border:1.5px solid var(--accent);border-radius:6px;font-family:'DM Mono',monospace;font-size:12px;font-weight:600;width:100%;text-align:right;color:var(--accent)"/>
    </td>
    <td style="padding:5px 8px">
      <input type="number" id="pl-caja-${n}-pn-lbs" step="0.01" min="0" placeholder="0.00"
        oninput="calcPLLbsToKg(${n})"
        style="padding:4px 6px;border:1.5px solid #F59E0B;border-radius:6px;font-family:'DM Mono',monospace;font-size:12px;font-weight:600;width:100%;text-align:right;color:#D97706"/>
    </td>
    <td style="padding:5px 8px">
      <input type="number" id="pl-caja-${n}-semana" step="1" min="1" placeholder="—"
        style="padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-family:'DM Mono',monospace;font-size:12px;width:100%;text-align:center"/>
    </td>
    <td style="padding:5px 8px;text-align:center">
      <label style="display:flex;align-items:center;justify-content:center;cursor:pointer">
        <input type="checkbox" id="pl-caja-${n}-recibido" onchange="calcPLTotales();onPLCajaCheck(${n})"
          style="width:18px;height:18px;cursor:pointer;accent-color:var(--green)"/>
      </label>
    </td>
    <td style="padding:5px 8px;text-align:center">
      <button onclick="removePLCaja(${n})" class="btn btn-sm btn-danger" style="padding:2px 6px">✕</button>
    </td>`;
  document.getElementById('pl-cajas-tbody').appendChild(row);
  calcPLTotales();
}

function removePLCaja(n) {
  document.getElementById(`pl-caja-row-${n}`)?.remove();
  calcPLTotales();
}

function calcPLLbs(n) {
  // KG → LBS auto-calc
  const kg  = parseFloat(document.getElementById(`pl-caja-${n}-pn`)?.value)||0;
  const lbs = document.getElementById(`pl-caja-${n}-pn-lbs`);
  if (lbs && kg > 0) lbs.value = (kg * 2.20462).toFixed(2);
}

function calcPLLbsToKg(n) {
  // LBS → KG auto-calc
  const lbs = parseFloat(document.getElementById(`pl-caja-${n}-pn-lbs`)?.value)||0;
  const kg  = document.getElementById(`pl-caja-${n}-pn`);
  if (kg && lbs > 0) { kg.value = (lbs / 2.20462).toFixed(3); calcPLTotales(); }
}

function onPLCajaCheck(n) {
  const checked = document.getElementById(`pl-caja-${n}-recibido`)?.checked;
  const row = document.getElementById(`pl-caja-row-${n}`);
  if (row) {
    row.style.background = checked ? 'var(--green-bg,#F0FDF4)' : '';
    row.style.opacity    = checked ? '1' : '0.7';
  }
}

function calcPLTotales() {
  let totalCajas=0, totalConos=0, totalPB=0, totalPN=0;
  let recCajas=0, recConos=0, recPN=0;

  document.querySelectorAll('#pl-cajas-tbody tr').forEach(tr => {
    const n       = tr.id.replace('pl-caja-row-','');
    const conos   = parseFloat(document.getElementById(`pl-caja-${n}-conos`)?.value)||0;
    const pb      = parseFloat(document.getElementById(`pl-caja-${n}-pb`)?.value)||0;
    const pn      = parseFloat(document.getElementById(`pl-caja-${n}-pn`)?.value)||0;
    const checked = document.getElementById(`pl-caja-${n}-recibido`)?.checked;
    if (pn > 0 || conos > 0) {
      totalCajas++; totalConos += conos; totalPB += pb; totalPN += pn;
    }
    if (checked && pn > 0) { recCajas++; recConos += conos; recPN += pn; }
  });

  document.getElementById('pl-tot-cajas').textContent = `${recCajas} / ${totalCajas}`;
  document.getElementById('pl-tot-conos').textContent = `${recConos.toLocaleString('es-GT')} / ${totalConos.toLocaleString('es-GT')}`;
  document.getElementById('pl-tot-pb').textContent    = totalPB.toFixed(3) + ' kg';
  document.getElementById('pl-tot-pn').textContent    = recPN.toFixed(3) + ' / ' + totalPN.toFixed(3) + ' kg';
}

function confirmPL() {
  const productoId = document.getElementById('pl-producto-id').value;
  let totalPN = 0;
  let totalCajas = 0, totalConos = 0, totalPB = 0;

  document.querySelectorAll('#pl-cajas-tbody tr').forEach(tr => {
    const n  = tr.id.replace('pl-caja-row-','');
    const pn = parseFloat(document.getElementById(`pl-caja-${n}-pn`)?.value)||0;
    const pb = parseFloat(document.getElementById(`pl-caja-${n}-pb`)?.value)||0;
    const co = parseFloat(document.getElementById(`pl-caja-${n}-conos`)?.value)||0;
    const recibido = document.getElementById(`pl-caja-${n}-recibido`)?.checked || false;
    if (pn > 0) {
      totalCajas++;
      totalPB += pb;
      totalConos += co;
      if (recibido) { totalPN += pn; }
    }
  });

  if (totalPN <= 0) { toast('Marca al menos una caja como recibida','error'); return; }

  // Sync header fields back to main card
  const packingVal = document.getElementById('pl-packing-input').value.trim();
  const loteVal    = document.getElementById('pl-lote-input').value.trim();
  const polizaVal  = document.getElementById('pl-poliza-input').value.trim();
  if (packingVal) { const el = document.getElementById(`rec-packing-${productoId}`); if(el) el.value = packingVal; }
  if (loteVal)    { const el = document.getElementById(`rec-lote-${productoId}`);    if(el) el.value = loteVal; }
  if (polizaVal)  { const el = document.getElementById(`rec-poliza-${productoId}`);  if(el) el.value = polizaVal; }

  // Auto-fill Recibir Ahora
  const qtyEl = document.getElementById(`rec-qty-${productoId}`);
  if (qtyEl) { qtyEl.value = totalPN.toFixed(3); calcRecTotales(); }

  // Show summary next to button
  const resumen = document.getElementById(`pl-resumen-${productoId}`);
  if (resumen) resumen.textContent = `${totalCajas} cajas · ${totalConos} conos · ${totalPN.toFixed(3)} kg neto`;

  // Store PL data on the element for saveRecepcion to use
  const btn = document.querySelector(`button[onclick="openPLModal('${productoId}')"]`);
  if (btn) {
    btn.dataset.plCajas    = JSON.stringify(
      Array.from(document.querySelectorAll('#pl-cajas-tbody tr')).map(tr => {
        const n = tr.id.replace('pl-caja-row-','');
        return {
          no_caja:  document.getElementById(`pl-caja-${n}-num`)?.value || n,
          lote:     document.getElementById(`pl-caja-${n}-lote`)?.value || '',
          conos:    parseFloat(document.getElementById(`pl-caja-${n}-conos`)?.value)||0,
          pb:       parseFloat(document.getElementById(`pl-caja-${n}-pb`)?.value)||0,
          pn:       parseFloat(document.getElementById(`pl-caja-${n}-pn`)?.value)||0,
          semana:   parseInt(document.getElementById(`pl-caja-${n}-semana`)?.value)||null,
          recibido: document.getElementById(`pl-caja-${n}-recibido`)?.checked || false,
        };
      }).filter(c => c.pn > 0)
    );
  }

  closeModal('modal-pl-cajas');
  toast(`PL confirmado — ${totalCajas} cajas, ${totalPN.toFixed(3)} kg`);
}

function getPLCajasForProducto(productoId) {
  const btn = document.querySelector(`button[onclick="openPLModal('${productoId}')"]`);
  if (!btn?.dataset.plCajas) return [];
  try { return JSON.parse(btn.dataset.plCajas); } catch { return []; }
}

function isHiloProducto(productoId) {
  const prod = state.productos.find(p => p.id === productoId);
  if (!prod) return false;
  const cat  = (state.categorias||[]).find(c => c.id === prod.categoria);
  return (cat?.nombre||'').toLowerCase().includes('hilo');
}

function calcPLHilo(plLineId) {
  const cajas  = parseFloat(document.getElementById(plLineId+'-pl-cajas')?.value)||0;
  const cxcaja = parseFloat(document.getElementById(plLineId+'-pl-conos')?.value)||0;
  const pb     = parseFloat(document.getElementById(plLineId+'-pl-pb')?.value)||0;
  const pn     = parseFloat(document.getElementById(plLineId+'-pl-pn')?.value)||0;
  const totConos = cajas * cxcaja;
  const totPB    = cajas * pb;
  const totPN    = cajas * pn;
  const elConos = document.getElementById(plLineId+'-pl-tot-conos');
  const elPB    = document.getElementById(plLineId+'-pl-tot-pb');
  const elPN    = document.getElementById(plLineId+'-pl-tot-pn');
  if (elConos) elConos.textContent = totConos.toLocaleString('es-GT');
  if (elPB)    elPB.textContent    = totPB.toFixed(3) + ' kg';
  if (elPN)    elPN.textContent    = totPN.toFixed(3) + ' kg';
  // Auto-fill Recibir Ahora with peso neto total
  const prodId = plLineId.replace('pl-','');
  const qtyEl  = document.getElementById(`rec-qty-${prodId}`);
  if (qtyEl && totPN > 0) { qtyEl.value = totPN.toFixed(3); calcRecTotales(); }
}

function onOCProveedorChange() {
  const provId = document.getElementById('oc-proveedor').value;
  const ocId   = document.getElementById('oc-id').value;
  // Auto-fill incoterms and terminos from proveedor (only for new OCs)
  if (!ocId && provId) {
    const prov = state.proveedores.find(p => p.id === provId);
    if (prov?.incoterms_default) {
      document.getElementById('oc-incoterms').innerHTML = incotermsOpts(prov.incoterms_default);
    }
    if (prov?.terminos_pago) {
      document.getElementById('oc-terminos').value = prov.terminos_pago;
    }
  }

  // Las líneas ya agregadas deben refiltrarse al nuevo proveedor — si el
  // producto elegido no está en su lista de compra, se limpia esa línea
  // (unidad/precio/moneda) en vez de dejar un producto ajeno al proveedor.
  document.querySelectorAll('#oc-lines tr').forEach(tr => {
    const sel = tr.querySelector('select');
    if (!sel) return;
    const seleccionActual = sel.value;
    sel.innerHTML = ocProductoOptsForProveedor(provId);
    const sigueValido = seleccionActual && [...sel.options].some(o => o.value === seleccionActual);
    if (sigueValido) {
      sel.value = seleccionActual;
    } else if (seleccionActual) {
      const rowId = tr.id;
      const unidadInput = document.getElementById(rowId+'_unidad');
      if (unidadInput) unidadInput.value = '';
      const montoTd = document.getElementById(rowId+'_moneda');
      if (montoTd) montoTd.innerHTML = '';
      tr.dataset.moneda = '';
    }
  });
  calcOCTotal();
}

// ── DEVOLUCIONES ────────────────────────────────────────────────
// Suma cuánto ya se devolvió de una línea específica de recepción — las
// devoluciones quedan como filas propias (estado='devuelto', cantidad
// negativa, item_origen_id apuntando a la línea original), nunca se toca
// la línea original.
function cantidadDevueltaRecepcionItem(itemId) {
  return (state.ocRecepcionItems||[])
    .filter(x => x.estado === 'devuelto' && x.item_origen_id === itemId)
    .reduce((s,x) => s + Math.abs(Number(x.cantidad||0)), 0);
}

function openDevolucion(itemId, recepcionId, ocId) {
  const item   = state.ocRecepcionItems.find(x => x.id === itemId);
  const rec    = state.ocRecepciones.find(x => x.id === recepcionId);
  const ocItem = state.ocItems.find(i => i.oc_id === ocId && i.producto_id === item?.producto_id);
  if (!item) return;

  // CAMBIO (21/Ago/2026, a pedido explícito — "mismo criterio en todo el
  // sistema"): el máximo a devolver ahora es lo DISPONIBLE (cantidad
  // original menos lo ya devuelto en devoluciones previas de esta misma
  // línea), no la cantidad original completa — antes permitía capturar
  // más de lo que realmente quedaba, si ya se había devuelto algo antes.
  const yaDevuelto = cantidadDevueltaRecepcionItem(itemId);
  const recibidoNeto = Math.max(0, Number(item.cantidad||0) - yaDevuelto);

  // TOPE POR SALDO REAL EN INVENTARIO (26/Ago/2026, a pedido explícito:
  // "si ya la utilizaste, no se puede devolver").
  //
  // Hasta ahora el único límite era lo recibido menos lo ya devuelto, sin
  // mirar si el material seguía existiendo. Eso permitía recibir 500 kg,
  // consumirlos completos en una OP, y aun así devolverle 500 kg al
  // proveedor: se generaba stock negativo y una reversa contable de material
  // que ya estaba dentro de un rollo de tela.
  //
  // El saldo se mide sobre el LOTE específico de esta recepción en la bodega
  // donde entró, que es la unidad real de trazabilidad — no basta con el
  // saldo global del producto, porque podría haber existencia de otro lote
  // que no es el que se quiere devolver.
  const bodegaRec = rec?.bodega_id || null;
  const loteRec   = item.lote || '(sin lote)';
  const saldoLote = (calcStockPorLote(item.producto_id, bodegaRec)
                      .find(l => l.lote === loteRec)?.saldo) ?? 0;
  const disponible = Math.max(0, Math.min(recibidoNeto, saldoLote));

  if (disponible <= 0.0001) {
    toast(
      `No se puede devolver ${prodName(item.producto_id)} — el lote ${item.lote||'(sin lote)'} ya no tiene existencia. ` +
      `El material ya fue consumido o despachado. Para corregir el costo, usá un ajuste de inventario.`,
      'error'
    );
    return;
  }

  document.getElementById('dev-item-id').value       = itemId;
  document.getElementById('dev-recepcion-id').value  = recepcionId;
  document.getElementById('dev-producto-id').value   = item.producto_id;
  document.getElementById('dev-precio-unit').value   = ocItem?.precio_unit || item.costo_unit || 0;
  document.getElementById('dev-moneda').value        = ocItem?.moneda || 'GTQ';
  document.getElementById('dev-oc-id').value         = ocId;
  document.getElementById('dev-producto-nombre').textContent     = prodName(item.producto_id);
  document.getElementById('dev-cantidad-recibida').textContent =
    `${disponible.toFixed(3)} ${item.unidad||''}` +
    (yaDevuelto > 0.0001 ? ` (de ${Number(item.cantidad||0).toFixed(3)} — ya devuelto ${yaDevuelto.toFixed(3)})` : '') +
    // Si el tope lo impone el saldo y no lo recibido, se dice explícitamente:
    // de lo contrario el usuario ve un máximo menor al que recibió y parece
    // un error del sistema, cuando en realidad parte ya se consumió.
    (saldoLote < recibidoNeto - 0.0001
      ? ` — limitado por existencia: quedan ${saldoLote.toFixed(3)} en el lote, el resto ya se consumió`
      : '');
  document.getElementById('dev-cantidad').value      = '';
  document.getElementById('dev-cantidad').max        = disponible;
  document.getElementById('dev-packing').value       = '';
  document.getElementById('dev-lote').value          = item.lote||'';
  document.getElementById('dev-lote-display').textContent   = item.lote||'—';
  document.getElementById('dev-poliza').value        = item.poliza||'';
  document.getElementById('dev-poliza-display').textContent = item.poliza||'—';
  document.getElementById('dev-motivo').value        = '';
  document.getElementById('dev-fecha').value         = today();
  openModal('modal-devolucion');
}

async function saveDevolucion() {
  try {
    const itemId      = document.getElementById('dev-item-id').value;
    const recepcionId = document.getElementById('dev-recepcion-id').value;
    const productoId  = document.getElementById('dev-producto-id').value;
    const precioUnit  = parseFloat(document.getElementById('dev-precio-unit').value)||0;
    const moneda      = document.getElementById('dev-moneda').value||'GTQ';
    const ocId        = document.getElementById('dev-oc-id').value;
    const cantidad    = parseFloat(document.getElementById('dev-cantidad').value)||0;
    const motivo      = document.getElementById('dev-motivo').value.trim();
    const fecha       = document.getElementById('dev-fecha').value;


    if (!cantidad || cantidad <= 0)           { toast('Ingresa una cantidad válida', 'error'); return; }
    if (!motivo)                              { toast('El motivo es requerido', 'error'); return; }
    if (!fecha)                               { toast('La fecha es requerida', 'error'); return; }

    const item = state.ocRecepcionItems.find(x => x.id === itemId);
    const rec  = state.ocRecepciones.find(x => x.id === recepcionId);
    if (!item) { alert('No se encontró el item. ID: ' + itemId); return; }
    const recibidoNeto = Math.max(0, Number(item.cantidad||0) - cantidadDevueltaRecepcionItem(itemId));
    // Mismo tope que aplica openDevolucion, revalidado acá porque el modal es
    // solo la UI: sin esto, cualquier valor forzado por consola —o un state
    // desactualizado desde que se abrió el diálogo— pasaría igual y generaría
    // stock negativo. No se puede devolver material que ya se consumió.
    const loteRec   = item.lote || '(sin lote)';
    const saldoLote = (calcStockPorLote(item.producto_id, rec?.bodega_id || null)
                        .find(l => l.lote === loteRec)?.saldo) ?? 0;
    const disponible = Math.max(0, Math.min(recibidoNeto, saldoLote));
    if (disponible <= 0.0001) {
      toast(`El lote ${item.lote||'(sin lote)'} ya no tiene existencia — el material fue consumido o despachado. No se puede devolver.`, 'error');
      return;
    }
    if (cantidad > disponible + 0.0001) {
      toast(
        `La cantidad no puede ser mayor a lo disponible (${disponible.toFixed(3)})` +
        (saldoLote < recibidoNeto - 0.0001 ? ` — limitado por existencia del lote, no por lo recibido` : ''),
        'error'
      );
      return;
    }

    // Generate DEV correlativo — based on existing devolucion lines
    const devLines = (state.ocRecepcionItems||[]).filter(x => x.estado === 'devuelto' && x.numero_devolucion);
    const numDev   = nextCorrelativo('DEV', devLines, 'numero_devolucion');

    // 1. Nueva línea en erp_oc_recepcion_items (cantidad negativa = devolución)
    const { error:e1 } = await sb.from('erp_oc_recepcion_items').insert({
      recepcion_id:       recepcionId,
      producto_id:        productoId,
      unidad:             item.unidad||'',
      cantidad:           -cantidad,
      costo_unit:         precioUnit,
      estado:             'devuelto',
      item_origen_id:     itemId,
      motivo_devolucion:  motivo,
      numero_devolucion:  numDev,
      envio_numero:       item.envio_numero,
      lote:               document.getElementById('dev-lote').value || item.lote || null,
      poliza:             document.getElementById('dev-poliza').value || item.poliza || null,
      packing_num:        document.getElementById('dev-packing').value.trim() || null,
    });
    if (e1) { alert('Error registrando devolución:\n' + e1.message); return; }

    // 3. Movimiento de inventario: salida al proveedor
    try {
      await crearMovimientoConAsiento({
        tipo:           'salida',
        producto_id:    productoId,
        cantidad,
        costo_unitario: precioUnit,
        referencia_tipo:'DEV-OC',
        referencia_id:  numDev,
        notas:          `Devolución ${numDev} — ${rec?.numero||''} | ${motivo}`,
        fecha,
        moneda,
        lote:   document.getElementById('dev-lote').value || item.lote || null,
        poliza: document.getElementById('dev-poliza').value || item.poliza || null,
      });
    } catch(movErr) {
      alert('Error en movimiento:\n' + movErr.message);
      return;
    }

    // 4. Si la devolución hace que el pedido ya no esté completo, revertir estado
    await loadAll();
    const allItems    = state.ocItems.filter(i => i.oc_id === ocId);
    const allReceived = allItems.every(i => ocRecibidoQty(ocId, i.producto_id) >= Number(i.cantidad||0));
    if (!allReceived) {
      // La OC se reabre SIEMPRE, incluso si se había cerrado aceptando un
      // faltante (26/Ago/2026, a pedido explícito). Una devolución significa
      // que salió producto: la orden queda desabastecida y hay que poder
      // seguir operando sobre ella. Se limpia además recepcion_cerrada,
      // porque la decisión de "cerrada con faltante" dejó de ser válida —
      // si no se limpiara, la OC quedaría en 'recibiendo' pero marcada como
      // cerrada, dos datos que se contradicen.
      await sb.from('erp_oc').update({ status: 'recibiendo', recepcion_cerrada: false }).eq('id', ocId);
    }
    await loadAll();

    closeModal('modal-devolucion');
    toast(`Devolución registrada — ${cantidad.toFixed(3)} ${item.unidad||''} devueltos al proveedor`);
    // Refresca la vista de "Ver Recepción" si es de ahí de donde se abrió
    // (21/Ago/2026: openDevolucion ahora se dispara desde verRecepcion(),
    // que queda debajo del modal de devolución mientras se captura).
    if (recepcionId) verRecepcion(recepcionId);
    showOCPanel(ocId);

  } catch(e) {
    alert('Error inesperado en saveDevolucion:\n\n' + e.message + '\n\n' + e.stack);
  }
}

async function saveOC() {
  const id           = document.getElementById('oc-id').value;
  const proveedor_id = document.getElementById('oc-proveedor').value;
  // La Fecha de la OC siempre es la fecha en la que se genera — nunca se
  // le exige al usuario que la haya ingresado. Si el campo llegó vacío
  // (ej. una OC generada en cascada por el motor de planificación, sin
  // pasar por openNewOC()), se usa hoy por default en vez de bloquear el
  // guardado. Antes esto tronaba con "Proveedor y fecha son requeridos"
  // incluso cuando el vacío era responsabilidad del sistema, no del
  // usuario — reportado en vivo al confirmar una OC de subcontrato que
  // dispara la generación automática de la OC de hilo.
  const fecha        = document.getElementById('oc-fecha').value || today();
  if (!proveedor_id) { toast('Proveedor es requerido','error'); return; }
  const lines = getOCLines();
  if (!lines.length) { toast('Agrega al menos un producto','error'); return; }

  // RUTA DEL PRODUCTO (19/Ago/2026, a pedido explícito — "todo esto en
  // base a la estructura establecida en la ficha de rutas del producto"):
  // la ficha de rutas de cada producto (Comprar/Fabricar/Subcontratar/
  // Obtener bajo pedido) es la fuente única de verdad — misma que ya usa
  // el motor automático (planificarAbastecimiento/planificarSubcontrato).
  // Antes, "Nueva OC" (armada a mano) ignoraba esto por completo: guardaba
  // SIEMPRE tipo_oc='compra' sin receta_id, sin importar qué producto se
  // eligiera. Bug real reportado en vivo: una OC a subcontratista por
  // C-028-00 (que tiene ruta_subcontratar=true, ruta_comprar=false) se
  // guardó como compra normal — sin botón de Reabastecer para el insumo
  // GF-028 que esa receta necesita, y sin generar la OP para fabricarlo.
  // Ahora, si el producto de la línea tiene ruta_subcontratar activa, esta
  // OC se trata como servicio de subcontrato: se vincula tipo_oc/receta_id
  // y se corre la misma cascada de reabastecimiento de insumos que ya usa
  // planificarSubcontrato() para las OC que genera el sistema solo.
  const prodsSub = lines
    .map(l => state.productos.find(p=>p.id===l.producto_id))
    .filter(p => p?.ruta_subcontratar);
  const esSubOC = prodsSub.length > 0;

  if (esSubOC && lines.length > 1) {
    toast('Una OC de servicio de subcontrato solo puede tener UN producto — separá los demás en otra OC de compra','error');
    return;
  }

  let recetaSub = null;
  if (esSubOC) {
    const prodSub = prodsSub[0];
    recetaSub = (state.recetas||[])
      .filter(r => r.producto_id === prodSub.id && esSubcontrato(r.tipo) && r.activa !== false)
      .sort((a,b) => (a.prioridad||99) - (b.prioridad||99))[0];
    if (!recetaSub) {
      toast(`${prodSub.codigo_interno||prodSub.code||prodSub.description} tiene ruta de subcontrato pero no una receta activa configurada — creála en Recetas antes de generar esta OC`, 'error');
      return;
    }
  }

  const estadoElegido = document.getElementById('oc-status').value;

  // REABASTECIMIENTO (candado agregado 20/Ago/2026 — "mejor nos curamos
  // que el usuario pueda cometer algún error" — y ELIMINADO ese mismo día,
  // pocos minutos después, a pedido explícito: "yo puedo confirmar una OP,
  // una OC aunque no haya reabastecido materia prima... si tengo que
  // esperar a que esté todo listo para hacer el siguiente paso, me
  // retrasa mucho"). El dropdown de Estado ya no fuerza 'borrador' ni
  // bloquea 'confirmada' por reabastecimiento incompleto — solo avisa. Se
  // puede seguir asignando lotes después con 🔄 Reabastecer, esté o no ya
  // confirmada la OC (cada asignación contabiliza su propio consumo al
  // momento, ver confirmarAsignacionLotes).
  let estadoFinal = estadoElegido;
  if (estadoFinal === 'confirmada' && esSubOC && id) {
    const estOC = estadoReabastecimiento('oc', id, recetaSub, Number(lines[0]?.cantidad||0));
    if (estOC.requiere && !estOC.completo) {
      if (!confirm('Todavía falta reabastecimiento por asignar para esta OC. ¿Guardar como Confirmada de todas formas? Podés seguir asignando lotes después.')) return;
    }
  }

  // CAMBIO DE DISEÑO (13/Ago/2026, a pedido explícito): el número real solo
  // se asigna la primera vez que la OC deja de ser 'borrador' — ya sea vía
  // el botón dedicado Confirmar (confirmarOC) o cambiando el estado
  // directamente aquí en el formulario de edición. Un borrador guardado o
  // descartado nunca "quema" un número.
  const numeroActual = document.getElementById('oc-num').value.trim();
  const numero = (!numeroActual && estadoFinal !== 'borrador') ? await nextOCNum() : (numeroActual || null);

  const row = {
    numero,
    proveedor_id, fecha,
    entrega:        document.getElementById('oc-entrega').value||null,
    bodega_id:      document.getElementById('oc-bodega')?.value||null,
    terminos_pago:  document.getElementById('oc-terminos')?.value||null,
    dias_credito:   (() => { const sel = document.getElementById('oc-terminos'); return sel?.value ? (parseInt(sel.options[sel.selectedIndex]?.getAttribute('data-dias'))||0) : null; })(),
    incoterms:      document.getElementById('oc-incoterms')?.value||null,
    status:         estadoFinal,
    notas:          document.getElementById('oc-notas').value.trim(),
    representante:  document.getElementById('oc-representante').value.trim()||null,
    ...(esSubOC ? { tipo_oc: 'subcontrato', receta_id: recetaSub.id } : {}),
  };
  let ocId = id, err;
  const esNueva = !id;
  if (id) {
    ({error:err} = await sb.from('erp_oc').update(row).eq('id',id));
    if (!err) await sb.from('erp_oc_items').delete().eq('oc_id',id);
  } else {
    const {data,error} = await sb.from('erp_oc').insert(row).select().single();
    if (error) { toast('Error: '+error.message,'error'); return; }
    ocId = data.id;
  }
  if (err) { toast('Error: '+err.message,'error'); return; }
  await sb.from('erp_oc_items').insert(lines.map(l=>({...l, oc_id:ocId})));

  // Cascada de reabastecimiento de insumos de la receta de subcontrato —
  // SOLO al crear la OC (esNueva), nunca al editar/re-guardar, para no
  // duplicar OPs/OCs cada vez que alguien vuelva a guardar la misma OC.
  // Mismo motor (planificarAbastecimiento) que ya usa planificarSubcontrato.
  let cascadaMsg = '';
  if (esSubOC && esNueva) {
    const cantidadOC   = Number(lines[0].cantidad||0);
    const lineasReceta = (state.recetaLineas||[]).filter(l => l.receta_id === recetaSub.id);
    const refServ       = numero || `OC-borrador-${ocId.slice(0,8)}`;
    let seGeneroAlgo = false;
    for (const l of lineasReceta) {
      const insumo = state.productos.find(p => p.id === l.insumo_id);
      if (!insumo?.ruta_obtener_bajo_pedido) continue;
      const cantMP = Number(l.cantidad_base||0) * (1 + Number(l.merma_pct||0)/100) * cantidadOC;
      const res = await planificarAbastecimiento(l.insumo_id, cantMP, fecha, 'OC-SUB', refServ, null, null, ocId);
      if (res) seGeneroAlgo = true;
    }
    cascadaMsg = seGeneroAlgo ? ' — insumos planificados (ver abajo)' : '';
  }

  toast(numero ? `OC ${numero} guardada${esSubOC?' — servicio de subcontrato vinculado a receta'+cascadaMsg:''}` : 'Borrador de OC guardado');
  closeModal('modal-oc');
  await loadAll();
}

// Las órdenes de compra NO se pueden eliminar — solo editar (editOC) o
// cancelar (cancelarOC). No existe función de borrado para erp_oc.

// ── RECEPCION ──
async function guardarRecepcionBorrador() {
  const ocId      = document.getElementById('rec-oc-id')?.value;
  const fecha     = document.getElementById('rec-fecha')?.value;
  const numero    = document.getElementById('rec-num')?.value;
  const bodega_id = document.getElementById('rec-bodega')?.value || null;
  const envio     = document.getElementById('rec-envio-header')?.value.trim() || '';

  if (!ocId || !fecha || !numero) { toast('Completa fecha y bodega', 'error'); return; }

  try {
    // Check if recepcion already exists
    const existing = (state.ocRecepciones||[]).find(r => r.numero === numero && r.oc_id === ocId);

    // Leemos las líneas de lote primero (el No. de PL ahora es por lote, no
    // un campo único de header) para poder calcular el rollup del header.
    const loteRows = document.querySelectorAll('[id^="rec-lote-val-"]');
    const rowsData = [];

    loteRows.forEach(el => {
      const n        = el.id.replace('rec-lote-val-','');
      const lote     = el.value.trim();
      const prodId   = el.dataset.prod;
      const unidad   = el.dataset.unidad || '';
      const costo    = parseFloat(el.dataset.costo)||0;
      const qtyEl    = document.getElementById(`rec-qty-${prodId}-${n}`);
      const qty      = parseFloat(qtyEl?.value)||0;
      const esperada = parseFloat(document.getElementById(`rec-qty-esperada-${n}`)?.value)||0;
      const packing  = document.getElementById(`rec-pl-val-${n}`)?.value.trim() || '';

      if (qty > 0 || esperada > 0) {
        rowsData.push({ lote, prodId, unidad, costo, qty, packing });
      }
    });

    // + grupos de rollos (productos con agrupación) — en borrador todavía
    // NO se crea el erp_rollos real (eso pasa recién al confirmar, en
    // saveRecepcion) — se persiste solo cantidad/lote/no. de rollo como
    // texto, para no perder lo capturado si el usuario cierra y reabre.
    document.querySelectorAll('.rec-rollo-group').forEach(grp => {
      const gid    = grp.id.replace('rec-rollo-group-','');
      const prodId = grp.dataset.prod;
      const unidad = grp.dataset.unidad || '';
      const costo  = parseFloat(grp.dataset.costo)||0;
      const lote   = document.getElementById(`rec-rollogrp-lote-${gid}`)?.value.trim() || '';
      grp.querySelectorAll(`[id^="rec-rollo-numero-${gid}-"]`).forEach(numEl => {
        const rid  = numEl.id.replace(`rec-rollo-numero-${gid}-`,'');
        const peso = parseFloat(document.getElementById(`rec-rollo-peso-${gid}-${rid}`)?.value)||0;
        const pl   = document.getElementById(`rec-rollo-pl-${gid}-${rid}`)?.value.trim() || '';
        if (peso > 0) {
          rowsData.push({ lote, prodId, unidad, costo, qty: peso, packing: pl });
        }
      });
    });

    // El No. de PL del header queda como un resumen (valores distintos de
    // cada lote) — solo informativo, ya que la fuente real ahora es por línea.
    const packingRollup = [...new Set(rowsData.map(r=>r.packing).filter(Boolean))].join(', ') || null;

    const recData = {
      oc_id:        ocId,
      numero,
      fecha,
      status:       'borrador',
      bodega_id,
      envio_numero: envio,
      packing_num:  packingRollup,
    };

    let recepcionId;
    if (existing) {
      const { error } = await sb.from('erp_oc_recepciones').update(recData).eq('id', existing.id);
      if (error) { alert('Error actualizando recepción:\n' + error.message); return; }
      recepcionId = existing.id;
    } else {
      const { data, error } = await sb.from('erp_oc_recepciones').insert(recData).select().single();
      if (error) { alert('Error guardando recepción:\n' + error.message); return; }
      recepcionId = data.id;
    }

    // Save recepcion items (one per lote row)
    // Delete existing items for this recepcion first
    await sb.from('erp_oc_recepcion_items').delete().eq('recepcion_id', recepcionId);

    const insertItems = rowsData.map(r => ({
      recepcion_id: recepcionId,
      producto_id:  r.prodId,
      unidad:       r.unidad,
      cantidad:     r.qty,
      costo_unit:   r.costo,
      lote:         r.lote || null,
      packing_num:  r.packing || null,
      estado:       'borrador',
    }));

    if (insertItems.length) {
      const { error: eItems } = await sb.from('erp_oc_recepcion_items').insert(insertItems);
      if (eItems) { alert('Error guardando líneas:\n' + eItems.message); return; }
    }

    await loadAll();
    toast(`✓ Información guardada — ${numero}`);

  } catch(e) {
    alert('Error inesperado:\n' + e.message);
  }
}

// currentVerRecepcionId — la REC actualmente mostrada en modal-ver-recepcion
// (igual patrón que currentVerFacturaOCId para facturas).
let currentVerRecepcionId = null;

async function abrirRecepcion(recepcionId) {
  await loadAll();
  const rec = (state.ocRecepciones||[]).find(r => r.id === recepcionId);
  if (!rec) { toast('Recepción no encontrada','error'); return; }
  currentOCId = rec.oc_id;
  verRecepcion(recepcionId);
}

// Vista de solo lectura del detalle de una REC — clic en el título de una
// recepción ya generada (21/Ago/2026, a pedido explícito: "me colocas 2
// botones en el pop-up: Imprimir Albarán / Editar", en vez de abrir directo
// el formulario editable como pasaba antes). Mismo patrón que
// verFacturaOC(): header con datos generales, tabla de lotes recibidos,
// footer con Editar (abre el formulario real de edición, openRecepcion) y
// Cerrar.
function verRecepcion(recepcionId) {
  const rec = (state.ocRecepciones||[]).find(r => r.id === recepcionId);
  if (!rec) { toast('Recepción no encontrada','error'); return; }
  currentVerRecepcionId = recepcionId;
  const oc   = state.oc.find(o => o.id === rec.oc_id);
  const prov = state.proveedores.find(p => p.id === oc?.proveedor_id);
  const bodega = state.bodegas.find(b => b.id === rec.bodega_id);
  const STATUS_REC_LABEL = { borrador:'Borrador', en_proceso:'En Proceso', completada:'Completada', cancelada:'Cancelada' };
  const STATUS_REC_COLOR_HEX = { borrador:'#9CA3AF', en_proceso:'#D97706', completada:'#16A34A', cancelada:'#DC2626' };

  // Solo las líneas originalmente recibidas (estado='recibido') — las de
  // devolución (estado='devuelto', cantidad negativa) se muestran como
  // "Ya Devuelto" restado de cada línea original, no como filas propias.
  const ri = (state.ocRecepcionItems||[]).filter(x => x.recepcion_id === recepcionId);
  const originales = ri.filter(x => x.estado === 'recibido');
  const loteRows = originales.map(item => {
    const devuelta = cantidadDevueltaRecepcionItem(item.id);
    const disponible = Math.max(0, Number(item.cantidad||0) - devuelta);
    const btnDev = disponible > 0.0001
      ? `<button class="btn btn-ghost btn-sm" style="padding:4px 10px;font-size:11px" onclick="openDevolucion('${item.id}','${recepcionId}','${oc?.id}')">↩️ Devolver</button>`
      : `<span style="font-size:11px;color:var(--red);font-weight:600">Devuelto completo</span>`;
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px 12px;font-size:13px;font-family:'DM Mono',monospace;color:var(--accent)">${item.lote||'—'}</td>
      <td style="padding:8px 12px;font-size:13px">${prodName(item.producto_id)}</td>
      <td style="padding:8px 12px;font-size:13px">${item.packing_num||'—'}</td>
      <td style="padding:8px 12px;text-align:right;font-family:'DM Mono',monospace;font-size:13px;font-weight:600">${Number(item.cantidad||0).toFixed(3)} ${item.unidad||''}</td>
      <td style="padding:8px 12px;text-align:right;font-family:'DM Mono',monospace;font-size:12px;color:var(--text3)">${devuelta>0.0001?devuelta.toFixed(3):'—'}</td>
      <td style="padding:8px 12px;text-align:right">${btnDev}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:12px">Sin lotes registrados</td></tr>`;

  document.getElementById('vrec-title').textContent = rec.numero || '—';
  document.getElementById('vrec-body').innerHTML = `
    <div style="padding:20px 24px">
      <div style="padding:10px 16px;border-radius:8px;text-align:center;font-weight:700;font-size:13px;letter-spacing:0.03em;margin-bottom:16px;background:${STATUS_REC_COLOR_HEX[rec.status]||'#9CA3AF'};color:#fff">${STATUS_REC_LABEL[rec.status]||rec.status||'—'}</div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:20px">
        <div style="padding:12px 16px;border-right:1px solid var(--border);border-bottom:1px solid var(--border)">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Fecha</div>
          <div style="font-size:14px;font-weight:500">${fmtDate(rec.fecha)}</div>
        </div>
        <div style="padding:12px 16px;border-bottom:1px solid var(--border)">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">No. Envío</div>
          <div style="font-size:14px;font-weight:500">${rec.envio_numero||'—'}</div>
        </div>
        <div style="padding:12px 16px;border-right:1px solid var(--border)">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Orden de Compra</div>
          <div style="font-size:14px;font-weight:500;font-family:'DM Mono',monospace">${oc?.numero||'—'}</div>
        </div>
        <div style="padding:12px 16px">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Proveedor</div>
          <div style="font-size:14px;font-weight:500">${prov?.name||'—'}</div>
        </div>
        <div style="padding:12px 16px;border-top:1px solid var(--border);grid-column:1 / -1">
          <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Bodega</div>
          <div style="font-size:14px;font-weight:500">${bodega ? (bodega.codigo?bodega.codigo+' — ':'')+bodega.nombre : '—'}</div>
        </div>
      </div>

      ${rec.notas ? `<div style="padding:10px 14px;border-radius:8px;background:#FFFBEB;border:1px solid #FDE68A;margin-bottom:16px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#92400E;margin-bottom:3px">⚠ Nota</div>
        <div style="font-size:12px;color:#78350F">${rec.notas}</div>
      </div>` : ''}

      <div style="font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text3);margin-bottom:8px">Lotes Recibidos</div>
      <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface2)">
            <th style="padding:7px 12px;text-align:left;font-size:11px">Lote</th>
            <th style="padding:7px 12px;text-align:left;font-size:11px">Producto</th>
            <th style="padding:7px 12px;text-align:left;font-size:11px">No. Packing List</th>
            <th style="padding:7px 12px;text-align:right;font-size:11px">Cantidad</th>
            <th style="padding:7px 12px;text-align:right;font-size:11px">Ya Devuelto</th>
            <th style="padding:7px 12px;text-align:right;font-size:11px"></th>
          </tr></thead>
          <tbody>${loteRows}</tbody>
        </table>
      </div>
    </div>`;

  openModal('modal-ver-recepcion');
}

// Botón "✏️ Editar" del visor de solo lectura — abre el formulario real de
// edición (el mismo que existía antes de este cambio), reutilizando
// openRecepcion() sin duplicar su lógica.
function editarRecepcionDesdeVista() {
  const rec = (state.ocRecepciones||[]).find(r => r.id === currentVerRecepcionId);
  if (!rec) return;
  closeModal('modal-ver-recepcion');
  openRecepcion(rec.oc_id, rec.id);
}

// Imprime el Albarán de una recepción — encabezado + tabla de lotes +
// espacio de firma. Mismo patrón de ventana de impresión que
// imprimirFacturaOC()/imprimirOC() (21/Ago/2026, a pedido explícito).
function imprimirRecepcion(recepcionId) {
  const rec = (state.ocRecepciones||[]).find(r => r.id === recepcionId);
  if (!rec) { toast('Recepción no encontrada','error'); return; }
  const oc   = state.oc.find(o => o.id === rec.oc_id);
  const prov = state.proveedores.find(p => p.id === oc?.proveedor_id);
  const bodega = state.bodegas.find(b => b.id === rec.bodega_id);

  const ri = (state.ocRecepcionItems||[]).filter(x => x.recepcion_id === recepcionId);
  const lotes = [...new Set(ri.map(x => x.lote).filter(Boolean))];
  const loteRows = lotes.map(lote => {
    const lineas = ri.filter(x => x.lote === lote);
    const qty = lineas.reduce((s,x) => s+Number(x.cantidad||0), 0);
    return `<tr>
      <td>${lote}</td>
      <td>${prodName(lineas[0]?.producto_id)}</td>
      <td>${lineas[0]?.packing_num||'—'}</td>
      <td class="num">${qty.toFixed(3)} ${lineas[0]?.unidad||''}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="4" style="text-align:center;color:#9EA4B0">Sin lotes registrados</td></tr>`;

  const win = window.open('','_blank','width=900,height=700');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8"/>
    <title>Albarán ${rec.numero||''}</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Inter',sans-serif;font-size:12px;color:#1A1C21;padding:32px;background:#fff}
      .doc-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;padding-bottom:18px;border-bottom:2px solid #101820}
      .brand{font-size:11px;color:#5E6470;margin-top:4px}
      .doc-num{font-size:26px;font-weight:700;color:#C84B2F;font-family:monospace}
      .two-col{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:20px 0}
      .info-row{display:flex;flex-direction:column;margin-bottom:6px}
      .info-label{font-size:9px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#9EA4B0;margin-bottom:1px}
      .info-val{font-size:12px;font-weight:500;color:#1A1C21}
      .section-title{font-size:9px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;color:#9EA4B0;margin:24px 0 8px;padding-top:16px;border-top:2px solid #101820}
      table{width:100%;border-collapse:collapse;margin-bottom:12px}
      thead th{background:#F4F5F7;padding:6px 10px;text-align:left;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#5E6470;border-bottom:1px solid #E2E4E9}
      tbody td{padding:6px 10px;border-bottom:1px solid #F0F1F3;font-size:11px}
      tbody tr:last-child td{border-bottom:none}
      .num{text-align:right;font-family:monospace}
      .firmas{display:grid;grid-template-columns:1fr 1fr;gap:48px;margin-top:64px}
      .firma-linea{border-top:1px solid #1A1C21;padding-top:6px;text-align:center;font-size:10px;color:#5E6470}
      @media print{body{padding:16px} @page{margin:12mm}}
    </style>
  </head><body>

    <div class="doc-header">
      <div>
        <h1 style="font-size:20px;font-weight:700">Albarán de Recepción</h1>
        <div class="brand">TEXTILES CIRCULARES, S.A.</div>
      </div>
      <div style="text-align:right">
        <div class="doc-num">${rec.numero||''}</div>
      </div>
    </div>

    <div class="two-col">
      <div>
        <div class="info-row"><div class="info-label">Fecha</div><div class="info-val">${fmtDate(rec.fecha)}</div></div>
        <div class="info-row"><div class="info-label">Orden de Compra</div><div class="info-val">${oc?.numero||'—'}</div></div>
        <div class="info-row"><div class="info-label">No. de Envío</div><div class="info-val">${rec.envio_numero||'—'}</div></div>
      </div>
      <div>
        <div class="info-row"><div class="info-label">Proveedor</div><div class="info-val">${prov?.name||'—'}</div></div>
        <div class="info-row"><div class="info-label">Bodega de destino</div><div class="info-val">${bodega ? (bodega.codigo?bodega.codigo+' — ':'')+bodega.nombre : '—'}</div></div>
      </div>
    </div>

    <div class="section-title" style="border-top:none;padding-top:0">Lotes Recibidos</div>
    <table>
      <thead><tr><th>Lote</th><th>Producto</th><th>No. Packing List</th><th style="text-align:right">Cantidad</th></tr></thead>
      <tbody>${loteRows}</tbody>
    </table>

    <div class="firmas">
      <div class="firma-linea">Entregado por</div>
      <div class="firma-linea">Recibido por</div>
    </div>

  </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

// ── OC — openRecepcion y captura de rollos, saveRecepcion, factura de OC (FOC), anticipos (index.html original: líneas 20849-22776) ──
async function openRecepcion(ocIdParam, recepcionId) {
  const ocId = ocIdParam || currentOCId;
  if (!ocId) return;
  const oc    = state.oc.find(o => o.id === ocId);
  const prov  = state.proveedores.find(p=>p.id===oc?.proveedor_id);
  const items = state.ocItems.filter(i=>i.oc_id===ocId);

  document.getElementById('rec-oc-id').value = ocId;
  document.getElementById('rec-panel-sub').textContent = `${oc?.numero||''} — ${prov?.name||''}`;

  // Load existing recepcion if provided
  const existingRec = recepcionId
    ? (state.ocRecepciones||[]).find(r => r.id === recepcionId)
    : (state.ocRecepciones||[]).find(r => r.oc_id===ocId && r.status==='borrador');

  // Section 1 — Header
  document.getElementById('rec-fecha').value          = existingRec?.fecha || today();
  document.getElementById('rec-num').value            = existingRec?.numero || await nextRecepcionNum();
  document.getElementById('rec-envio-header').value   = existingRec?.envio_numero || '';
  document.getElementById('rec-bodega').innerHTML =
    '<option value="">— Seleccionar —</option>' +
    (state.bodegas||[]).filter(b=>b.activa!==false)
      .map(b=>`<option value="${b.id}"${b.id===(existingRec?.bodega_id||oc?.bodega_id)?' selected':''}>${b.codigo?b.codigo+' — ':''}${b.nombre}</option>`).join('');

  // Section 2 — Products / Lotes (pre-fill from existing items)
  const existingItems = existingRec
    ? (state.ocRecepcionItems||[]).filter(x=>x.recepcion_id===existingRec.id)
    : [];
  _recLoteCount = 0;
  renderRecLotes(items, ocId, existingItems);

  // Section 3 — PL cascade if data exists
  const existingPLCajas = (state.plCajas||[]).filter(c =>
    existingRec ? c.recepcion_id===existingRec.id : c.oc_id===ocId
  );
  if (existingPLCajas.length > 0) {
    const prodId = items[0]?.producto_id;
    const cajasFormatted = existingPLCajas.map(c=>({
      no_caja: c.no_caja, lote: c.lote, conos: c.conos,
      pn: Number(c.peso_neto||0), pn_lbs: Number(c.peso_neto_lbs||0),
      recibido: c.estado==='recibido',
    }));
    renderPLCascadeSection3(cajasFormatted, prodId);
  } else {
    // rec-pl-section removed
  }

  // Section 4
  calcRecVerificacion();

  openModal('modal-recepcion');
}

function renderRecLotes(items, ocId, existingItems=[]) {
  const container = document.getElementById('rec-lines-container');
  container.innerHTML = items.map(i => {
    const prod      = state.productos.find(p=>p.id===i.producto_id);
    const recibido  = ocRecibidoQty(ocId, i.producto_id);
    const pendiente = Math.max(0, Number(i.cantidad||0) - recibido);
    const agrupa    = productoTieneAgrupacion(i.producto_id);

    // Get lotes from existing saved items
    const savedItems = existingItems.filter(x=>x.producto_id===i.producto_id);
    const plCajas    = (state.plCajas||[]).filter(c=>c.producto_id===i.producto_id && c.oc_id===ocId);
    const lotesEnPL  = [...new Set(plCajas.map(c=>c.lote).filter(Boolean))];
    const savedLotes = savedItems.map(x=>x.lote).filter(Boolean);
    const todosLotes = [...new Set([...savedLotes, ...lotesEnPL])];

    return `
    <div style="border:1.5px solid var(--border);border-radius:8px;margin-bottom:12px;overflow:hidden">
      <div style="padding:12px 16px;background:var(--surface2);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-weight:700;font-size:14px">${prod?.description||prodName(i.producto_id)}</span>
          <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--accent);margin-left:8px">${prod?.codigo_interno||prod?.code||''}</span>
          ${agrupa?' <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--surface3);color:var(--text3)">Por rollo/bulto</span>':''}
        </div>
        <div style="font-size:12px;color:var(--text3)">
          Pedido: <strong>${Number(i.cantidad||0).toFixed(3)} ${i.unidad||''}</strong>
          &nbsp;·&nbsp; Recibido: <strong style="color:var(--green)">${recibido.toFixed(3)}</strong>
          &nbsp;·&nbsp; Pendiente: <strong style="color:${pendiente>0?'var(--accent)':'var(--text3)'}">${pendiente.toFixed(3)}</strong>
        </div>
      </div>
      <div style="padding:12px 16px">
        <div id="rec-lotes-${i.producto_id}">
          ${agrupa
            ? (todosLotes.length > 0
                ? todosLotes.map(lote => renderRecLoteRowRollos(i, lote, savedItems.filter(x=>x.lote===lote), ocId)).join('')
                : renderRecLoteRowRollos(i, '', [], ocId))
            : (todosLotes.length > 0
                ? todosLotes.map(lote => {
                    const savedItem = savedItems.find(x=>x.lote===lote);
                    const cajasLote = plCajas.filter(c=>c.lote===lote);
                    return renderRecLoteRow(i, lote, cajasLote, ocId, savedItem);
                  }).join('')
                : renderRecLoteRow(i, '', [], ocId, null))
          }
        </div>
        <button class="btn btn-sm btn-ghost" onclick="${agrupa?`addRecLoteRollos('${i.producto_id}','${i.unidad||''}','${i.precio_unit||0}')`:`addRecLote('${i.producto_id}','${i.unidad||''}','${i.precio_unit||0}')`}"
          style="margin-top:8px;font-size:11px">+ Agregar Lote</button>
      </div>
    </div>`;
  }).join('');
}

let _recLoteCount = 0;
function renderRecLoteRow(item, lote, cajasLote, ocId, savedItem=null) {
  _recLoteCount++;
  const n      = _recLoteCount;
  const totalPN    = cajasLote.reduce((s,c)=>s+Number(c.peso_neto||0),0);
  const hasPL      = cajasLote.length > 0;
  const qtyValue   = savedItem?.cantidad ? Number(savedItem.cantidad).toFixed(3) : (hasPL ? totalPN.toFixed(3) : '');
  // Cantidad Esperada por defecto = pendiente de recibir de esta OC para
  // este producto (ordenado - recibido), no 0/vacío. item.cantidad viene
  // pre-cargado cuando renderRecLoteRow() se llama desde renderRecLotes()
  // (itera sobre state.ocItems); cuando se llama desde addRecLote() (botón
  // "+ Agregar Lote") el item minimal que arma esa función no trae
  // cantidad, así que se busca aquí en state.ocItems como respaldo.
  const cantidadOrdenada = item.cantidad != null
    ? Number(item.cantidad)
    : Number((state.ocItems||[]).find(x => x.oc_id===ocId && x.producto_id===item.producto_id)?.cantidad || 0);
  const recibidoOC = ocRecibidoQty(ocId, item.producto_id);
  const pendienteOC = Math.max(0, cantidadOrdenada - recibidoOC);
  const espValue   = savedItem?.cantidad_esperada ? Number(savedItem.cantidad_esperada).toFixed(3) : pendienteOC.toFixed(3);
  const plValue    = savedItem?.packing_num || '';
  const requiereLote = state.productos.find(p=>p.id===item.producto_id)?.seguimiento === 'lote';
  // Filas YA GUARDADAS quedan bloqueadas al editar (22/Ago/2026, reportado
  // en vivo — "no debe generar una nueva recepción, debe cambiar la
  // recepción ya hecha"): si se re-procesaran junto con lo nuevo, se
  // duplicaría la cantidad/costo en inventario silenciosamente. Para
  // agregar más material se usa "+ Agregar Lote" (fila nueva, editable);
  // lo ya guardado no se vuelve a tocar desde acá.
  const yaGuardado = !!savedItem;
  const lockAttr   = yaGuardado ? 'disabled' : '';
  const lockBg     = yaGuardado ? 'background:var(--surface2);color:var(--text3)' : '';
  return `
  <div id="rec-lote-row-${n}" data-existing="${yaGuardado?'1':'0'}" style="display:grid;grid-template-columns:1.2fr 1.2fr 1fr 1fr auto;gap:10px;align-items:end;padding:8px 0;border-bottom:1px solid var(--border)">
    <div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Lote${requiereLote?' <span style="color:var(--red)">*</span>':''}</div>
      <input type="text" id="rec-lote-val-${n}" value="${lote||''}" placeholder="Número de lote" ${lockAttr}
        style="padding:6px 10px;border:1.5px solid ${requiereLote?'var(--red)':'var(--border)'};border-radius:6px;font-family:'DM Mono',monospace;font-size:13px;font-weight:600;width:100%;${lockBg}"
        data-prod="${item.producto_id}" data-unidad="${item.unidad||''}" data-costo="${item.precio_unit||0}"
        oninput="calcRecVerificacion()"/>
    </div>
    <div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3);margin-bottom:3px">No. Packing List</div>
      <input type="text" id="rec-pl-val-${n}" value="${plValue}" placeholder="Ej. KAA4071-CI01" ${lockAttr}
        style="padding:6px 10px;border:1.5px solid var(--border);border-radius:6px;font-family:'DM Mono',monospace;font-size:13px;width:100%;${lockBg}"/>
    </div>
    <div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Cantidad Esperada</div>
      <input type="number" id="rec-qty-esperada-${n}" step="0.001" min="0" placeholder="0.000" ${lockAttr}
        value="${espValue}"
        style="padding:6px 10px;border:1.5px solid var(--border);border-radius:6px;font-family:'DM Mono',monospace;font-size:13px;width:100%;${lockBg}"
        oninput="calcRecVerificacion()"/>
    </div>
    <div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Recibir Ahora</div>
      <input type="number" id="rec-qty-${item.producto_id}-${n}" step="0.001" min="0" ${lockAttr}
        value="${qtyValue}" placeholder="0.000"
        data-prod="${item.producto_id}" data-unidad="${item.unidad||''}" data-costo="${item.precio_unit||0}" data-lote="${lote||''}"
        style="padding:6px 10px;border:1.5px solid var(--accent);border-radius:6px;font-family:'DM Mono',monospace;font-size:13px;font-weight:600;width:100%;color:var(--accent);${lockBg}"
        oninput="calcRecVerificacion()"/>
    </div>
    <div style="padding-bottom:6px">${yaGuardado?'<span style="font-size:10px;color:var(--green);font-weight:600">✓ Guardado</span>':''}</div>
  </div>`;
}

function addRecLote(productoId, unidad, costo) {
  const item = { producto_id: productoId, unidad, precio_unit: costo };
  const container = document.getElementById(`rec-lotes-${productoId}`);
  if (!container) { toast('Error: no se encontró el contenedor del producto','error'); return; }
  const div = document.createElement('div');
  div.innerHTML = renderRecLoteRow(item, '', [], currentOCId || document.getElementById('rec-oc-id')?.value);
  // Append all child nodes
  while (div.firstChild) container.appendChild(div.firstChild);
}

// ── Recepción POR ROLLO/BULTO (21/Ago/2026, a pedido explícito — "los
// productos que tienen agrupación por bulto o por rollo... debemos
// recibirlos de esta manera... cada bulto o rollo es una unidad que tiene
// un peso neto específico"). Solo para productos cuya categoría tiene
// agrupacion_producto=true (hoy: Producto Terminado, Tela Cruda) — mismo
// criterio y mismo look que renderRecLoteRow/addRecLote, pero en vez de un
// único campo de cantidad, cada línea de lote tiene una lista de rollos
// individuales (número + peso), y el total recibido es la suma de esos
// pesos, no un valor capturado a mano.
let _recRolloGrpCount = 0;
let _recRolloRowCount = 0;

function renderRecLoteRowRollos(item, lote, savedItemsDeEsteLote, ocId) {
  _recRolloGrpCount++;
  const gid = _recRolloGrpCount;
  const rollosExistentes = savedItemsDeEsteLote.map(si => {
    const rollo = si.rollo_id ? (state.rollos||[]).find(r => r.id === si.rollo_id) : null;
    return { numero: rollo?.numero_rollo || '', peso: Number(si.cantidad||0), packing: si.packing_num || '', existing: true };
  });
  const filas = rollosExistentes.length ? rollosExistentes.map(r => renderRecRolloRow(gid, r)).join('') : renderRecRolloRow(gid, null);
  const requiereLote = state.productos.find(p=>p.id===item.producto_id)?.seguimiento === 'lote';
  return `
  <div class="rec-rollo-group" id="rec-rollo-group-${gid}" data-prod="${item.producto_id}" data-unidad="${item.unidad||''}" data-costo="${item.precio_unit||0}"
       style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;background:var(--surface)">
    <div style="display:flex;gap:10px;align-items:end;margin-bottom:8px">
      <div style="flex:1">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Lote${requiereLote?' <span style="color:var(--red)">*</span>':''}</div>
        <input type="text" id="rec-rollogrp-lote-${gid}" value="${lote||''}" placeholder="Número de lote"
          style="padding:6px 10px;border:1.5px solid ${requiereLote?'var(--red)':'var(--border)'};border-radius:6px;font-family:'DM Mono',monospace;font-size:13px;font-weight:600;width:100%"/>
      </div>
      <div style="font-size:12px;color:var(--text3);white-space:nowrap;padding-bottom:8px">
        Total: <strong id="rec-rollogrp-total-${gid}" style="color:var(--accent);font-family:'DM Mono',monospace">${rollosExistentes.reduce((s,r)=>s+r.peso,0).toFixed(3)}</strong> ${item.unidad||''}
      </div>
    </div>
    <div id="rec-rollos-list-${gid}">${filas}</div>
    <button type="button" class="btn btn-sm btn-ghost" style="font-size:11px" onclick="addRecRolloRow(${gid})">+ Agregar Rollo</button>
  </div>`;
}

function renderRecRolloRow(gid, r) {
  _recRolloRowCount++;
  const rid = _recRolloRowCount;
  // Rollos YA GUARDADOS quedan bloqueados al editar — mismo criterio que
  // renderRecLoteRow (22/Ago/2026). Nunca se re-procesan al guardar; para
  // devolver un rollo ya recibido se usa el flujo de Devolución, no editar
  // acá.
  const yaGuardado = !!r?.existing;
  const lockAttr   = yaGuardado ? 'disabled' : '';
  const lockBg     = yaGuardado ? 'background:var(--surface2);color:var(--text3)' : '';
  const accionCell = yaGuardado
    ? '<span style="font-size:10px;color:var(--green);font-weight:600;white-space:nowrap">✓ Guardado</span>'
    : `<button type="button" class="btn btn-ghost btn-sm" style="padding:5px 8px;color:var(--red)" onclick="document.getElementById('rec-rollo-row-${gid}-${rid}').remove();calcRecRolloGrpTotal(${gid})">✕</button>`;
  return `
  <div id="rec-rollo-row-${gid}-${rid}" data-existing="${yaGuardado?'1':'0'}" style="display:grid;grid-template-columns:1.2fr 1fr 1fr auto;gap:8px;align-items:end;margin-bottom:6px">
    <div>
      <div style="font-size:9px;color:var(--text3)">No. Rollo</div>
      <input type="text" id="rec-rollo-numero-${gid}-${rid}" value="${r?.numero||''}" placeholder="Ej. R-001" ${lockAttr}
        style="padding:5px 8px;border:1.5px solid var(--border);border-radius:5px;font-family:'DM Mono',monospace;font-size:12px;width:100%;${lockBg}"/>
    </div>
    <div>
      <div style="font-size:9px;color:var(--text3)">Peso (kg)</div>
      <input type="number" id="rec-rollo-peso-${gid}-${rid}" step="0.001" min="0" value="${r?.peso?r.peso.toFixed(3):''}" placeholder="0.000" ${lockAttr}
        style="padding:5px 8px;border:1.5px solid var(--accent);border-radius:5px;font-family:'DM Mono',monospace;font-size:12px;font-weight:600;color:var(--accent);width:100%;${lockBg}"
        oninput="calcRecRolloGrpTotal(${gid})"/>
    </div>
    <div>
      <div style="font-size:9px;color:var(--text3)">No. Packing List</div>
      <input type="text" id="rec-rollo-pl-${gid}-${rid}" value="${r?.packing||''}" placeholder="Opcional" ${lockAttr}
        style="padding:5px 8px;border:1.5px solid var(--border);border-radius:5px;font-family:'DM Mono',monospace;font-size:12px;width:100%;${lockBg}"/>
    </div>
    ${accionCell}
  </div>`;
}

function addRecRolloRow(gid) {
  const container = document.getElementById(`rec-rollos-list-${gid}`);
  if (!container) return;
  const div = document.createElement('div');
  div.innerHTML = renderRecRolloRow(gid, null);
  while (div.firstChild) container.appendChild(div.firstChild);
}

function calcRecRolloGrpTotal(gid) {
  const total = [...document.querySelectorAll(`#rec-rollos-list-${gid} [id^="rec-rollo-peso-${gid}-"]`)]
    .reduce((s,el) => s + (parseFloat(el.value)||0), 0);
  const totalEl = document.getElementById(`rec-rollogrp-total-${gid}`);
  if (totalEl) totalEl.textContent = total.toFixed(3);
  calcRecVerificacion();
}

function addRecLoteRollos(productoId, unidad, costo) {
  const item = { producto_id: productoId, unidad, precio_unit: costo };
  const container = document.getElementById(`rec-lotes-${productoId}`);
  if (!container) { toast('Error: no se encontró el contenedor del producto','error'); return; }
  const div = document.createElement('div');
  div.innerHTML = renderRecLoteRowRollos(item, '', [], currentOCId || document.getElementById('rec-oc-id')?.value);
  while (div.firstChild) container.appendChild(div.firstChild);
}

function renderPLCascadeSection3(cajas, productoId) {
  const prod = state.productos.find(p=>p.id===productoId);
  // Group by lote
  const porLote = {};
  cajas.forEach(c => {
    const k = c.lote || '(sin lote)';
    if (!porLote[k]) porLote[k] = [];
    porLote[k].push(c);
  });

  const html = Object.entries(porLote).map(([lote, cajasL]) => {
    const recibidas   = cajasL.filter(c=>c.recibido);
    const noRecibidas = cajasL.filter(c=>!c.recibido);
    const totalPN     = recibidas.reduce((s,c)=>s+c.pn,0);

    const cajasHtml = cajasL.map(c => `
      <tr style="border-bottom:1px solid var(--border)">
        <td style="padding:4px 8px 4px 24px;font-family:'DM Mono',monospace;font-size:11px">${c.no_caja||'—'}</td>
        <td style="padding:4px 8px;text-align:right;font-family:'DM Mono',monospace;font-size:11px">${c.conos||'—'}</td>
        <td style="padding:4px 8px;text-align:right;font-family:'DM Mono',monospace;font-size:11px">${c.pn_lbs?.toFixed(2)||'—'} lbs</td>
        <td style="padding:4px 8px;text-align:right;font-family:'DM Mono',monospace;font-size:11px;font-weight:600;color:var(--accent)">${c.pn?.toFixed(3)||'—'} kg</td>
        <td style="padding:4px 8px;text-align:center">
          <span style="font-size:13px">${c.recibido ? '✅' : '⬜'}</span>
        </td>
      </tr>`).join('');

    return `
    <div style="margin-bottom:12px;border:1.5px solid var(--border);border-radius:8px;overflow:hidden">
      <div style="padding:8px 12px;background:var(--surface2);display:flex;justify-content:space-between;align-items:center">
        <span style="font-family:'DM Mono',monospace;font-size:13px;font-weight:700;color:var(--accent)">${lote}</span>
        <div style="font-size:11px;color:var(--text3)">
          <span style="color:var(--green);font-weight:600">${recibidas.length} recibidas</span>
          ${noRecibidas.length>0?` · <span style="color:var(--red)">${noRecibidas.length} no recibidas</span>`:''}
          &nbsp;·&nbsp; <strong>${totalPN.toFixed(3)} kg</strong>
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--surface)">
          <th style="padding:4px 8px 4px 24px;text-align:left;font-size:10px;color:var(--text3)">No. Caja</th>
          <th style="padding:4px 8px;text-align:right;font-size:10px;color:var(--text3)">Conos</th>
          <th style="padding:4px 8px;text-align:right;font-size:10px;color:var(--text3)">P. Neto (lbs)</th>
          <th style="padding:4px 8px;text-align:right;font-size:10px;color:var(--text3)">P. Neto (kg)</th>
          <th style="padding:4px 8px;text-align:center;font-size:10px;color:var(--text3)">✓</th>
        </tr></thead>
        <tbody>${cajasHtml}</tbody>
      </table>
    </div>`;
  }).join('');

  // rec-pl-section removed
}

function openPLModalForLote(productoId, lote, rowN) {
  // Store which lote row we're editing
  document.getElementById('pl-rec-lote-row').value = rowN;
  openPLModal(productoId, lote);
}

function calcRecVerificacion() {
  const ocId = document.getElementById('rec-oc-id')?.value;
  const items = state.ocItems.filter(i=>i.oc_id===ocId);
  let html = '';
  let allOk = true;

  items.forEach(i => {
    const prod = state.productos.find(p=>p.id===i.producto_id);
    const qtyPedido = Number(i.cantidad||0);
    // Sum all lote rows for this product (lotes sueltos)
    let qtyTotal = 0;
    document.querySelectorAll(`[id^="rec-qty-${i.producto_id}-"]`).forEach(el => {
      qtyTotal += parseFloat(el.value)||0;
    });
    // + pesos de rollos, para productos con agrupación (21/Ago/2026) —
    // estos no usan rec-qty-*, viven en grupos .rec-rollo-group con
    // data-prod=<producto_id>.
    document.querySelectorAll(`.rec-rollo-group[data-prod="${i.producto_id}"]`).forEach(grp => {
      const gid = grp.id.replace('rec-rollo-group-','');
      grp.querySelectorAll(`[id^="rec-rollo-peso-${gid}-"]`).forEach(el => {
        qtyTotal += parseFloat(el.value)||0;
      });
    });
    const diff = qtyTotal - qtyPedido;
    const ok   = Math.abs(diff) < 0.001;
    if (!ok) allOk = false;
    html += `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:6px;margin-bottom:6px;background:${ok?'#F0FDF4':'#FFF7ED'}">
      <span style="font-size:12px;font-weight:500">${prod?.description||prodName(i.producto_id)}</span>
      <div style="display:flex;gap:16px;font-family:'DM Mono',monospace;font-size:12px">
        <span style="color:var(--text3)">Pedido: ${qtyPedido.toFixed(3)}</span>
        <span style="color:var(--text2)">A recibir: ${qtyTotal.toFixed(3)}</span>
        <span style="color:${ok?'#16A34A':diff>0?'#D97706':'#DC2626'};font-weight:700">
          ${ok ? '✓ OK' : diff>0 ? `+${diff.toFixed(3)} exceso` : `${diff.toFixed(3)} faltante`}
        </span>
      </div>
    </div>`;
  });

  // rec-verificacion removed
}



function calcRecTotales() {
  const items = state.ocItems.filter(i=>i.oc_id===currentOCId);
  // Get moneda from first item's erp_oc_items.moneda
  const monedaOC  = items[0]?.moneda || 'GTQ';
  const unidad    = items[0]?.unidad || 'unidad';
  const costoUnit = Number(items[0]?.precio_unit||0); // from erp_oc_items.precio_unit
  let totalQty = 0, totalCosto = 0;
  items.forEach(i=>{
    const qty   = parseFloat(document.getElementById(`rec-qty-${i.producto_id}`)?.value)||0;
    const costo = Number(i.precio_unit||0);
    totalQty   += qty;
    totalCosto += qty * costo;
  });
  const el = document.getElementById('rec-totales');
  if (el) el.innerHTML = `
    <div class="stat-card" style="padding:10px 16px">
      <div class="stat-label">Total a Recibir</div>
      <div style="font-size:18px;font-weight:700;font-family:'DM Mono',monospace">${fmtNum(totalQty)} ${unidad}</div>
    </div>
    <div class="stat-card" style="padding:10px 16px">
      <div class="stat-label">Costo / Unidad</div>
      <div style="font-size:18px;font-weight:700;font-family:'DM Mono',monospace">${fmtMoney(costoUnit, monedaOC)}</div>
    </div>
    <div class="stat-card" style="padding:10px 16px">
      <div class="stat-label">Valor Total Recepción</div>
      <div style="font-size:18px;font-weight:700;font-family:'DM Mono',monospace;color:var(--accent3)">${fmtMoney(totalCosto, monedaOC)}</div>
    </div>`;
}

let _recLineCount = 0;
let _savingRecepcion = false;
function addRecLine() {
  const ocId   = document.getElementById('rec-oc-id').value;
  const items  = state.ocItems.filter(i => i.oc_id === ocId);
  const container = document.getElementById('rec-lines-container');
  _recLineCount++;
  const lineId = `rec-extra-${_recLineCount}`;

  // Build product options
  const opts = '<option value="">— Seleccionar producto —</option>' +
    items.map(i => {
      const p = state.productos.find(x=>x.id===i.producto_id);
      return `<option value="${i.producto_id}">${p?.codigo_interno||p?.code||'?'} — ${p?.description||'?'}</option>`;
    }).join('');

  const inp = (id,type='text',extra='') =>
    `<input type="${type}" id="${id}" ${extra}
      style="padding:6px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:'DM Mono',monospace;font-size:12px;width:100%;background:var(--surface)"/>`;

  const div = document.createElement('div');
  div.id = lineId;
  div.style.cssText = 'border:1.5px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:10px;background:#FFFBEB';
  div.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border)">
      <select id="${lineId}-prod" style="flex:1;padding:6px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px;margin-right:8px"
        onchange="onRecLineProductoChange('${lineId}')">
        ${opts}
      </select>
      <button onclick="document.getElementById('${lineId}').remove();calcRecTotales()" 
        class="btn btn-sm btn-danger">✕</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1.2fr;gap:10px;margin-bottom:10px">
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:3px">Recibir Ahora *</div>
        <input type="number" id="${lineId}-qty" step="0.001" min="0" value="0" oninput="calcRecTotales()"
          style="padding:6px 8px;border:1.5px solid var(--accent);border-radius:6px;font-family:'DM Mono',monospace;font-size:14px;font-weight:600;width:100%;color:var(--accent)"/>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1.2fr 1.2fr 2fr 1fr 1.2fr 1.2fr;gap:10px;align-items:end;padding-top:10px;border-top:1px solid var(--border)">
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:3px">No. Envío</div>
        ${inp(`${lineId}-envio`,'text','placeholder="Ej. 126-RE"')}
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:3px">No. Lista Empaque</div>
        ${inp(`${lineId}-packing`,'text','placeholder="Ej. PL-0001"')}
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:3px">Lote</div>
        ${inp(`${lineId}-lote`,'text','placeholder="Lote"')}
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:3px">Póliza</div>
        ${inp(`${lineId}-poliza`,'text','')}
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:3px">KG MP</div>
        ${inp(`${lineId}-poliza-kg`,'number','step="0.001"')}
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:3px">FV Póliza</div>
        ${inp(`${lineId}-poliza-fv`,'date','')}
      </div>
    </div>`;
  container.appendChild(div);
}

function onRecLineProductoChange(lineId) {
  // Could auto-fill defaults per product in future
}

function getExtraRecLines() {
  const extras = [];
  document.querySelectorAll('[id^="rec-extra-"]').forEach(div => {
    const lineId  = div.id;
    const prodId  = document.getElementById(`${lineId}-prod`)?.value;
    const qty     = parseFloat(document.getElementById(`${lineId}-qty`)?.value)||0;
    if (!prodId || qty <= 0) return;
    const ocId    = document.getElementById('rec-oc-id').value;
    const ocItem  = state.ocItems.find(i=>i.oc_id===ocId && i.producto_id===prodId);
    extras.push({
      producto_id:  prodId,
      unidad:       ocItem?.unidad||'',
      cantidad:     qty,
      costo_unit:   Number(ocItem?.precio_unit||0),
      envio_numero: document.getElementById(`${lineId}-envio`)?.value.trim().toUpperCase()||null,
      packing_num:  document.getElementById(`${lineId}-packing`)?.value.trim()||null,
      lote:         document.getElementById(`${lineId}-lote`)?.value.trim().toUpperCase()||null,
      poliza:       document.getElementById(`${lineId}-poliza`)?.value.trim()||null,
      poliza_kg_mp: parseFloat(document.getElementById(`${lineId}-poliza-kg`)?.value)||null,
      poliza_fv:    document.getElementById(`${lineId}-poliza-fv`)?.value||null,
      estado:       'recibido',
    });
  });
  return extras;
}
async function saveRecepcion() {
  if (_savingRecepcion) return;
  _savingRecepcion = true;
  const btn = document.querySelector('#modal-recepcion .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Guardando...'; }

  try {
    const ocId     = document.getElementById('rec-oc-id').value;
    const fecha    = document.getElementById('rec-fecha').value;
    const numero   = document.getElementById('rec-num').value;
    const bodega_id = document.getElementById('rec-bodega')?.value || null;
    const envioHdr = document.getElementById('rec-envio-header')?.value.trim().toUpperCase()||'';
    const tracking = document.getElementById('rec-tracking')?.value.trim()||'';
    const notas    = document.getElementById('rec-notas')?.value.trim()||'';

    if (!fecha) { toast('Fecha requerida','error'); return; }

    const oc       = state.oc.find(o => o.id === ocId);
    const items    = state.ocItems.filter(i => i.oc_id === ocId);
    const monedaOC = items[0]?.moneda || 'GTQ';
    const recItems = [];

    // SUBCONTRATO — recibir producto (20/Ago/2026, a pedido explícito): "en
    // la subcontrata debes contabilizar el movimiento de la MP entregada
    // para conversión... entonces ingresaría a inv prod proceso MP y
    // saldría a inventario producto siguiente MP + Costo servicio de
    // conversión." La MP ya entró a Proceso al momento de asignar el lote
    // (ver confirmarAsignacionLotes) — acá, al recibir la tela ya
    // convertida, sale de Proceso (por el costo de la MP) y entra al
    // producto siguiente por MP + conversión. El costo de conversión por kg
    // ya vive en `item.costo_unit` (viene de la línea de la OC,
    // costoServPorKg) — el de MP se prorratea desde el total ya asignado en
    // erp_reabastecimiento para esta OC, entre la cantidad total pedida.
    //
    // FIX (22/Ago/2026, reportado en vivo — AS-2026-00006): el denominador
    // anterior era cantidadOCTot (la cantidad total PEDIDA en la OC, ej.
    // 500 kg de producto terminado) — esto daba un costo/kg absurdamente
    // bajo cuando solo se había reabastecido parcialmente (ej. 25 kg de MP
    // para un pedido de 500 → Q502.97/500 = Q1.006/kg, en vez del valor
    // real ~Q21.73/kg). La fórmula correcta: costo promedio ponderado por
    // kg de INPUT × cantidadBase × (1 + merma%) = costo por kg de OUTPUT.
    // Esto es independiente de cuánto se haya pedido en la OC o cuánto se
    // esté recibiendo ahora — es una propiedad del insumo y la receta.
    const esSubOC = oc?.tipo_oc === 'subcontrato';
    let costoMPPorKgOC = 0;
    if (esSubOC) {
      const reabOC       = (state.reabastecimiento||[]).filter(r => r.oc_id === ocId);
      const totalMPCosto = reabOC.reduce((s,r) => s + Math.max(0, Number(r.cantidad||0)-cantidadDevueltaReab(r.id))*Number(r.costo_unitario||0), 0);
      const totalMPQty   = reabOC.reduce((s,r) => s + Math.max(0, Number(r.cantidad||0)-cantidadDevueltaReab(r.id)), 0);
      const costoPromPorKgInput = totalMPQty > 0 ? totalMPCosto / totalMPQty : 0;
      // Merma y cantidadBase de la receta: puede haber hasta 4 insumos
      // distintos (a pedido explícito, 22/Ago/2026 — "pueden haber más
      // insumos, por lo general es 1 pero puede llegar hasta 4"). Cada
      // insumo contribuye su parte al costo del kg de output según su
      // propio cantidadBase y merma_pct.
      // costoMPPorKgOutput = Σ costoPromInput_i/kgInput_i × cantBase_i × (1+merma_i%)
      const recetaOC = oc.receta_id ? (state.recetas||[]).find(r => r.id === oc.receta_id) : null;
      const recetaLineas = recetaOC ? (state.recetaLineas||[]).filter(l => l.receta_id === recetaOC.id) : [];
      if (recetaLineas.length > 0) {
        costoMPPorKgOC = recetaLineas.reduce((suma, lineaMP) => {
          // Filtrar los lotes de reabastecimiento correspondientes a ESTE insumo
          const reabEsteInsumo = reabOC.filter(r => r.insumo_id === lineaMP.insumo_id);
          const costoTotalInsumo = reabEsteInsumo.reduce((s,r) => s + Math.max(0, Number(r.cantidad||0)-cantidadDevueltaReab(r.id))*Number(r.costo_unitario||0), 0);
          const kgTotalInsumo    = reabEsteInsumo.reduce((s,r) => s + Math.max(0, Number(r.cantidad||0)-cantidadDevueltaReab(r.id)), 0);
          const costoPromInput   = kgTotalInsumo > 0 ? costoTotalInsumo / kgTotalInsumo : 0;
          const cantBase = Number(lineaMP.cantidad_base||1);
          const mermaPct = Number(lineaMP.merma_pct||0);
          return suma + costoPromInput * cantBase * (1 + mermaPct/100);
        }, 0);
      } else {
        // Fallback sin receta: misma lógica del caso de 1 insumo pero sin merma
        costoMPPorKgOC = totalMPQty > 0 ? totalMPCosto / totalMPQty : 0;
      }
    }

    // Read from new lote rows: rec-lote-val-N, rec-qty-{prod}-N, rec-pl-val-N
    // (el No. de Packing List se ingresa por lote, no un único valor de header).
    document.querySelectorAll('[id^="rec-lote-val-"]').forEach(el => {
      const n = el.id.replace('rec-lote-val-','');
      // Filas ya guardadas (bloqueadas al editar) se ignoran por completo —
      // nunca se reprocesan, evita duplicar cantidad/costo en inventario.
      if (document.getElementById(`rec-lote-row-${n}`)?.dataset.existing === '1') return;
      const lote   = el.value.trim() || null;
      const prodId = el.dataset.prod;
      const unidad = el.dataset.unidad || '';
      const costo  = parseFloat(el.dataset.costo)||0;
      const qtyEl  = document.getElementById(`rec-qty-${prodId}-${n}`);
      const qty    = parseFloat(qtyEl?.value)||0;
      const packing = document.getElementById(`rec-pl-val-${n}`)?.value.trim() || null;
      if (qty > 0) {
        recItems.push({
          producto_id:  prodId,
          unidad,
          cantidad:     qty,
          costo_unit:   costo,
          lote,
          poliza:       null,
          envio_numero: envioHdr || null,
          packing_num:  packing,
          estado:       'recibido',
        });
      }
    });

    // Read from rollo groups (productos con agrupación por bulto/rollo) —
    // un recItem POR ROLLO, no agregado, cada uno con _numeroRollo marcado
    // para que el loop de guardado más abajo cree su propio erp_rollos y
    // lo ligue vía rollo_id (21/Ago/2026, a pedido explícito).
    document.querySelectorAll('.rec-rollo-group').forEach(grp => {
      const gid    = grp.id.replace('rec-rollo-group-','');
      const prodId = grp.dataset.prod;
      const unidad = grp.dataset.unidad || '';
      const costo  = parseFloat(grp.dataset.costo)||0;
      const lote   = document.getElementById(`rec-rollogrp-lote-${gid}`)?.value.trim() || null;
      grp.querySelectorAll(`[id^="rec-rollo-numero-${gid}-"]`).forEach(numEl => {
        const rid    = numEl.id.replace(`rec-rollo-numero-${gid}-`,'');
        // Filas ya guardadas (bloqueadas al editar) se ignoran — nunca se
        // reprocesan, evita crear un rollo duplicado.
        if (document.getElementById(`rec-rollo-row-${gid}-${rid}`)?.dataset.existing === '1') return;
        const numero = numEl.value.trim();
        const peso   = parseFloat(document.getElementById(`rec-rollo-peso-${gid}-${rid}`)?.value)||0;
        const pl     = document.getElementById(`rec-rollo-pl-${gid}-${rid}`)?.value.trim() || null;
        if (peso > 0) {
          recItems.push({
            producto_id:  prodId,
            unidad,
            cantidad:     peso,
            costo_unit:   costo,
            lote,
            poliza:       null,
            envio_numero: envioHdr || null,
            packing_num:  pl,
            estado:       'recibido',
            _numeroRollo: numero || null,
          });
        }
      });
    });

    if (!recItems.length) { toast('Ingresa al menos una cantidad a recibir','error'); return; }

    // Lote obligatorio para productos con seguimiento por lote (21/Ago/2026,
    // a pedido explícito — "si el producto tiene en su configuración
    // seguimiento por lote, debemos ingresar el número de lote
    // obligatoriamente"). erp_productos.seguimiento ya existía en la ficha
    // de producto pero nunca se validaba en ningún flujo — se conecta acá.
    for (const item of recItems) {
      const prodSeg = state.productos.find(p => p.id === item.producto_id);
      if (prodSeg?.seguimiento === 'lote' && !item.lote) {
        toast(`${prodSeg.description||prodSeg.code||'Este producto'} requiere número de lote (configurado como "Por lote") — completá el campo Lote antes de recibir.`,'error');
        return;
      }
    }

    // Rollo duplicado — mismo criterio de unicidad que la base de datos
    // (producto + lote + número de rollo, 22/Ago/2026, reportado en vivo:
    // "duplicate key value violates unique constraint
    // erp_rollos_numero_rollo_key" al repetir un número de rollo entre
    // lotes distintos de la misma recepción). Se valida ANTES de empezar a
    // guardar, contra rollos ya existentes Y contra los que se están por
    // crear en esta misma recepción, para no dejar la recepción a medias.
    {
      const vistos = new Set();
      for (const item of recItems) {
        if (!item._numeroRollo) continue;
        const key = `${item.producto_id}|${item.lote||''}|${item._numeroRollo}`;
        if (vistos.has(key) || (state.rollos||[]).some(r => r.producto_id===item.producto_id && (r.lote||'')===(item.lote||'') && r.numero_rollo===item._numeroRollo)) {
          toast(`Ya existe un rollo "${item._numeroRollo}" en el lote "${item.lote||'(sin lote)'}" — usá un número distinto.`,'error');
          return;
        }
        vistos.add(key);
      }
    }

    // Costo cero en compra (26/Ago/2026, a pedido explícito). Se valida ACÁ,
    // junto al resto de validaciones previas, y no solo dentro de
    // crearMovimiento(): esa guarda existe y funciona, pero se dispara cuando
    // saveRecepcion ya insertó la cabecera de la recepción, dejando una fila
    // huérfana sin ítems ni movimiento (detectado en pruebas: 2 recepciones
    // contra 1 ítem). Validando antes de la primera escritura, la operación
    // se aborta sin tocar la base.
    //
    // Costo cero solo es válido en materia prima en consignación, que no pasa
    // por este flujo de recepción de OC.
    {
      const sinCosto = recItems.filter(it => !(Number(it.costo_unit) > 0));
      if (sinCosto.length) {
        const nombres = sinCosto.map(it => {
          const p = state.productos.find(x => x.id === it.producto_id);
          return p?.description || p?.code || it.producto_id;
        });
        toast(
          `No se puede recibir con costo cero: ${nombres.join(', ')}. ` +
          `El inventario se capitalizaría en Q0 y ese cero se propagaría al costeo FIFO ` +
          `y al costo de venta. Corregí el precio unitario en la orden de compra.`,
          'error'
        );
        return;
      }
    }

    // Resumen de No. de PL para el header (informativo — la fuente real es por línea).
    const packingRollup = [...new Set(recItems.map(it=>it.packing_num).filter(Boolean))].join(', ') || null;

    // Tolerancia de sobre-recepción (22/Ago/2026, a pedido explícito —
    // "hay veces por humedad o mejor eficiencia que se produce un poco
    // más de lo estipulado por la merma"). No se compara contra
    // reabastecimiento (eso es un tema de insumo, no de producto
    // recibido) — se compara contra lo PEDIDO en la OC, con 3% de margen
    // automático. Si se excede ese 3%, se exige justificación manual
    // (texto obligatorio) antes de continuar — queda guardada en las
    // notas de la recepción para auditoría.
    const TOLERANCIA_SOBRE_RECEPCION = 0.03;
    let notasOverride = '';
    {
      const existingRecCheck = (state.ocRecepciones||[]).find(r => r.numero===numero && r.oc_id===ocId);
      const prevItemsThisRec = existingRecCheck
        ? (state.ocRecepcionItems||[]).filter(x=>x.recepcion_id===existingRecCheck.id)
        : [];
      const nuevoPorProducto = {};
      recItems.forEach(it => { nuevoPorProducto[it.producto_id] = (nuevoPorProducto[it.producto_id]||0) + Number(it.cantidad||0); });
      for (const prodId of Object.keys(nuevoPorProducto)) {
        const ocItem = items.find(i => i.producto_id === prodId);
        if (!ocItem) continue;
        const pedido = Number(ocItem.cantidad||0);
        const yaRecibidoOtras = ocRecibidoQty(ocId, prodId) -
          prevItemsThisRec.filter(x=>x.producto_id===prodId).reduce((s,x)=>s+Number(x.cantidad||0),0);
        const disponible = pedido - yaRecibidoOtras;
        const disponibleConTolerancia = (pedido * (1 + TOLERANCIA_SOBRE_RECEPCION)) - yaRecibidoOtras;
        const prod = state.productos.find(p=>p.id===prodId);

        if (nuevoPorProducto[prodId] > disponibleConTolerancia + 0.001) {
          // Excede incluso la tolerancia — bloquea, igual que antes.
          toast(`No puedes recibir ${nuevoPorProducto[prodId].toFixed(3)} ${ocItem.unidad||''} de ${prod?.description||'este producto'}: excede incluso la tolerancia del 3% (ya recibido ${yaRecibidoOtras.toFixed(3)} de ${pedido.toFixed(3)} pedidos — máximo con tolerancia: ${Math.max(0,disponibleConTolerancia).toFixed(3)}).`,'error');
          return;
        }
        if (nuevoPorProducto[prodId] > disponible + 0.001) {
          // Dentro de la tolerancia pero por encima de lo pedido — exige
          // justificación manual antes de continuar.
          const exceso = nuevoPorProducto[prodId] - disponible;
          const motivo = prompt(`Vas a recibir ${exceso.toFixed(3)} ${ocItem.unidad||''} más de lo pedido para ${prod?.description||'este producto'} (dentro del 3% de tolerancia). Escribí el motivo (ej. "humedad", "mejor eficiencia del proceso") para continuar:`);
          if (!motivo || !motivo.trim()) { toast('Se requiere un motivo para recibir por encima de lo pedido — recepción cancelada.','error'); return; }
          notasOverride += `${notasOverride?' | ':''}Sobre-recepción ${prod?.description||prodId}: +${exceso.toFixed(3)} ${ocItem.unidad||''} — motivo: ${motivo.trim()}`;
        }
      }
    }

    // Create or update recepcion header
    const existingRec = (state.ocRecepciones||[]).find(r => r.numero===numero && r.oc_id===ocId);
    let rec;
    if (existingRec) {
      const notasFinal = [existingRec.notas, notasOverride].filter(Boolean).join(' | ') || null;
      const { data, error:e1 } = await sb.from('erp_oc_recepciones')
        .update({ status:'completada', bodega_id: bodega_id||null, envio_numero: envioHdr||null, packing_num: packingRollup, notas: notasFinal })
        .eq('id', existingRec.id).select().single();
      if (e1) { toast('Error actualizando recepción: '+e1.message,'error'); return; }
      rec = data;
      // Delete borrador items
      await sb.from('erp_oc_recepcion_items').delete().eq('recepcion_id', rec.id).eq('estado','borrador');
    } else {
      const { data, error:e1 } = await sb.from('erp_oc_recepciones').insert({
        oc_id: ocId, numero, fecha, status: 'completada',
        bodega_id: bodega_id||null, envio_numero: envioHdr||null, packing_num: packingRollup,
        notas: notasOverride || null,
      }).select().single();
      if (e1) { toast('Error creando recepción: '+e1.message,'error'); return; }
      rec = data;
    }

    // Create items + inventory movements
    for (const item of recItems) {
      // Si esta línea viene de un grupo de rollos (producto con
      // agrupación), crear primero el rollo — mismo estado inicial que
      // los rollos que produce una OP interna ('disponible') — y ligarlo
      // vía rollo_id en el item de recepción (21/Ago/2026, a pedido
      // explícito).
      let rolloIdCreado = null;
      if (item._numeroRollo) {
        const { data: rolloData, error: rolloErr } = await sb.from('erp_rollos').insert({
          numero_rollo: item._numeroRollo, producto_id: item.producto_id,
          peso_kg: item.cantidad, bodega_id: bodega_id||null,
          estado: 'disponible', lote: item.lote,
        }).select().single();
        if (rolloErr) { alert('Error creando rollo:\n' + rolloErr.message); throw new Error(rolloErr.message); }
        rolloIdCreado = rolloData.id;
      }
      if (esSubOC) {
        // Recepción de subcontrato: costo total = MP + conversión. El
        // movimiento de inventario entra al costo TOTAL (así el stock/kardex
        // del producto recibido queda bien valorado); el asiento se arma a
        // mano (3 líneas) en vez de usar crearMovimientoConAsiento, porque
        // esa función genérica solo sabe hacer el asiento estándar de
        // compra (Debe Valoración / Haber Entrada) — acá hace falta separar
        // la contrapartida entre Proceso (MP) y el proveedor (conversión).
        //
        // FIX (22/Ago/2026, reportado en vivo — AS-2026-00006 daba
        // conversión Q7.14 en vez de Q54.43): costoMPPorKgOC viene de
        // erp_reabastecimiento.costo_unitario, que a su vez sale de
        // calcStockPorLote()/calcStockFIFO() — esas funciones YA prefieren
        // costo_unitario_gtq sobre el nativo, así que montoMP YA está en
        // GTQ, no se vuelve a convertir. PERO item.costo_unit viene
        // directo de erp_oc_items.precio_unit, en la moneda NATIVA de esa
        // línea (frecuentemente USD para servicio de conversión) — nunca
        // se convertía a GTQ antes de entrar al asiento. Se corrige acá,
        // igual criterio que usa crearMovimiento() para el resto del
        // sistema (moneda==='USD' → multiplicar por TC de la fecha).
        const itemOCConv = state.ocItems.find(oi => oi.oc_id === oc.id && oi.producto_id === item.producto_id);
        const monedaConv = itemOCConv?.moneda || monedaOC || 'GTQ';
        const tcConv      = getTCFecha(fecha) || tcHoy() || 1;
        const costoUnitConvGTQ = monedaConv === 'USD' ? parseFloat((item.costo_unit * tcConv).toFixed(4)) : item.costo_unit;

        const montoMP    = parseFloat((item.cantidad * costoMPPorKgOC).toFixed(4));
        const montoConv  = parseFloat((item.cantidad * costoUnitConvGTQ).toFixed(4));
        const montoTotal = parseFloat((montoMP + montoConv).toFixed(4));
        await crearMovimiento({
          tipo: 'entrada', producto_id: item.producto_id,
          cantidad: item.cantidad, costo_unitario: parseFloat((costoMPPorKgOC + costoUnitConvGTQ).toFixed(4)),
          referencia_tipo: 'OC', referencia_id: numero,
          notas: `Recepción ${numero} — subcontrato: MP Q${montoMP.toFixed(2)} + conversión Q${montoConv.toFixed(2)}${item.lote?' | Lote:'+item.lote:''}`,
          fecha, lote: item.lote, poliza: item.poliza,
          moneda: 'GTQ', bodega_id: bodega_id||null,
        });
        if (montoTotal > 0) {
          const ctaValoracionRec = getCtaValoracionProducto(item.producto_id);
          const ctaProcesoRec    = state.nomenclatura.find(n => n.codigo === CTA_INV_PROCESO);
          const ctaPorPagarRec   = state.nomenclatura.find(n => n.tipo === 'Por pagar');
          const provSubRec       = state.proveedores.find(p => p.id === oc.proveedor_id);
          const lineasRec = [
            {
              cuenta_id: ctaValoracionRec?.id||null, cuenta_codigo: ctaValoracionRec?.codigo||'',
              cuenta_nombre: ctaValoracionRec?.nombre||'Inventario', debe: montoTotal, haber: 0,
              descripcion: `${item.cantidad} kg recibidos — MP + conversión`,
            },
          ];
          if (montoMP > 0) lineasRec.push({
            cuenta_id: ctaProcesoRec?.id||null, cuenta_codigo: CTA_INV_PROCESO,
            cuenta_nombre: ctaProcesoRec?.nombre||'Inventario en Proceso', debe: 0, haber: montoMP,
            descripcion: 'Cierre WIP — MP entregada a subcontratista',
          });
          if (montoConv > 0) lineasRec.push({
            cuenta_id: ctaPorPagarRec?.id||null, cuenta_codigo: ctaPorPagarRec?.codigo||'',
            cuenta_nombre: provSubRec?.name||'Servicio de conversión', debe: 0, haber: montoConv,
            descripcion: `Servicio de conversión — ${provSubRec?.name||'sin proveedor'}`,
          });
          await crearAsiento({
            diario: DIARIO_MANUFACTURA, fecha,
            descripcion: `Recepción ${numero} — subcontrato: MP (Q${montoMP.toFixed(2)}) + conversión (Q${montoConv.toFixed(2)})`,
            referencia: numero, referencia_id: ocId,
            moneda: 'GTQ', tipo_cambio: 1,
            lineas: lineasRec,
          });
        }
      } else {
        await crearMovimientoConAsiento({
          tipo: 'entrada', producto_id: item.producto_id,
          cantidad: item.cantidad, costo_unitario: item.costo_unit,
          referencia_tipo: 'OC', referencia_id: numero,
          notas: `Recepción ${numero}${item.lote?' | Lote:'+item.lote:''}`,
          fecha, lote: item.lote, poliza: item.poliza,
          moneda: monedaOC, bodega_id: bodega_id||null,
        });
      }
      const { error:e2 } = await sb.from('erp_oc_recepcion_items').insert({
        recepcion_id: rec.id,
        producto_id:  item.producto_id,
        unidad:       item.unidad,
        cantidad:     item.cantidad,
        costo_unit:   item.costo_unit,
        envio_numero: item.envio_numero,
        packing_num:  item.packing_num,
        lote:         item.lote,
        poliza:       item.poliza,
        poliza_kg_mp: item.poliza_kg_mp,
        poliza_fv:    item.poliza_fv,
        estado:       'recibido',
        rollo_id:     rolloIdCreado,
        ...(item.pl_cajas ? {
          pl_cajas:            item.pl_cajas,
          pl_total_conos:      item.pl_total_conos||null,
          pl_peso_bruto_total: item.pl_peso_bruto_total||null,
          pl_peso_neto_total:  item.pl_peso_neto_total||null,
        } : {}),
      });
      if (e2) {
        alert('Error insertando item de recepción:\n\n' + e2.message + '\nCode: ' + (e2.code||'') + '\nDetails: ' + (e2.details||''));
        throw new Error(e2.message);
      }
    }

    // Reload and update OC status
    await loadAll();

    // Save PL cajas detail for hilo products
    for (const item of recItems) {
      if (item._plCajasDetalle?.length) {
        const monedaOC_pl = await getMonedaOC(ocId);
        const cajasRows = item._plCajasDetalle.map(c => ({
          recepcion_id: rec.id,
          oc_id:        ocId,
          producto_id:  item.producto_id,
          fecha,
          packing_num:  item.packing_num,
          lote:         c.lote || item.lote,
          poliza:       item.poliza,
          costo_unit:   item.costo_unit,
          moneda:       monedaOC_pl,
          no_caja:      c.no_caja,
          conos:        c.conos,
          peso_bruto:   c.pb,
          peso_neto:    c.pn,
          valor_total:  parseFloat((c.pn * item.costo_unit).toFixed(4)),
          estado:       c.recibido ? 'recibido' : 'no_recibido',
        }));
        const { error:ePlC } = await sb.from('erp_oc_pl').insert(cajasRows);
        if (ePlC) console.error('Error guardando PL cajas:', ePlC.message);
      }
    }

    const allItems    = state.ocItems.filter(i => i.oc_id === ocId);
    const allReceived = allItems.every(i => ocRecibidoQty(ocId, i.producto_id) >= Number(i.cantidad||0));

    // CIERRE DE RECEPCIÓN PARCIAL (26/Ago/2026, a pedido explícito).
    // Si quedó faltante, se pregunta si el pedido sigue abierto o se da por
    // cerrado. Antes quedaba SIEMPRE en 'recibiendo', así que una OC con un
    // embarque corto aceptado se quedaba abierta para siempre.
    // Solo se pregunta cuando hay faltante real: si se recibió todo, pasa a
    // 'completada' sin molestar al usuario.
    let cerrarConFaltante = false;
    if (!allReceived) {
      const pendientes = allItems
        .map(i => {
          const p = state.productos.find(x => x.id === i.producto_id);
          const falta = Number(i.cantidad||0) - ocRecibidoQty(ocId, i.producto_id);
          return falta > 0.0001
            ? `  · ${p?.description || p?.code || '—'}: faltan ${fmtNum(falta)} ${i.unidad||''}`
            : null;
        })
        .filter(Boolean);
      cerrarConFaltante = confirm(
        `Recepción parcial — queda producto pendiente:\n\n${pendientes.join('\n')}\n\n` +
        `¿Se dará por CERRADO este pedido?\n\n` +
        `• Aceptar = cerrar la OC como completada, aceptando el faltante.\n` +
        `• Cancelar = seguir recibiendo (la OC queda en "Recibiendo").\n\n` +
        `Lo ya recibido queda registrado en ambos casos.`
      );
    }

    await sb.from('erp_oc').update({
      status: (allReceived || cerrarConFaltante) ? 'completada' : 'recibiendo',
      // Solo se marca cuando se cerró ACEPTANDO faltante. Una OC que se
      // completó porque llegó todo mantiene la bandera en false.
      recepcion_cerrada: cerrarConFaltante,
    }).eq('id', ocId);
    await loadAll();

    logAuditoria('inventario', 'crear', 'Recepcion', rec.id, numero, { oc_id: ocId, items: recItems.length, cerrarConFaltante });
    closeModal('modal-recepcion');
    toast(
      `Recepción ${numero} confirmada — ${recItems.length} producto${recItems.length!==1?'s':''} ingresados a inventario` +
      (cerrarConFaltante ? ' · OC cerrada con faltante' : '')
    );
    showOCPanel(ocId);

  } catch(err) {
    // Las validaciones de negocio (ej. el bloqueo de costo cero en
    // crearMovimiento) llegan acá como excepción, igual que un fallo técnico.
    // Mostrarlas con el stack no le dice nada a quien está recibiendo
    // mercadería y hace parecer que el sistema se rompió, cuando en realidad
    // se defendió correctamente. Se separan los dos casos: el mensaje de
    // negocio se muestra limpio; el stack queda solo para lo inesperado.
    const esValidacion = /^Movimiento bloqueado:/.test(err.message||'');
    if (esValidacion) {
      alert(err.message.replace(/^Movimiento bloqueado:\s*/,'OPERACIÓN CANCELADA\n\n') +
            '\n\nNo se registró ningún movimiento.');
      console.warn('saveRecepcion — validación de negocio:', err.message);
    } else {
      alert('Error inesperado en saveRecepcion:\n\n' + err.message + '\n\n' + err.stack);
    }
  } finally {
    _savingRecepcion = false;
    if (btn) { btn.disabled = false; btn.textContent = '✓ Confirmar Recepción'; }
  }
}

// ── SCAN LISTA DE EMPAQUE (Recepción OC) ───────────────────────

function abrirScanRecepcion() {
  const area = document.getElementById('rec-scan-area');
  if (area) {
    area.style.display = area.style.display === 'none' ? 'block' : 'none';
    if (area.style.display === 'block') {
      document.getElementById('rec-scan-upload').style.display        = 'block';
      document.getElementById('rec-scan-processing').style.display    = 'none';
      document.getElementById('rec-scan-result-banner').style.display = 'none';
      document.getElementById('rec-scan-input').value = '';
    }
  }
}

function onRecScanDrop(event) {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (file) procesarScanRecepcion(file);
}

async function procesarScanRecepcion(file) {
  if (!file) return;
  const isPDF = file.type === 'application/pdf';
  const isImg = file.type.startsWith('image/');
  if (!isPDF && !isImg) { toast('Formato no soportado. Usa JPG, PNG o PDF','error'); return; }

  document.getElementById('rec-scan-upload').style.display        = 'none';
  document.getElementById('rec-scan-processing').style.display    = 'block';
  document.getElementById('rec-scan-result-banner').style.display = 'none';

  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl  = e.target.result;
    const b64      = dataUrl.split(',')[1];
    const mediaType = file.type;

    // Get OC items for context
    const ocItems = state.ocItems.filter(i=>i.oc_id===currentOCId);
    const productos = ocItems.map(i=>{
      const p = state.productos.find(x=>x.id===i.producto_id);
      return `- ${p?.codigo_interno||p?.code||'?'} | ${p?.description||'?'} | Pedido: ${i.cantidad} ${i.unidad||'kg'}`;
    }).join('\n');

    const prompt = `Eres un asistente de almacén. Analiza este documento (lista de empaque, packing list, delivery note o factura de entrega) y extrae la información de los productos recibidos.

Los productos en la orden de compra son:
${productos}

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional:
{
  "numero_documento": "número de lista de empaque o referencia del documento",
  "fecha": "YYYY-MM-DD (fecha del documento)",
  "proveedor": "nombre del proveedor si aparece",
  "tracking": "número de guía, AWB, o tracking si aparece",
  "notas": "observaciones relevantes del documento",
  "lineas": [
    {
      "descripcion": "descripción del producto tal como aparece en el documento",
      "codigo": "código del producto si aparece",
      "cantidad": 0.000,
      "unidad": "kg|yds|mts|unidades",
      "lote": "número de lote si aparece",
      "poliza": "número de póliza de importación si aparece",
      "costo_unitario": 0.0000
    }
  ],
  "confianza": "alta|media|baja"
}`;

    try {
      const content = isPDF
        ? [{ type:'document', source:{type:'base64',media_type:'application/pdf',data:b64}},{ type:'text',text:prompt}]
        : [{ type:'image',   source:{type:'base64',media_type:mediaType,data:b64}},           { type:'text',text:prompt}];

      const resp = await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:1500, messages:[{role:'user',content}] }),
      });
      if (!resp.ok) throw new Error(`API ${resp.status}`);
      const data = await resp.json();
      const raw  = data.content?.filter(b=>b.type==='text').map(b=>b.text).join('')||'';
      const doc  = JSON.parse(raw.replace(/```json|```/g,'').trim());

      aplicarScanRecepcion(doc);

    } catch(err) {
      console.error('Scan recepcion error:', err);
      document.getElementById('rec-scan-upload').style.display     = 'block';
      document.getElementById('rec-scan-processing').style.display = 'none';
      toast('No se pudo procesar el documento. Intenta de nuevo.','error');
    }
  };
  reader.readAsDataURL(file);
}

function aplicarScanRecepcion(doc) {
  document.getElementById('rec-scan-processing').style.display    = 'none';
  document.getElementById('rec-scan-upload').style.display        = 'none';

  // Fill header fields
  if (doc.fecha)           document.getElementById('rec-fecha').value        = doc.fecha;
  if (doc.numero_documento) document.getElementById('rec-packing-num').value = doc.numero_documento;
  if (doc.tracking)        document.getElementById('rec-tracking').value     = doc.tracking;
  if (doc.notas)           document.getElementById('rec-notas').value        = doc.notas;

  // Match scan lines to OC items by code or description similarity
  const ocItems = state.ocItems.filter(i=>i.oc_id===currentOCId);
  let matchCount = 0;

  doc.lineas?.forEach(linea => {
    // Try to match by code first, then by description
    const match = ocItems.find(i=>{
      const p = state.productos.find(x=>x.id===i.producto_id);
      return (linea.codigo && p?.code && p.code.toLowerCase().includes(linea.codigo.toLowerCase())) ||
             (p?.description && linea.descripcion &&
               p.description.toLowerCase().includes(linea.descripcion.toLowerCase().slice(0,10)));
    });
    if (match) {
      const qtyEl   = document.getElementById(`rec-qty-${match.producto_id}`);
      const loteEl  = document.getElementById(`rec-lote-${match.producto_id}`);
      const polizaEl= document.getElementById(`rec-poliza-${match.producto_id}`);
      const costoEl = document.getElementById(`rec-costo-${match.producto_id}`);
      if (qtyEl    && linea.cantidad)       { qtyEl.value   = Number(linea.cantidad).toFixed(3); matchCount++; }
      if (loteEl   && linea.lote)           loteEl.value    = linea.lote.toUpperCase();
      if (polizaEl && linea.poliza)         polizaEl.value  = linea.poliza;
      if (costoEl  && linea.costo_unitario) costoEl.value   = Number(linea.costo_unitario).toFixed(4);
    }
  });

  calcRecTotales();

  // Show result banner
  const banner = document.getElementById('rec-scan-result-banner');
  banner.style.display = 'flex';
  document.getElementById('rec-scan-result-text').textContent =
    `${matchCount} de ${ocItems.length} productos identificados automáticamente — Confianza: ${doc.confianza||'—'} | Revisa y corrige antes de confirmar`;
}

// ── Cruce de envíos en scan de factura ─────────────────────────
function renderScanEnviosCruce(envios, numeroOC, totalFactura) {
  const div = document.getElementById('scan-envios-cruce');
  if (!div) return;

  // Find OC by numero_oc
  const oc = (state.oc||[]).find(o =>
    numeroOC && ((o.numero||'').replace(/\D/g,'').endsWith(numeroOC) || (o.numero||'').includes(numeroOC))
  );

  // Find all recepcion items matching envio numbers
  const allItems = (state.ocRecepcionItems||[]);
  const matches  = envios.map(envio => {
    const item = allItems.find(i => (i.envio_numero||'').toUpperCase() === envio.toUpperCase());
    return { envio, item };
  });

  const totalKgs = matches.reduce((s,m) => s + Number(m.item?.cantidad||0), 0);

  div.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>No. Envío</th>
          <th>Estado en Sistema</th>
          <th style="text-align:right">KGs Recibidos</th>
          <th style="text-align:right">% del Total</th>
          <th style="text-align:right">Monto Asignado</th>
          <th>Producto</th>
        </tr></thead>
        <tbody>
          ${matches.map(({envio, item}) => {
            const pct   = totalKgs > 0 ? (Number(item?.cantidad||0) / totalKgs) * 100 : 0;
            const monto = totalFactura * pct / 100;
            const prod  = state.productos.find(p => p.id === item?.producto_id);
            const encontrado = !!item;
            return `<tr style="${!encontrado?'background:#FEF2F2':item.estado==='facturado'?'background:#FFFBEB':''}">
              <td class="td-mono" style="font-weight:700">${envio}</td>
              <td>${encontrado
                ? `<span class="badge ${item.estado==='recibido'?'badge-blue':item.estado==='facturado'?'badge-yellow':'badge-green'}">${item.estado}</span>`
                : '<span class="badge badge-red">⚠ No encontrado</span>'}</td>
              <td class="td-mono" style="text-align:right">${encontrado ? Number(item.cantidad||0).toFixed(3)+' kg' : '—'}</td>
              <td class="td-mono" style="text-align:right">${encontrado ? pct.toFixed(2)+'%' : '—'}</td>
              <td class="td-mono" style="text-align:right;font-weight:600;color:var(--accent3)">${encontrado ? fmtMoney(monto) : '—'}</td>
              <td style="font-size:12px">${prod?.description||'—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
        <tfoot><tr style="background:var(--surface2);font-weight:600">
          <td colspan="2" style="padding:8px 14px;font-size:12px">TOTALES</td>
          <td class="td-mono" style="text-align:right;padding:8px 14px">${totalKgs.toFixed(3)} kg</td>
          <td class="td-mono" style="text-align:right;padding:8px 14px">100%</td>
          <td class="td-mono" style="text-align:right;padding:8px 14px;color:var(--accent3)">${fmtMoney(totalFactura)}</td>
          <td></td>
        </tr></tfoot>
      </table>
    </div>
    ${matches.some(m => !m.item) ? `
      <div style="margin-top:10px;padding:10px 14px;background:#FEF2F2;border:1.5px solid #FECACA;border-radius:8px;font-size:12px;color:#DC2626">
        ⚠ Hay envíos no encontrados en el sistema. Verifica que fueron registrados antes de confirmar.
      </div>` : `
      <div style="margin-top:10px;padding:10px 14px;background:#ECFDF5;border:1.5px solid #A7F3D0;border-radius:8px;font-size:12px;color:#065F46">
        ✓ Todos los envíos encontrados. Al confirmar se marcarán como <strong>facturados</strong> y se asignará el monto prorrateado.
      </div>`}`;

  // Store for confirmar
  div._matches     = matches;
  div._totalKgs    = totalKgs;
  div._totalFact   = totalFactura;
}

// ── Factura OC ──
function focTab(tab) {
  // visibility (no display) para que ambos paneles sigan ocupando su celda del
  // grid y el modal no cambie de tamaño al alternar tabs.
  document.getElementById('foc-panel-datos').style.visibility   = tab==='datos'    ? 'visible' : 'hidden';
  document.getElementById('foc-panel-apuntes').style.visibility = tab==='apuntes'  ? 'visible' : 'hidden';
  document.getElementById('foc-tab-datos').style.background    = tab==='datos'    ? 'var(--bg)' : 'transparent';
  document.getElementById('foc-tab-datos').style.color         = tab==='datos'    ? 'var(--accent)' : 'var(--text3)';
  document.getElementById('foc-tab-datos').style.borderBottom  = tab==='datos'    ? '2px solid var(--accent)' : 'none';
  document.getElementById('foc-tab-apuntes').style.background  = tab==='apuntes'  ? 'var(--bg)' : 'transparent';
  document.getElementById('foc-tab-apuntes').style.color       = tab==='apuntes'  ? 'var(--accent)' : 'var(--text3)';
  document.getElementById('foc-tab-apuntes').style.borderBottom= tab==='apuntes'  ? '2px solid var(--accent)' : 'none';
  if (tab === 'apuntes') renderFocApuntesPreview();
}

// Neto/IVA reales de la factura en pantalla — agregando línea por línea desde
// el DOM (foc-neto-N / foc-iva-val-N), que calcFocItemIva()/calcFocTotales()
// ya llenan respetando el checkbox de IVA de CADA línea (foc-iva-N). Esta es
// la única fuente de verdad para neto/IVA: si una línea no lleva IVA, su
// columna foc-iva-val-N queda en "—" y no aporta nada a sumIva. Se usa tanto
// para guardar en erp_compras como para generar el asiento contable — así
// nunca puede quedar un asiento con IVA que el usuario desmarcó en pantalla.
// BUG CORREGIDO: antes hacía .replace(/[^0-9.,]/g,'').replace(',','.') sobre
// el texto YA FORMATEADO para mostrar (ej. "Q8,928.57"), lo que convertía
// la coma de miles en un punto decimal ("8.928.57") — parseFloat corta ahí
// y devuelve 8.928 en vez de 8928.57. Con montos de 4+ dígitos (donde
// fmtMoney sí usa separador de miles), esto posteaba un asiento
// desbalanceado 1000 veces menor al correcto. Ahora solo se eliminan los
// separadores de miles (sin convertirlos en punto), igual que ya se hacía
// correctamente en calcFocItemIva() unas líneas arriba — nunca debieron
// ser dos formas distintas de leer el mismo número.
function focNetoIvaFromDOM() {
  let neto = 0, iva = 0;
  document.querySelectorAll('[id^="foc-neto-"]').forEach((el, idx) => {
    neto += parseFloat(el.textContent.replace(/[^0-9.]/g,''))||0;
    const ivaEl = document.getElementById(`foc-iva-val-${idx}`);
    iva += ivaEl?.textContent==='—' ? 0 : parseFloat((ivaEl?.textContent||'').replace(/[^0-9.]/g,''))||0;
  });
  return { neto: parseFloat(neto.toFixed(2)), iva: parseFloat(iva.toFixed(2)) };
}

// Previsualiza en vivo las líneas del asiento que se generará al guardar la
// factura, con totales Debe/Haber para verificar que cuadra antes de grabar.
// Si la factura ya fue guardada (foc-factura-id tiene valor), no se toca —
// esa tabla ya muestra el asiento real generado en saveFacturaOC().
function renderFocApuntesPreview() {
  const tbody = document.getElementById('foc-apuntes-tbody');
  if (!tbody) return;
  if (document.getElementById('foc-factura-id')?.value) return; // ya guardada: no sobreescribir

  const oc_id = document.getElementById('foc-oc-id').value;
  const tipo  = document.getElementById('foc-tipo').value;
  const total = parseFloat(document.getElementById('foc-total').value) || 0;
  const monedaOC = getMonedaOC(oc_id);
  const badgeEl = document.getElementById('foc-balance-badge');

  if (!oc_id || !total) {
    tbody.innerHTML = `<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text3);font-size:12px">
      Completa los datos de la factura para previsualizar los apuntes contables.
    </td></tr>`;
    document.getElementById('foc-total-debe').textContent  = '—';
    document.getElementById('foc-total-haber').textContent = '—';
    if (badgeEl) badgeEl.innerHTML = '';
    return;
  }

  // Neto/IVA reales de las líneas en pantalla (respeta el checkbox de IVA de
  // cada línea) — NO se recalculan a partir del "tipo" de factura.
  const { neto, iva } = focNetoIvaFromDOM();
  const lineas = buildLineasFacturaCompra({ oc_id, tipo, total, neto, iva });

  let totalDebe = 0, totalHaber = 0;
  tbody.innerHTML = lineas.map(l => {
    totalDebe  += Number(l.debe||0);
    totalHaber += Number(l.haber||0);
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:7px 12px;font-size:12px;font-family:'DM Mono',monospace">${l.cuenta_codigo||'—'} ${l.cuenta_nombre||''}</td>
      <td style="padding:7px 12px;font-size:12px;color:var(--text3)">${l.descripcion||'—'}</td>
      <td style="padding:7px 12px;text-align:right;font-family:'DM Mono',monospace">${Number(l.debe||0)>0  ? fmtMoney(Number(l.debe||0), monedaOC)  : ''}</td>
      <td style="padding:7px 12px;text-align:right;font-family:'DM Mono',monospace">${Number(l.haber||0)>0 ? fmtMoney(Number(l.haber||0), monedaOC) : ''}</td>
    </tr>`;
  }).join('');

  document.getElementById('foc-total-debe').textContent  = fmtMoney(totalDebe, monedaOC);
  document.getElementById('foc-total-haber').textContent = fmtMoney(totalHaber, monedaOC);

  const cuadra = Math.abs(totalDebe - totalHaber) < 0.01;
  document.getElementById('foc-total-debe').style.color  = cuadra ? '' : 'var(--red)';
  document.getElementById('foc-total-haber').style.color = cuadra ? '' : 'var(--red)';
  if (badgeEl) {
    badgeEl.innerHTML = cuadra
      ? '<span class="badge badge-green" style="margin-left:8px">✓ Cuadra</span>'
      : `<span class="badge badge-red" style="margin-left:8px">✗ No cuadra (dif. ${fmtMoney(Math.abs(totalDebe-totalHaber), monedaOC)})</span>`;
  }
}

function nextFacturaInterna() {
  const year  = new Date().getFullYear();
  const month = String(new Date().getMonth()+1).padStart(2,'0');
  const facts = (state.ocFacturas||[]).filter(f=>(f.num_interno||'').startsWith(`FACT/${year}/${month}/`));
  const nums  = facts.map(f=>parseInt((f.num_interno||'').split('/').pop())||0);
  const next  = ((nums.length ? Math.max(...nums) : 0) + 1);
  return `FACT/${year}/${month}/${String(next).padStart(4,'0')}`;
}

function calcFocItemIva(idx, qty, precio, moneda) {
  // moneda: divisa de la OC (USD/GTQ). Si no se recibe explícitamente (ej.
  // llamadas antiguas), se toma de la OC actualmente abierta en el modal —
  // nunca se debe caer al default de fmtMoney (GTQ), o la factura "cambia"
  // de moneda visualmente al tocar el checkbox de IVA de una línea.
  moneda = moneda || getMonedaOC(document.getElementById('foc-oc-id')?.value) || 'GTQ';
  // CANTIDAD Y PRECIO EDITABLES (30/Ago/2026): se leen de los inputs de la
  // fila, no de los argumentos. Estos últimos quedan solo como respaldo para
  // llamadas viejas que pasaban valores fijos.
  const cantEl   = document.getElementById(`foc-cant-${idx}`);
  const precioEl = document.getElementById(`foc-precio-${idx}`);
  if (cantEl)   qty    = parseFloat(cantEl.value)   || 0;
  if (precioEl) precio = parseFloat(precioEl.value) || 0;

  // Línea excluida de esta factura: aporta cero a los totales, pero la fila
  // se deja visible y en gris para que se vea que existe y quedó fuera.
  const incluir = document.getElementById(`foc-incluir-${idx}`);
  const activa  = !incluir || incluir.checked;
  const fila    = document.getElementById(`foc-item-row-${idx}`);
  if (fila) fila.style.opacity = activa ? '1' : '0.45';
  if (cantEl)   cantEl.disabled   = !activa;
  if (precioEl) precioEl.disabled = !activa;

  const conIva = document.getElementById(`foc-iva-${idx}`)?.checked;
  const total  = activa ? parseFloat((qty * precio).toFixed(2)) : 0;
  const neto   = conIva ? parseFloat((total / 1.12).toFixed(2)) : total;
  const iva    = conIva ? parseFloat((total - neto).toFixed(2)) : 0;

  const netoEl = document.getElementById(`foc-neto-${idx}`);
  const ivaEl  = document.getElementById(`foc-iva-val-${idx}`);
  const totEl  = document.getElementById(`foc-total-${idx}`);

  if (netoEl) netoEl.textContent = fmtMoney(neto, moneda);
  if (ivaEl)  ivaEl.textContent  = conIva ? fmtMoney(iva, moneda) : '—';
  if (totEl)  totEl.textContent  = fmtMoney(total, moneda);

  // Recalcular totales generales (30/Ago/2026): se delega en calcFocTotales()
  // en vez de sumar leyendo el TEXTO de las celdas del DOM. Ese método fallaba
  // con las líneas excluidas: una línea destildada seguía mostrando su total
  // en pantalla, así que se sumaba igual al total de la factura.
  const ocIdFoc = document.getElementById('foc-oc-id')?.value;
  const itemsFoc = (state.ocItems||[]).filter(i => i.oc_id === ocIdFoc);
  const esServFoc = itemsFoc.length > 0 &&
    itemsFoc.every(i => state.productos.find(p=>p.id===i.producto_id)?.tipo === 'servicio');
  calcFocTotales(itemsFoc, moneda, esServFoc);
  // calcFocTotales() ya llama a renderFocSaldoOC() y renderFocApuntesPreview(),
  // así que la previsualización de apuntes se refresca en cada cambio de
  // cantidad, precio o check de IVA — no solo al volver a abrir ese tab.
}

// Muestra cuánto se ha recibido, cuánto ya se facturó y el saldo disponible
// para facturar en esta OC — visible antes de intentar grabar.
function renderFocSaldoOC() {
  const el = document.getElementById('foc-saldo-oc-info');
  if (!el) return;
  const oc_id = document.getElementById('foc-oc-id').value;
  if (!oc_id) { el.style.display = 'none'; return; }

  const monedaOC      = getMonedaOC(oc_id);
  const valorRecibido = ocValorRecibido(oc_id);
  const yaFacturado    = ocFacturadoTotal(oc_id);
  const saldo          = valorRecibido - yaFacturado;
  const total          = parseFloat(document.getElementById('foc-total')?.value) || 0;
  const excede         = total > saldo + 0.01;

  el.style.display    = '';
  el.style.background = excede ? 'var(--red-bg)' : 'var(--surface2)';
  el.style.color      = excede ? 'var(--red)' : 'var(--text2)';
  el.innerHTML = `Recibido en la OC: <strong>${fmtMoney(valorRecibido, monedaOC)}</strong>` +
    (yaFacturado > 0.009 ? ` &nbsp;·&nbsp; Ya facturado: <strong>${fmtMoney(yaFacturado, monedaOC)}</strong>` : '') +
    ` &nbsp;·&nbsp; Saldo por facturar: <strong>${fmtMoney(saldo, monedaOC)}</strong>` +
    (excede ? ` &nbsp;·&nbsp; ⚠️ Esta factura excede el saldo recibido` : '');
}

function calcFocTotales(items, monedaOC, esServicio) {
  // FIX (30/Ago/2026, reportado en vivo): esta función recalculaba desde
  // ocRecibidoQty() y i.precio_unit —los valores ORIGINALES— ignorando los
  // inputs editables y los checkboxes. Cambiar la cantidad de 1000 a 500 no
  // movía el total, y como saveFacturaOC toma el total de este campo, la
  // factura se grababa por el monto viejo mientras sus líneas decían otra
  // cosa: total y detalle quedaban inconsistentes.
  //
  // Ahora lee exactamente lo mismo que getFocLineas(): solo las líneas
  // tildadas, con la cantidad y el precio que haya en pantalla.
  let sumNeto = 0, sumIva = 0, sumTotal = 0;
  items.forEach((i, idx) => {
    const incluir = document.getElementById(`foc-incluir-${idx}`);
    if (incluir && !incluir.checked) return;   // línea excluida: no suma

    const cantEl   = document.getElementById(`foc-cant-${idx}`);
    const precioEl = document.getElementById(`foc-precio-${idx}`);
    const qty = cantEl
      ? (parseFloat(cantEl.value) || 0)
      : (esServicio ? Number(i.cantidad||0) : ocPendienteFacturarLinea(currentOCId, i.producto_id));
    const precio = precioEl ? (parseFloat(precioEl.value) || 0) : Number(i.precio_unit||0);

    const total = parseFloat((qty * precio).toFixed(2));
    // El IVA se toma del checkbox de la línea si existe; si no, de la ficha
    // del producto. Antes solo miraba el producto, así que destildar el IVA
    // en una línea no afectaba los totales.
    const ivaEl  = document.getElementById(`foc-iva-${idx}`);
    const prod   = state.productos.find(p=>p.id===i.producto_id);
    const conIva = ivaEl ? ivaEl.checked : (prod?.lleva_iva !== false);
    const neto  = conIva ? parseFloat((total / 1.12).toFixed(2)) : total;
    const iva   = conIva ? parseFloat((total - neto).toFixed(2)) : 0;
    sumNeto  += neto;
    sumIva   += iva;
    sumTotal += total;
  });
  document.getElementById('foc-total').value                  = sumTotal.toFixed(2);
  document.getElementById('foc-total-display').textContent    = fmtMoney(sumTotal, monedaOC);
  document.getElementById('foc-subtotal-display').textContent = fmtMoney(sumNeto, monedaOC);
  document.getElementById('foc-iva-display').textContent      = fmtMoney(sumIva, monedaOC);
  renderFocSaldoOC();
  renderFocApuntesPreview();
}

function calcFocVencimiento() {
  const fecha  = document.getElementById('foc-fecha').value;
  const ocId   = document.getElementById('foc-oc-id').value;
  const oc     = state.oc.find(o=>o.id===ocId);
  const dias   = oc?.dias_credito ?? null;
  if (!fecha || dias===null) return;
  const d = new Date(fecha);
  d.setDate(d.getDate() + Number(dias));
  document.getElementById('foc-fecha-vencimiento').value = d.toISOString().split('T')[0];
}

// TC solo aplica si la OC está en USD. En GTQ no hay tipo de cambio que
// aplicar: el campo queda en 0 y deshabilitado. En USD se habilita y se
// precarga con el TC más reciente registrado (Banguat).
function updateFocTCState() {
  const tcInput   = document.getElementById('foc-tc');
  const tcFechaEl = document.getElementById('foc-tc-fecha');
  if (!tcInput) return;

  const ocId     = document.getElementById('foc-oc-id').value;
  const monedaOC = getMonedaOC(ocId);

  if (monedaOC === 'USD') {
    tcInput.disabled = false;
    tcInput.style.background = '';
    tcInput.style.cursor = '';
    const ultimo = state.tiposCambio?.[0];
    tcInput.value = ultimo ? Number(ultimo.referencia).toFixed(4) : '';
    if (tcFechaEl) tcFechaEl.textContent = ultimo?.fecha ? fmtDate(ultimo.fecha) : '';
  } else {
    tcInput.disabled = true;
    tcInput.value = '0.0000';
    tcInput.style.background = 'var(--surface2)';
    tcInput.style.cursor = 'not-allowed';
    if (tcFechaEl) tcFechaEl.textContent = '';
  }
}

function openFacturaOC() {
  if (!currentOCId) return;
  const oc     = state.oc.find(x=>x.id===currentOCId);
  const prov   = state.proveedores.find(p=>p.id===oc?.proveedor_id);
  const monedaOC = getMonedaOC(currentOCId);
  const items  = state.ocItems.filter(i=>i.oc_id===currentOCId);
  const esServicio = items.every(i => state.productos.find(p=>p.id===i.producto_id)?.tipo === 'servicio');

  // LA FACTURA SIEMPRE VA DESPUÉS DE LA RECEPCIÓN (30/Ago/2026, a pedido
  // explícito). Para productos ALMACENABLES no puede existir factura sin que
  // el material haya ingresado antes — es la regla del negocio.
  //
  // Además tiene sustento contable: el asiento de la factura DEBITA la cuenta
  // transitoria de "recibido pendiente de facturar", que solo se acredita al
  // recibir. Sin recepción previa esa cuenta quedaría con saldo deudor
  // permanente, imposible de cerrar.
  //
  // Los SERVICIOS quedan exentos: no pasan por recepción física, la factura
  // debita directo la cuenta de gasto y no hay transitoria involucrada.
  if (!esServicio) {
    const tieneRecepcion = (state.ocRecepciones||[]).some(r => r.oc_id === currentOCId);
    if (!tieneRecepcion) {
      alert(
        'NO SE PUEDE FACTURAR — Esta orden no tiene ninguna recepción registrada.\n\n' +
        `Orden: ${oc?.numero || '(sin número)'}\n\n` +
        'La factura de un producto almacenable se registra siempre DESPUÉS de ' +
        'recibir el material.\n\n' +
        'Registre primero la recepción de los productos.'
      );
      return;
    }
    // Todo lo recibido ya está facturado (30/Ago/2026, a pedido explícito).
    // El botón normalmente ya está oculto en este caso, pero se valida igual
    // por si se llega acá con el panel desactualizado o desde consola.
    const pendientes = items.filter(i => ocPendienteFacturarLinea(currentOCId, i.producto_id) > 0.001);
    if (!pendientes.length) {
      alert(
        'NO SE PUEDE FACTURAR MÁS DE LO RECIBIDO\n\n' +
        `Orden: ${oc?.numero || '(sin número)'}\n\n` +
        'Todo el material recibido en esta orden ya fue facturado.\n\n' +
        'Si falta facturar producto, regístre primero su recepción.'
      );
      return;
    }
  }

  document.getElementById('foc-oc-id').value          = currentOCId;
  document.getElementById('foc-factura-id').value      = '';
  const focBtn = document.getElementById('foc-btn-guardar');
  if (focBtn) { focBtn.disabled = false; focBtn.textContent = '💾 Generar Factura'; }
  const focBadge = document.getElementById('foc-balance-badge');
  if (focBadge) focBadge.innerHTML = '';
  document.getElementById('foc-header-sub').textContent = `${oc?.numero||''} — ${prov?.name||''}`;
  document.getElementById('foc-proveedor-nombre').value = prov?.name||'';
  // Retención ISR: solo tiene sentido marcarla por defecto si el proveedor
  // está en Régimen Opcional Simplificado — los de Régimen General y los
  // exentos por Decreto 29-89 (subcontratistas de producción, coexportan)
  // nunca están sujetos. Queda editable porque el dato real de si aplica
  // "Sujeto a Retención ISR" vs. "Pagos Directos" viene impreso en la
  // factura física del proveedor, no es un hecho fijo garantizado por régimen.
  const focRetIsr = document.getElementById('foc-retencion-isr');
  const focRetIsrNota = document.getElementById('foc-retencion-isr-nota');
  if (focRetIsr) focRetIsr.checked = prov?.regimen_isr === 'opcional_simplificado';
  if (focRetIsrNota) {
    focRetIsrNota.textContent = prov?.regimen_isr === 'opcional_simplificado'
      ? 'Proveedor en Régimen Opcional Simplificado — normalmente sí aplica, salvo que la factura indique "Pagos Directos".'
      : prov?.regimen_isr === 'exento_29_89'
        ? 'Proveedor exento (Decreto 29-89) — normalmente no aplica.'
        : 'Proveedor en Régimen General — normalmente no aplica.';
  }
  const numInterno = nextFacturaInterna();
  document.getElementById('foc-num-interno').value          = numInterno;
  document.getElementById('foc-num-interno-display').textContent = numInterno;
  document.getElementById('foc-serie').value            = '';
  document.getElementById('foc-numero').value           = '';
  document.getElementById('foc-tipo').value             = 'FC';
  document.getElementById('foc-ref-factura').value      = oc?.numero||'';
  document.getElementById('foc-fecha').value            = today();
  document.getElementById('foc-fecha-contable').value   = today();
  updateFocTCState();
  document.getElementById('foc-notas').value            = '';

  // Fecha vencimiento from OC
  calcFocVencimiento();

  // Items display with IVA per line
  document.getElementById('foc-items-display').innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:var(--surface2)">
        <th style="padding:8px 6px;text-align:center;width:34px" title="Incluir esta línea en la factura">✓</th>
        <th style="padding:8px 12px;text-align:left">Producto / Servicio</th>
        <th style="padding:8px 12px;text-align:right">Cantidad</th>
        <th style="padding:8px 12px;text-align:right">Precio Unit.</th>
        <th style="padding:8px 12px;text-align:center">IVA</th>
        <th style="padding:8px 12px;text-align:right">Subtotal</th>
        <th style="padding:8px 12px;text-align:right">IVA Q</th>
        <th style="padding:8px 12px;text-align:right">Total</th>
      </tr></thead>
      <tbody>${items.map((i, idx) => {
        const prod   = state.productos.find(p=>p.id===i.producto_id);
        // CANTIDAD SUGERIDA = lo PENDIENTE DE FACTURAR de esta línea
        // (30/Ago/2026, a pedido explícito: "lo que ya está facturado no lo
        // puedes facturar nuevamente"). Antes se proponía todo lo recibido,
        // así que en una segunda factura parcial se repetía lo ya facturado.
        const qty    = esServicio ? Number(i.cantidad||0) : ocPendienteFacturarLinea(currentOCId, i.producto_id);
        const precio = Number(i.precio_unit||0);
        const total  = parseFloat((qty * precio).toFixed(2));
        // El checkbox de IVA parte del valor predeterminado configurado en el
        // producto (Compra › Aplica IVA). La mayoría de materia prima no
        // paga IVA, así que por defecto viene desmarcado para esos productos.
        const conIva = prod?.lleva_iva !== false;
        const neto   = conIva ? parseFloat((total / 1.12).toFixed(2)) : total;
        const iva    = conIva ? parseFloat((total - neto).toFixed(2)) : 0;
        // Línea EDITABLE (30/Ago/2026): cantidad y precio se pueden ajustar
        // a lo que realmente dice la factura del proveedor, y el check
        // permite dejar líneas fuera para facturarlas después.
        // Sin pendiente por facturar, la línea viene desmarcada.
        const pendiente = esServicio ? qty : ocPendienteFacturarLinea(currentOCId, i.producto_id);
        return `<tr style="border-bottom:1px solid var(--border)" id="foc-item-row-${idx}"
                    data-producto-id="${i.producto_id}" data-oc-item-id="${i.id||''}" data-unidad="${i.unidad||''}">
          <td style="padding:8px 6px;text-align:center">
            <input type="checkbox" id="foc-incluir-${idx}" ${pendiente>0.001?'checked':''}
                   onchange="calcFocItemIva(${idx}, ${qty}, ${precio}, '${monedaOC}')"
                   style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer"/>
          </td>
          <td style="padding:8px 12px">${prod?.description||prodName(i.producto_id)}
            ${esServicio?'<span class="badge badge-blue" style="margin-left:6px;font-size:10px">Servicio</span>':''}
            ${esServicio ? '' : (() => {
              // Desglose de dónde sale la cantidad sugerida (30/Ago/2026, a
              // pedido explícito). Ver solo el pendiente no deja detectar por
              // qué es menor de lo esperado: si el usuario esperaba facturar
              // más, comparar contra lo PEDIDO en la OC le dice si el faltante
              // es porque ya se facturó o porque bodega todavía no terminó de
              // ingresar el producto.
              const pedido    = Number(i.cantidad||0);
              const recibido  = ocRecibidoQty(currentOCId, i.producto_id);
              const facturado = ocFacturadoQty(currentOCId, i.producto_id);
              const faltaRecibir = pedido - recibido;
              return `<div style="font-size:10px;color:var(--text3);margin-top:3px;line-height:1.5">
                Recibido ${fmtNum(recibido)} − facturado ${fmtNum(facturado)} =
                <strong style="color:${pendiente>0.001?'var(--accent)':'var(--text3)'}">${fmtNum(pendiente)} ${i.unidad||''}</strong> por facturar
                ${faltaRecibir > 0.001
                  ? `<br/><span style="color:var(--orange,#D97706)">⚠ Faltan ${fmtNum(faltaRecibir)} ${i.unidad||''} por recibir de los ${fmtNum(pedido)} pedidos</span>`
                  : ''}
              </div>`;
            })()}
          </td>
          <td style="padding:8px 12px;text-align:right">
            <input type="number" id="foc-cant-${idx}" value="${qty.toFixed(esServicio?0:3)}" step="0.001" min="0"
                   onchange="calcFocItemIva(${idx}, ${qty}, ${precio}, '${monedaOC}')"
                   style="width:100px;text-align:right;font-family:'DM Mono',monospace;font-size:12px;padding:4px 6px"/>
            <span style="font-size:10px;color:var(--text3);margin-left:3px">${i.unidad||''}</span>
          </td>
          <td style="padding:8px 12px;text-align:right">
            <input type="number" id="foc-precio-${idx}" value="${precio.toFixed(4)}" step="0.0001" min="0"
                   onchange="calcFocItemIva(${idx}, ${qty}, ${precio}, '${monedaOC}')"
                   style="width:110px;text-align:right;font-family:'DM Mono',monospace;font-size:12px;padding:4px 6px"/>
          </td>
          <td style="padding:8px 12px;text-align:center">
            <label style="display:flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;font-size:11px;font-weight:600;color:var(--text2)">
              <input type="checkbox" id="foc-iva-${idx}" ${conIva?'checked':''}
                onchange="calcFocItemIva(${idx}, ${qty}, ${precio}, '${monedaOC}')"
                style="width:14px;height:14px;accent-color:var(--accent);cursor:pointer"/>
              IVA
            </label>
          </td>
          <td style="padding:8px 12px;text-align:right;font-family:\'DM Mono\',monospace" id="foc-neto-${idx}">${fmtMoney(neto, monedaOC)}</td>
          <td style="padding:8px 12px;text-align:right;font-family:\'DM Mono\',monospace;color:#D97706" id="foc-iva-val-${idx}">${conIva?fmtMoney(iva, monedaOC):'—'}</td>
          <td style="padding:8px 12px;text-align:right;font-family:\'DM Mono\',monospace;font-weight:700" id="foc-total-${idx}">${fmtMoney(total, monedaOC)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;

  calcFocTotales(items, monedaOC, esServicio);

  focTab('datos');
  openModal('modal-factura-oc');
}

async function saveFacturaOC() {
  // Evita doble-grabado: si ya se generó en esta apertura del modal, el botón
  // ahora funciona como "Cerrar" — no se debe reintentar el guardado.
  if (document.getElementById('foc-factura-id').value) {
    closeModal('modal-factura-oc');
    return;
  }
  const focBtn = document.getElementById('foc-btn-guardar');
  if (focBtn?.disabled) return; // ya se está procesando (evita doble-click)

  const oc_id          = document.getElementById('foc-oc-id').value;
  const numero         = document.getElementById('foc-numero').value.trim();
  const serie          = document.getElementById('foc-serie').value.trim();
  const fecha          = document.getElementById('foc-fecha').value;
  // Fecha contable = fecha real de generación en el sistema (hoy), no editable
  // por el usuario y calculada en este momento (no la que se mostró al abrir
  // el modal, por si quedó abierto de un día para otro).
  const fecha_contable = today();
  const fecha_venc     = document.getElementById('foc-fecha-vencimiento').value;
  const tipo           = document.getElementById('foc-tipo').value;
  const tcRaw          = document.getElementById('foc-tc').value;
  const tc             = tcRaw==='' ? null : (parseFloat(tcRaw)||0); // 0 es válido (GTQ, sin TC aplicable)
  const total          = parseFloat(document.getElementById('foc-total').value);
  const notas          = document.getElementById('foc-notas').value.trim();
  const num_interno    = document.getElementById('foc-num-interno').value;
  const sujeto_retencion_isr = document.getElementById('foc-retencion-isr')?.checked || false;

  if (!numero||!fecha) { toast('Número y fecha son requeridos','error'); return; }

  const oc   = state.oc.find(o=>o.id===oc_id);
  const prov = state.proveedores.find(p=>p.id===oc?.proveedor_id);
  const monedaOC = getMonedaOC(oc_id);

  // VALIDACIÓN POR LÍNEA (30/Ago/2026, a pedido explícito). Reemplaza al
  // chequeo global por VALOR (ocSaldoPorFacturar), que dejaba pasar dos casos
  // reales al revés de lo que corresponde:
  //   · Facturar la cantidad correcta a MAYOR precio se bloqueaba, cuando el
  //     precio legítimamente puede variar.
  //   · Facturar MÁS cantidad a menor precio pasaba sin aviso, porque el
  //     total cuadraba.
  //
  // La regla es: la cantidad no puede exceder lo PENDIENTE DE FACTURAR
  // (recibido − ya facturado); el precio puede diferir. Ninguna de las dos
  // bloquea de forma dura — ambas piden una razón escrita, que se guarda en
  // la línea para poder auditarla después.
  // Se revalida acá porque el bloqueo de openFacturaOC() es solo la UI: el
  // modal pudo quedar abierto y anularse la recepción mientras tanto, o
  // forzarse la llamada desde consola.
  const focLineas = getFocLineas(oc_id, monedaOC);
  const esServicioOC = (state.ocItems||[]).filter(i => i.oc_id === oc_id)
    .every(i => state.productos.find(p => p.id === i.producto_id)?.tipo === 'servicio');
  if (!esServicioOC && !(state.ocRecepciones||[]).some(r => r.oc_id === oc_id)) {
    toast('No se puede facturar: la orden no tiene recepciones registradas. Registre primero la recepción.','error');
    return;
  }
  if (!focLineas.length) {
    toast('Seleccione al menos una línea para facturar','error');
    return;
  }

  for (const ln of focLineas) {
    const nombre = prodName(ln.producto_id);

    // 1. Cantidad contra lo pendiente de facturar
    const pendiente = ocPendienteFacturarLinea(oc_id, ln.producto_id);
    if (ln.cantidad > pendiente + 0.001) {
      const exceso = ln.cantidad - pendiente;
      const motivo = prompt(
        `NO SE PUEDE FACTURAR MÁS DE LO RECIBIDO — ${nombre}\n\n` +
        `Recibido:            ${fmtNum(ocRecibidoQty(oc_id, ln.producto_id))} ${ln.unidad||''}\n` +
        `Ya facturado:        ${fmtNum(ocFacturadoQty(oc_id, ln.producto_id))} ${ln.unidad||''}\n` +
        `Pendiente:           ${fmtNum(pendiente)} ${ln.unidad||''}\n` +
        `Se está facturando:  ${fmtNum(ln.cantidad)} ${ln.unidad||''}  (exceso ${fmtNum(exceso)})\n\n` +
        `Se estaría facturando material que no se recibió físicamente.\n\n` +
        `Escriba la razón para continuar (queda registrada en la factura):`
      );
      if (!motivo || !motivo.trim()) { toast('No se puede facturar más de lo recibido sin una razón registrada','error'); return; }
      ln.motivo_cantidad = motivo.trim();
    }

    // 2. Precio contra el de la OC
    const itemOC = (state.ocItems||[]).find(i => i.oc_id === oc_id && i.producto_id === ln.producto_id);
    const precioOC = Number(itemOC?.precio_unit || 0);
    ln.precio_oc = precioOC;
    if (precioOC > 0 && Math.abs(ln.precio_unit - precioOC) > 0.0001) {
      const dif    = ln.precio_unit - precioOC;
      const difTot = dif * ln.cantidad;
      const motivo = prompt(
        `PRECIO DISTINTO AL DE LA ORDEN — ${nombre}\n\n` +
        `Precio en la OC:      ${fmtMoney(precioOC, monedaOC)}\n` +
        `Precio facturado:     ${fmtMoney(ln.precio_unit, monedaOC)}\n` +
        `Diferencia unitaria:  ${dif>0?'+':''}${fmtMoney(dif, monedaOC)}\n` +
        `Impacto en la línea:  ${difTot>0?'+':''}${fmtMoney(difTot, monedaOC)}\n\n` +
        `La diferencia se sumará al costo del producto en inventario.\n\n` +
        `Escriba la razón para continuar (queda registrada en la factura):`
      );
      if (!motivo || !motivo.trim()) { toast('Se requiere una razón para facturar a un precio distinto','error'); return; }
      ln.motivo_precio = motivo.trim();
      ln.diferencia_precio = parseFloat(difTot.toFixed(4));
    }
  }

  const diasCredito = oc?.dias_credito ?? null;
  const fecha_vencimiento = fecha_venc || (() => {
    if (!diasCredito) return null;
    const d = new Date(fecha); d.setDate(d.getDate()+Number(diasCredito));
    return d.toISOString().split('T')[0];
  })();

  // Blindaje: el neto/IVA por línea (focNetoIvaFromDOM, calculado a partir
  // de cantidad × precio de cada renglón de la OC) es una fuente de datos
  // completamente independiente del campo "Total factura" que el usuario
  // escribe a mano — nada los obligaba a coincidir. Si no cuadran (ej.
  // porque un producto quedó mal catalogado como NO-servicio y su cantidad
  // se tomó de lo "recibido" en bodega en vez de la cantidad facturada),
  // el asiento se posteaba desbalanceado (Debe ≠ Haber) sin ningún aviso.
  // Ahora se bloquea el guardado hasta que el usuario corrija la cantidad/
  // precio de la línea que no cuadra, o ajuste el total.
  const { neto: netoCheck, iva: ivaCheck } = focNetoIvaFromDOM();
  if (Math.abs((netoCheck + ivaCheck) - total) > 0.01) {
    toast(`Las líneas no cuadran con el total de la factura: líneas suman ${fmtMoney(netoCheck+ivaCheck, monedaOC)}, pero el total es ${fmtMoney(total, monedaOC)}. Revisa la cantidad/precio de cada línea antes de generar la factura.`,'error');
    return;
  }

  if (focBtn) { focBtn.disabled = true; focBtn.textContent = 'Generando…'; }

  // Save to erp_oc_facturas
  const {data:focArr, error:e1} = await sb.from('erp_oc_facturas').insert({
    oc_id, serie, numero, fecha,
    fecha_contable,
    fecha_vencimiento,
    tipo, total, status:'pendiente', notas,
    dias_credito:   diasCredito,
    tc,
    num_interno,
    sujeto_retencion_isr,
  }).select();
  if (e1) {
    toast('Error: '+e1.message,'error');
    if (focBtn) { focBtn.disabled = false; focBtn.textContent = '💾 Generar Factura'; }
    return;
  }

  // Marcar como grabada de inmediato para bloquear reintentos aunque algo falle más abajo
  document.getElementById('foc-factura-id').value = focArr[0].id;

  // LÍNEAS DE LA FACTURA (30/Ago/2026). Sin esto el desglose se perdía y no
  // había forma de acumular lo facturado por producto entre facturas
  // parciales — que es la base de la validación por cantidad.
  // Se insertan en UNA sola llamada (array), no una por una: además de ser
  // un solo viaje de red, así o entran todas o no entra ninguna.
  if (focLineas.length) {
    const { error: eLineas } = await sb.from('erp_oc_factura_items').insert(
      focLineas.map(ln => ({
        factura_id:  focArr[0].id,
        oc_item_id:  ln.oc_item_id || null,
        producto_id: ln.producto_id,
        cantidad:    ln.cantidad,
        unidad:      ln.unidad,
        precio_unit: ln.precio_unit,
        moneda:      ln.moneda,
        tc,
        lleva_iva:   ln.lleva_iva,
        neto:        ln.neto,
        iva:         ln.iva,
        total:       ln.total,
        total_gtq:   parseFloat((ln.total * (ln.moneda === 'USD' ? tc : 1)).toFixed(4)),
        motivo_cantidad:   ln.motivo_cantidad || null,
        motivo_precio:     ln.motivo_precio   || null,
        precio_oc:         ln.precio_oc,
        diferencia_precio: ln.diferencia_precio || 0,
      }))
    );
    if (eLineas) {
      console.error('Error guardando líneas de la factura:', eLineas.message);
      alert(
        'ATENCIÓN — La factura se creó pero NO se guardó su detalle por línea.\n\n' +
        eLineas.message + '\n\n' +
        'Sin el detalle, el sistema no podrá validar cuánto queda pendiente de ' +
        'facturar de cada producto. Revise la factura antes de continuar.'
      );
    }
  }

  // Register in Libro de Compras
  // Calculate totals respecting IVA checkboxes per line
  const { neto: valor_neto, iva: valor_iva } = focNetoIvaFromDOM();
  // FIX (29/Ago/2026, auditoría): este insert no comprobaba error. El Libro de
  // Compras es un registro FISCAL: si falla, la factura existe en el sistema
  // pero no aparece en el libro, y el neto que alimenta la retención ISR queda
  // incompleto. Nadie se enteraba hasta cerrar el período.
  // No se aborta el flujo —el asiento contable de abajo sigue siendo válido y
  // la factura ya quedó grabada— pero se avisa con claridad para poder
  // registrarla a mano.
  const { error: errCompras } = await sb.from('erp_compras').insert({
    fecha, tipo: tipo||'FC', serie, numero,
    proveedor_id: prov?.id||null,
    valor_neto, valor_iva, valor_total: total,
    oc_id,
    factura_id: focArr[0]?.id||null,
    moneda: monedaOC||'GTQ',
    notas: notas||`Factura OC ${oc?.numero||''}`,
  });
  if (errCompras) {
    console.error('Error registrando en Libro de Compras:', errCompras.message);
    alert(
      'ATENCIÓN — La factura se guardó pero NO se registró en el Libro de Compras.\n\n' +
      `Factura: ${serie||''}-${numero||''}\n` +
      `Error: ${errCompras.message}\n\n` +
      'El Libro de Compras es un registro fiscal y alimenta el cálculo de la ' +
      'retención ISR. Regístrela manualmente antes de cerrar el período.'
    );
  }

  // Generate accounting entry
  await loadAll();
  if (focArr?.length) {
    await asientoFacturaCompra(focArr[0].id);
    await loadAll();

    // Show apuntes in tab
    const asientoFact = (state.asientos||[]).find(a => a.referencia_id === focArr[0].id);
    if (asientoFact) {
      const lineas = (state.asientoLineas||[]).filter(l=>l.asiento_id===asientoFact.id);
      let totalDebe=0, totalHaber=0;
      document.getElementById('foc-apuntes-tbody').innerHTML = lineas.map(l => {
        const cta = (state.nomenclatura||[]).find(n=>n.id===l.cuenta_id);
        totalDebe  += Number(l.debe_gtq||l.debe||0);
        totalHaber += Number(l.haber_gtq||l.haber||0);
        return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:7px 12px;font-size:12px;font-family:'DM Mono',monospace">${cta?.codigo||'—'} ${cta?.nombre||l.cuenta_nombre||'—'}</td>
          <td style="padding:7px 12px;font-size:12px;color:var(--text3)">${l.descripcion||''}</td>
          <td style="padding:7px 12px;text-align:right;font-family:'DM Mono',monospace">${Number(l.debe_gtq||l.debe||0)>0?fmtGTQ(Number(l.debe_gtq||l.debe||0)):''}</td>
          <td style="padding:7px 12px;text-align:right;font-family:'DM Mono',monospace">${Number(l.haber_gtq||l.haber||0)>0?fmtGTQ(Number(l.haber_gtq||l.haber||0)):''}</td>
        </tr>`;
      }).join('');
      document.getElementById('foc-total-debe').textContent  = fmtGTQ(totalDebe);
      document.getElementById('foc-total-haber').textContent = fmtGTQ(totalHaber);
      const focBadge = document.getElementById('foc-balance-badge');
      if (focBadge) focBadge.innerHTML = '<span class="badge badge-green" style="margin-left:8px">✓ Factura generada</span>';
      focTab('apuntes');
      toast('✓ Factura generada — revisa los apuntes contables');
    } else {
      toast('Factura generada');
      closeModal('modal-factura-oc');
    }
  }

  // El botón queda habilitado pero ahora funciona como "Cerrar" (ver guard
  // al inicio de esta función, que detecta foc-factura-id ya seteado).
  if (focBtn) { focBtn.disabled = false; focBtn.textContent = 'Cerrar'; }

  await loadAll();
  showOCPanel(oc_id);
}

// ── ANTICIPO ──
function openAnticipo() {
  if (!currentOCId) return;
  document.getElementById('ant-oc-id').value=currentOCId;
  document.getElementById('ant-fecha').value=today();
  document.getElementById('ant-monto').value='';
  document.getElementById('ant-notas').value='';
  document.getElementById('ant-forma').value='transferencia';
  const ctaOpts=state.cuentas.filter(c=>c.activa!==false)
    .map(c=>`<option value="${c.id}">${c.name}${c.moneda?' ('+c.moneda+')':''}</option>`).join('');
  document.getElementById('ant-cuenta').innerHTML='<option value="">— Seleccionar cuenta —</option>'+ctaOpts;
  openModal('modal-anticipo');
}

async function saveAnticipo() {
  const oc_id=document.getElementById('ant-oc-id').value;
  const fecha=document.getElementById('ant-fecha').value;
  const monto=parseFloat(document.getElementById('ant-monto').value);
  const cuenta_id=document.getElementById('ant-cuenta').value;
  if (!fecha||isNaN(monto)||monto<=0||!cuenta_id) { toast('Todos los campos son requeridos','error'); return; }
  const {error}=await sb.from('erp_oc_anticipos').insert({
    oc_id, fecha, monto, cuenta_id,
    forma:document.getElementById('ant-forma').value,
    notas:document.getElementById('ant-notas').value.trim(),
  });
  if (error) { toast('Error: '+error.message,'error'); return; }
  // Generar asiento contable automático
  const {data:ant} = await sb.from('erp_oc_anticipos').select('id').order('created_at',{ascending:false}).limit(1);
  if (ant?.length) await asientoAnticipoOC(ant[0].id);
  toast('Anticipo registrado');
  closeModal('modal-anticipo');
  await loadAll();
  showOCPanel(oc_id);
}
