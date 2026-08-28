// ═══════════════════════════════════════════════════════════════════
// js/contabilidad.js — Fase 5 de la división del monolito (26/Ago/2026)
//
// Script CLÁSICO (no ES Module) — mismo criterio que los módulos previos:
// index.html usa onclick="funcName()", lo que exige funciones globales.
// Se carga ANTES del script principal.
//
// ALCANCE: el módulo contable completo, que en index.html vivía en TRES
// bloques no contiguos (había código de producción intercalado entre ellos):
//   1. Correlativo de asientos y helpers de cuenta
//   2. Diferencial cambiario, motor de asientos (crearAsiento y todos los
//      asientos automáticos), diario general, reportes financieros
//      (Estado de Resultados, Balance General, Flujo de Caja) y CRUD de diarios
//   3. Nomenclatura contable y módulo de Tipo de Cambio (Banguat GTQ/USD)
//
// DEPENDENCIAS EXTERNAS (resueltas en tiempo de ejecución, no de carga):
//   · js/utils.js            → fmtDate, fmtMoney, fmtNum, fmtGTQ, today
//   · js/constantes.js       → DIARIO_LABEL, DIARIO_COLOR, NOM_TIPO_COLOR,
//                              CTA_* , DIARIO_*, BANGUAT_URL, FC_GREENS, FC_REDS
//   · js/helpers-calculo.js  → periodoFechas, fcBucketKey, fcBucketLabel,
//                              nomDepth, nextCorrelativo
//   · index.html (principal) → state, sb, toast, openModal, closeModal,
//                              loadAll, showPage, crearMovimiento y otros
//                              helpers de shell/dominio
//   · CDN                    → Chart.js (gráfico de flujo de caja)
//
// Solo declaraciones de función más dos constantes de módulo
// (nomOpenGroups, NOM_GROUPS) — no se ejecuta nada al cargar.
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// MÓDULO CONTABLE COMPLETO
// ═══════════════════════════════════════════════════

// DIARIO_LABEL, DIARIO_COLOR viven ahora en js/constantes.js

// ── Correlativo de asientos ──
// BUGFIX (debugging en vivo, 13/Ago/2026): mismo problema que
// nextOCNum/nextOPNum — leía state.asientos cacheado, que se desactualiza
// cuando una sola cascada genera varios asientos seguidos sin refrescar
// el estado entre medio. Confirmado en producción: "duplicate key value
// violates unique constraint erp_asientos_numero_key" al completar una OP
// de teñido subcontratado (genera 2+ asientos en la misma corrida).
async function nextAsientoNum() {
  const year = new Date().getFullYear();
  const { data } = await sb.from('erp_asientos').select('numero').ilike('numero', `AS-${year}-%`);
  const nums = (data||[]).map(a => parseInt((a.numero||'').slice(-5))||0);
  return `AS-${year}-${String((nums.length ? Math.max(...nums) : 0)+1).padStart(5,'0')}`;
}

// ── Cuenta helper ──
function ctaNombre(id) {
  const n = state.nomenclatura.find(x => x.id === id);
  return n ? `${n.codigo} — ${n.nombre}` : id||'—';
}
function ctaById(id) { return state.nomenclatura.find(x => x.id === id); }

// ── Period helpers ──
// periodoFechas() vive ahora en js/helpers-calculo.js

// ═══════════════════════════════════════════════════
// DIFERENCIAL CAMBIARIO — Pérdida/Ganancia
// ═══════════════════════════════════════════════════

// Códigos de cuenta para diferencial cambiario
// CTA_GANANCIA_CAMBIARIA, CTA_PERDIDA_CAMBIARIA, DIARIO_CAMBIARIO,
// CTA_INV_HILO, CTA_INV_PROCESO, CTA_INV_TERMINADO, DIARIO_MANUFACTURA
// viven ahora en js/constantes.js

// ═══════════════════════════════════════════════════════════════════
// MOTOR DE ASIENTOS, DIFERENCIAL CAMBIARIO Y REPORTES FINANCIEROS
// ═══════════════════════════════════════════════════════════════════

// Cuenta de valoración REAL de un producto, según la categoría a la que
// está asignado (misma fuente de verdad que ya usa Compras vía
// snapshotCategoriaAccounts() — helper global para que cualquier asiento
// de manufactura la use en vez de asumir cuentas fijas por tipo de OP).
function getCtaValoracionProducto(productoId) {
  const prod = state.productos.find(p => p.id === productoId);
  const cat  = prod ? (state.categorias||[]).find(c => c.id === prod.categoria) : null;
  return cat ? state.nomenclatura.find(n => n.id === cat.cta_valoracion) : null;
}

/**
 * Obtiene la cuenta de ganancia o pérdida cambiaria de la nomenclatura
 */
function ctaCambiaria(esGanancia) {
  const codigo = esGanancia ? CTA_GANANCIA_CAMBIARIA : CTA_PERDIDA_CAMBIARIA;
  return state.nomenclatura.find(n => n.codigo === codigo);
}

/**
 * Obtiene el TC de referencia para una fecha dada.
 * Busca el TC exacto del día o el más cercano anterior.
 */
function getTCFecha(fecha) {
  if (!fecha) return tcHoy() || 1;
  const ordenados = [...(state.tiposCambio||[])].sort((a,b) => b.fecha.localeCompare(a.fecha));
  const exacto = ordenados.find(t => t.fecha === fecha);
  if (exacto) return Number(exacto.referencia);
  const anterior = ordenados.find(t => t.fecha <= fecha);
  return anterior ? Number(anterior.referencia) : (tcHoy() || 1);
}

/**
 * Registra asiento de diferencial cambiario.
 *
 * Cuando se cobra una factura USD, el monto en GTQ puede diferir
 * del registrado originalmente por diferencia de TC.
 *
 * Ejemplo:
 *   Factura: $1,000 × Q7.6192 = Q7,619.20  (Cuentas x Cobrar)
 *   Cobro:   $1,000 × Q7.6500 = Q7,650.00  (Banco)
 *   Ganancia cambiaria: Q30.80
 *
 * @param {object} params
 *   montoUSD       - monto en dólares de la transacción
 *   tcOriginal     - TC al momento de la factura/obligación
 *   tcLiquidacion  - TC al momento del cobro/pago
 *   fecha          - fecha del cobro/pago
 *   referencia     - descripción de la transacción
 *   referencia_id  - ID de la transacción
 *   tipo           - 'cobro' | 'pago' (afecta la dirección del diferencial)
 */
async function asientoDiferencialCambiario({
  montoUSD, tcOriginal, tcLiquidacion, fecha,
  referencia, referencia_id, tipo = 'cobro'
}) {
  const diff = (tcLiquidacion - tcOriginal) * montoUSD;
  if (Math.abs(diff) < 0.01) return; // diferencia insignificante

  // Para cobros (ventas):
  //   TC sube → ganancia (banco recibe más GTQ de lo facturado)
  //   TC baja → pérdida
  // Para pagos (compras):
  //   TC sube → pérdida (pagamos más GTQ de lo comprometido)
  //   TC baja → ganancia
  const esGanancia = tipo === 'cobro' ? diff > 0 : diff < 0;
  const montoDiff  = Math.abs(diff);

  const ctaGanPer  = ctaCambiaria(esGanancia);
  const ctaPorCobrar = state.nomenclatura.find(n => n.tipo === 'Por cobrar');
  const ctaPorPagar  = state.nomenclatura.find(n => n.tipo === 'Por pagar');
  const ctaContra    = tipo === 'cobro' ? ctaPorCobrar : ctaPorPagar;

  const desc = `Diferencial cambiario — TC original: Q${tcOriginal.toFixed(4)} → TC liquidación: Q${tcLiquidacion.toFixed(4)} | USD ${montoUSD.toFixed(2)}`;

  // GANANCIA (cobro: TC sube / pago: TC baja):
  //   Déb: Ctas x Cobrar/Pagar  Cré: Ganancia Cambiaria
  // PÉRDIDA (cobro: TC baja / pago: TC sube):
  //   Déb: Pérdida Cambiaria    Cré: Ctas x Cobrar/Pagar

  const lineasFinal = esGanancia ? [
    {
      cuenta_id: ctaContra?.id||null, cuenta_codigo: ctaContra?.codigo||'',
      cuenta_nombre: ctaContra?.nombre||'Ctas x Cobrar/Pagar',
      debe: montoDiff, haber: 0, descripcion: desc,
    },
    {
      cuenta_id: ctaGanPer?.id||null, cuenta_codigo: CTA_GANANCIA_CAMBIARIA,
      cuenta_nombre: ctaGanPer?.nombre||'Ganancia Cambiaria',
      debe: 0, haber: montoDiff, descripcion: desc,
    },
  ] : [
    {
      cuenta_id: ctaGanPer?.id||null, cuenta_codigo: CTA_PERDIDA_CAMBIARIA,
      cuenta_nombre: ctaGanPer?.nombre||'Pérdida Cambiaria',
      debe: montoDiff, haber: 0, descripcion: desc,
    },
    {
      cuenta_id: ctaContra?.id||null, cuenta_codigo: ctaContra?.codigo||'',
      cuenta_nombre: ctaContra?.nombre||'Ctas x Cobrar/Pagar',
      debe: 0, haber: montoDiff, descripcion: desc,
    },
  ];

  await crearAsiento({
    diario: DIARIO_CAMBIARIO,
    fecha,
    descripcion: `${esGanancia ? 'Ganancia' : 'Pérdida'} cambiaria — ${referencia}`,
    referencia,
    referencia_id,
    moneda: 'GTQ',
    tipo_cambio: 1,
    lineas: lineasFinal,
  });
}

// ── ACTUALIZAR asientoFacturaVenta para convertir USD→GTQ ──────
// Reemplaza la versión anterior que no convertía monedas
async function crearAsiento({ diario, fecha, descripcion, referencia, referencia_id,
  moneda='GTQ', tipo_cambio=null, tc_forzado=null, lineas, auto=true }) {

  const fechaStr   = fecha || today();
  const numero     = await nextAsientoNum();

  // TC a usar. Prioridad:
  //   1. tc_forzado — para asientos que deben heredar el TC de una transacción
  //      ya valorizada (hoy solo asientoMovInventario, que usa el TC con que
  //      se capitalizó la recepción). Así el asiento queda exactamente igual
  //      en GTQ que el auxiliar de inventario, sin depender del TC del día.
  //   2. TC del día de la transacción (comportamiento de siempre).
  //
  // ATENCIÓN (26/Ago/2026): se usa un parámetro NUEVO en vez de reactivar
  // `tipo_cambio`, que se declaraba pero nunca se leía. Varios llamadores ya
  // pasan `tipo_cambio: 1` — entre ellos los asientos de factura y pago de
  // VENTA, que van con moneda del cliente (posible USD). Si `tipo_cambio` se
  // hubiera activado, ese 1 se habría tomado como TC real y una venta de
  // USD 1,000 se habría contabilizado como Q1,000. `tipo_cambio` se mantiene
  // ignorado a propósito; no reactivarlo sin revisar los ~5 llamadores.
  const tcExplicito  = Number(tc_forzado) > 0 ? Number(tc_forzado) : null;
  const tcUsar       = tcExplicito || getTCFecha(fechaStr) || 1;
  // Con TC forzado el asiento ya está valorizado: no queda pendiente de TC
  // aunque no exista tasa publicada para esa fecha.
  const tcDisponible = tcExplicito ? true : state.tiposCambio.some(t => t.fecha === fechaStr);
  const estadoTC     = tcDisponible ? 'aplicado' : 'pendiente_tc';
  const esUSD        = moneda === 'USD';

  // Por cada línea:
  // monto_orig = valor en moneda original (USD o GTQ)
  // debe/haber = monto_orig * TC (siempre en GTQ)
  const lineasFinal = lineas.map(l => {
    const montoOrig = Number(l.debe||0) || Number(l.haber||0);
    const montoGTQ  = esUSD ? parseFloat((montoOrig * tcUsar).toFixed(4)) : montoOrig;
    return {
      ...l,
      moneda_orig: moneda,
      monto_orig:  parseFloat(montoOrig.toFixed(4)),
      // FIX (26/Ago/2026): la columna tipo_cambio de erp_asiento_lineas existe
      // desde siempre, pero nunca se escribía — quedaba en el default 1.0000
      // incluso en líneas USD. Una línea de USD 1,300 a Q9,910.81 guardaba
      // tipo_cambio 1.0000, un dato falso que alguien podría leer creyéndole.
      // Ahora se escribe el TC realmente aplicado (1 cuando es GTQ).
      tipo_cambio: esUSD ? tcUsar : 1,
      debe:        Number(l.debe||0)  > 0 ? montoGTQ : 0,
      haber:       Number(l.haber||0) > 0 ? montoGTQ : 0,
      debe_gtq:    Number(l.debe||0)  > 0 ? montoGTQ : 0,
      haber_gtq:   Number(l.haber||0) > 0 ? montoGTQ : 0,
    };
  });

  const debe_total  = lineasFinal.reduce((s,l) => s + Number(l.debe_gtq||0),  0);
  const haber_total = lineasFinal.reduce((s,l) => s + Number(l.haber_gtq||0), 0);
  const monto_orig_total = lineas.reduce((s,l) => s + (Number(l.debe||0)||Number(l.haber||0)), 0);

  const { data: asiento, error } = await sb.from('erp_asientos').insert({
    numero, diario, fecha: fechaStr, descripcion, referencia, referencia_id,
    moneda,
    monto_orig:  parseFloat(monto_orig_total.toFixed(4)),
    tipo_cambio: tcUsar,
    debe_total:  parseFloat(debe_total.toFixed(4)),
    haber_total: parseFloat(haber_total.toFixed(4)),
    estado: 'publicado', auto,
    estado_tc:   estadoTC,
    fecha_tc:    tcDisponible ? fechaStr : null,
    tc_aplicado: tcDisponible ? tcUsar : null,
  }).select().single();

  if (error) { console.error('Error creando asiento:', error.message); return null; }

  const lineasConId = lineasFinal.map(l => ({ ...l, asiento_id: asiento.id }));
  await sb.from('erp_asiento_lineas').insert(lineasConId);

  if (estadoTC === 'pendiente_tc') {
    const badge = document.getElementById('tc-pending-badge');
    if (badge) badge.style.display = 'inline-flex';
  }

  return asiento.id;
}

// 1. VENTA — Al publicar factura de venta (con conversión USD→GTQ)
// moneda: 'GTQ' o 'USD' — la de la factura/cliente, NUNCA forzada a GTQ. Las
// líneas se arman con los montos en SU MONEDA ORIGINAL (sin convertir); es
// crearAsiento() quien, recibiendo esa moneda a nivel de asiento, calcula el
// equivalente en GTQ por línea (debe_gtq/haber_gtq, para el balance general)
// Y conserva el monto real (monto_orig/moneda_orig) — necesario para poder
// conciliar Cuentas x Cobrar o una cuenta bancaria cuando están configuradas
// en USD en la nomenclatura. Mismo patrón que buildLineasFacturaCompra()/
// buildLineasPago().
async function asientoFacturaVenta(facturaId) {
  const f = state.facturas.find(x => x.id === facturaId);
  if (!f) return;
  const cliente   = state.clientes.find(c => c.id === f.customer_id);
  const monedaCli = cliente?.moneda || 'GTQ';
  const totalOrig = Number(f.total||0);
  const ivaOrig   = totalOrig - (totalOrig / 1.12);
  const netoOrig  = totalOrig - ivaOrig;

  const ctaPorCobrar = state.nomenclatura.find(n => n.tipo === 'Por cobrar');
  const ctaIngresos  = state.nomenclatura.find(n => n.tipo === 'Ingreso');
  const ctaIVA       = state.nomenclatura.find(n => n.codigo === '21104004')
    || state.nomenclatura.find(n => (n.nombre||'').toLowerCase().includes('iva') && n.tipo === 'Pasivos Circulantes');

  await crearAsiento({
    diario: 'VENTAS', fecha: f.date,
    descripcion: `Factura ${f.serie||''}${f.invoice_number} — ${cliente?.name||''}`,
    referencia: `Factura ${f.invoice_number}`, referencia_id: facturaId,
    moneda: monedaCli,
    lineas: [
      { cuenta_id: ctaPorCobrar?.id||null, cuenta_codigo: ctaPorCobrar?.codigo||'POR COBRAR', cuenta_nombre: ctaPorCobrar?.nombre||'Cuentas x Cobrar', debe: totalOrig, haber: 0, descripcion: `Factura ${f.invoice_number}` },
      { cuenta_id: ctaIngresos?.id||null,  cuenta_codigo: ctaIngresos?.codigo||'INGRESOS',    cuenta_nombre: ctaIngresos?.nombre||'Ingresos por Ventas', debe: 0, haber: netoOrig, descripcion: 'Ingreso neto' },
      { cuenta_id: ctaIVA?.id||null,       cuenta_codigo: ctaIVA?.codigo||'IVA-POR-PAGAR',   cuenta_nombre: ctaIVA?.nombre||'IVA por Pagar', debe: 0, haber: ivaOrig, descripcion: 'IVA 12%' },
    ],
  });
}

// 2. COBRO — Al registrar pago + diferencial cambiario automático
async function asientoPagoVenta(pagoId) {
  const pg      = state.pagos.find(x => x.id === pagoId);
  if (!pg) return;
  const factura  = state.facturas.find(f => f.id === pg.factura_id);
  const cliente  = state.clientes.find(c => c.id === factura?.customer_id);
  const cuenta   = state.cuentas.find(c => c.id === pg.cuenta_id);
  const monedaCli = cliente?.moneda || 'GTQ';
  const esUSD     = monedaCli === 'USD';
  const montoOrig = Number(pg.monto||0);

  const ctaPorCobrar = state.nomenclatura.find(n => n.tipo === 'Por cobrar');
  // El cobro NO se contabiliza directo contra el banco — se contabiliza
  // contra la cuenta transitoria "Cobros Pendientes" de su moneda. El
  // segundo asiento (Debe Banco real / Haber Cobros Pendientes) se genera
  // recién cuando el extracto bancario confirma el ingreso, vía
  // asientoConfirmacionBancaria() (ver vincularManual()/autoMatchConciliacion()).
  const ctaTransitoria = transitoriaNomenclatura(cuenta?.moneda || monedaCli, 'cobro');

  await crearAsiento({
    diario: 'COBROS', fecha: pg.fecha,
    descripcion: `Cobro factura ${factura?.invoice_number||''} — ${cuenta?.name||''}`,
    referencia: `Pago factura ${factura?.invoice_number||''}`, referencia_id: pagoId,
    moneda: monedaCli,
    lineas: [
      { cuenta_id: ctaTransitoria?.id||null, cuenta_codigo: ctaTransitoria?.codigo||'COBROS-PEND', cuenta_nombre: ctaTransitoria?.nombre||'Cobros Pendientes', debe: montoOrig, haber: 0, descripcion: `Pendiente de confirmar — ${cuenta?.name||''}` },
      { cuenta_id: ctaPorCobrar?.id||null, cuenta_codigo: ctaPorCobrar?.codigo||'COBRAR', cuenta_nombre: ctaPorCobrar?.nombre||'Cuentas x Cobrar', debe: 0, haber: montoOrig, descripcion: 'Cancelación x cobrar' },
    ],
  });

  // Diferencial cambiario — compara el TC del día de cobro contra el TC
  // vigente cuando se emitió la factura (independiente de la conversión que
  // ya hace crearAsiento línea por línea; esto corrige el desfase acumulado
  // en el saldo de Cuentas x Cobrar cuando el TC cambió entre ambas fechas).
  // Solo aplica si la factura es en USD.
  const tcCobro = getTCFecha(pg.fecha);
  if (esUSD && factura?.date) {
    const tcFactura = getTCFecha(factura.date);
    if (Math.abs(tcCobro - tcFactura) > 0.0001) {
      await asientoDiferencialCambiario({
        montoUSD: montoOrig,
        tcOriginal: tcFactura,
        tcLiquidacion: tcCobro,
        fecha: pg.fecha,
        referencia: `Factura ${factura.invoice_number}`,
        referencia_id: pagoId,
        tipo: 'cobro',
      });
    }
  }
}

// 3. COMPRA — Al registrar factura de proveedor (OC) con conversión USD→GTQ
// Calcula las líneas del asiento de una factura de compra (OC) a partir de
// oc_id/tipo/total — sin depender de que la factura ya exista en la BD.
// Usada tanto para la previsualización en el modal como para el asiento real
// al guardar, para que nunca queden desincronizados.
// Cuentas por Pagar Proveedores — resuelve por moneda/origen del proveedor de
// la OC: Locales GTQ (21101001) / Locales USD (21101002) / Extranjero USD (21102011).
// Cae de regreso al código genérico 21101001 (o al primer "Por pagar" con nombre
// "proveedores") si la cuenta específica no existe. Compartida entre la factura
// de compra (buildLineasFacturaCompra) y el pago (buildLineasPago) para que
// ambas SIEMPRE resuelvan a la misma cuenta — si un día cambia la regla, solo
// se edita aquí.
function ctaPorPagarOC(oc_id) {
  const oc            = state.oc.find(o => o.id === oc_id);
  const prov          = state.proveedores.find(p => p.id === oc?.proveedor_id);
  const esExtranjero  = !!(prov?.pais && prov.pais !== 'GT' && prov.pais !== 'Guatemala');
  const monedaOC      = getMonedaOC(oc_id);
  const codigo        = esExtranjero ? '21102011' : (monedaOC === 'USD' ? '21101002' : '21101001');
  return state.nomenclatura.find(n => n.codigo === codigo)
    || state.nomenclatura.find(n =>
         n.codigo === '21101001' ||
         ((n.nombre||'').toLowerCase().includes('proveedores') && n.tipo?.toLowerCase().includes('pasivo'))
       );
}

// neto/iva (opcionales): monto real de IVA de la factura, ya calculado
// respetando el checkbox de IVA de CADA línea (ver focNetoIvaFromDOM() y
// erp_compras.valor_neto/valor_iva). Si se reciben, mandan sobre `tipo` —
// una factura puede ser "Cambiaria" y aun así llevar 0 de IVA porque el
// usuario desmarcó el checkbox de sus líneas (la mayoría de materia prima
// no paga IVA). Si NO se reciben (llamadas antiguas/sin ese dato), cae al
// criterio anterior basado en el tipo de factura (FX = exportación = sin IVA).
function buildLineasFacturaCompra({ oc_id, tipo, total, neto=null, iva=null }) {
  const totalOrig  = Number(total||0);
  const tieneNetoIva = neto !== null && iva !== null;
  const esIVA      = tieneNetoIva ? Number(iva) > 0.001 : tipo !== 'FX';

  // Get category from first OC item product
  const ocItems    = state.ocItems.filter(i => i.oc_id === oc_id);
  const firstProd  = state.productos.find(p => p.id === ocItems[0]?.producto_id);
  const cat        = firstProd?.categoria ? state.categorias?.find(c => c.id === firstProd.categoria) : null;
  const esServicio = ocItems.length > 0 && ocItems.every(i => state.productos.find(p=>p.id===i.producto_id)?.tipo === 'servicio');
  const esManual   = !cat || cat.valoracion === 'manual' || !cat.valoracion;

  // Use category accounts
  const ctaGastoId     = cat?.cta_gasto     || null;
  const ctaIngresosId  = cat?.cta_ingresos  || null;
  const ctaValorId     = cat?.cta_valoracion || null;
  const ctaEntradaId   = cat?.cta_entrada   || null;

  // Debit account:
  // - Servicios: no pasan por inventario — van directo a Cta. Gasto (como antes).
  // - Productos almacenables: la recepción YA debitó Cta. Valoración (automática)
  //   o Cta. Ingresos (manual) y acreditó una cuenta puente (Cta. Entrada / Cta.
  //   Gasto) representando "recibido, pendiente de facturar" — igual que Odoo
  //   hace con su "Stock Interim (Received)" en valoración automatizada. La
  //   factura debe CANCELAR esa cuenta puente (debitarla), no volver a debitar
  //   Valoración/Ingresos — si no, el inventario queda contabilizado el doble y
  //   la cuenta puente nunca se cierra.
  const ctaDebeId = esServicio
    ? (ctaGastoId || ctaIngresosId)
    : esManual
      ? (ctaGastoId || ctaIngresosId || ctaValorId)
      : (ctaEntradaId || ctaValorId || ctaIngresosId || ctaGastoId);

  // IVA Credito Fiscal — find by code 11205001 or by name
  const ctaIVACred  = state.nomenclatura.find(n =>
    n.codigo === '11205001' ||
    ((n.nombre||'').toLowerCase().includes('iva') && (n.nombre||'').toLowerCase().includes('cr'))
  );

  const ctaPorPagar = ctaPorPagarOC(oc_id);

  const ctaNom = id => state.nomenclatura.find(n => n.id === id);
  const ctaDebe = ctaNom(ctaDebeId);

  const lineas = [];
  if (esIVA) {
    // Con neto/iva reales (respetando el checkbox por línea) si vinieron;
    // si no, se parte el total 12% como antes (fallback sin ese dato).
    let netoLinea = tieneNetoIva ? parseFloat(Number(neto).toFixed(4)) : parseFloat((totalOrig / 1.12).toFixed(4));
    let ivaLinea  = tieneNetoIva ? parseFloat(Number(iva).toFixed(4))  : parseFloat((totalOrig - netoLinea).toFixed(4));
    // Blindaje: neto+iva DEBE sumar exactamente el total facturado (que es
    // lo que se acredita a Cuentas x Pagar más abajo) — si no coinciden
    // (ej. neto/iva vinieron de un cálculo por línea desincronizado del
    // total real, ver saveFacturaOC()), se reescala proporcionalmente para
    // que el asiento SIEMPRE cuadre. saveFacturaOC() ya bloquea este caso
    // antes de guardar, así que esto es una segunda red de seguridad para
    // cualquier otro llamador (ej. asientoFacturaCompra() reconstruyendo
    // desde erp_compras) que use datos ya desincronizados.
    const sumaCheck = netoLinea + ivaLinea;
    if (Math.abs(sumaCheck - totalOrig) > 0.01 && sumaCheck > 0) {
      console.warn(`buildLineasFacturaCompra: neto+iva (${sumaCheck}) no coincide con total (${totalOrig}) — reescalando proporcionalmente.`);
      const factor = totalOrig / sumaCheck;
      netoLinea = parseFloat((netoLinea * factor).toFixed(4));
      ivaLinea  = parseFloat((totalOrig - netoLinea).toFixed(4));
    }
    lineas.push({ cuenta_id: ctaDebeId||null, cuenta_codigo: ctaDebe?.codigo||'GASTO', cuenta_nombre: ctaDebe?.nombre||(esServicio?'Gasto':'Inventario'), debe: netoLinea, haber: 0 });
    lineas.push({ cuenta_id: ctaIVACred?.id||null, cuenta_codigo: ctaIVACred?.codigo||'IVA-CRED', cuenta_nombre: ctaIVACred?.nombre||'IVA Crédito Fiscal', debe: ivaLinea, haber: 0 });
  } else {
    lineas.push({ cuenta_id: ctaDebeId||null, cuenta_codigo: ctaDebe?.codigo||'GASTO', cuenta_nombre: ctaDebe?.nombre||(esServicio?'Gasto':'Inventario'), debe: totalOrig, haber: 0 });
  }
  lineas.push({ cuenta_id: ctaPorPagar?.id||null, cuenta_codigo: ctaPorPagar?.codigo||'POR-PAGAR', cuenta_nombre: ctaPorPagar?.nombre||'Cuentas por Pagar Proveedores', debe: 0, haber: totalOrig });

  return lineas;
}

async function asientoFacturaCompra(ocFacturaId) {
  const fc   = state.ocFacturas.find(x => x.id === ocFacturaId);
  if (!fc) return;
  const oc   = state.oc.find(o => o.id === fc.oc_id);
  const prov = state.proveedores.find(p => p.id === oc?.proveedor_id);
  const monedaOC = getMonedaOC(oc?.id);

  // El neto/IVA reales (respetando el checkbox de IVA por línea) ya quedaron
  // grabados en erp_compras al registrar la factura en el Libro de Compras
  // (ver saveFacturaOC → focNetoIvaFromDOM()) — se reutilizan aquí para que
  // el asiento NUNCA quede desincronizado de lo que el usuario vio/aprobó
  // en pantalla, sin volver a inferir el IVA a partir del tipo de factura.
  const compra = (state.compras||[]).find(c => c.factura_id === ocFacturaId);
  const lineas = buildLineasFacturaCompra({
    oc_id: fc.oc_id, tipo: fc.tipo, total: fc.total,
    neto: compra ? Number(compra.valor_neto||0) : null,
    iva:  compra ? Number(compra.valor_iva||0)  : null,
  });

  await crearAsiento({
    diario: 'COMPRAS', fecha: fc.fecha,
    descripcion: `Factura compra ${fc.serie||''}${fc.numero} — ${prov?.name||''}`,
    referencia: `${fc.serie||''}${fc.numero}`, referencia_id: ocFacturaId,
    moneda: monedaOC,
    lineas,
  });
}

// 4. PAGO PROVEEDOR — Anticipo OC con diferencial cambiario
// moneda: monedaProv (la de la OC), no forzada a GTQ — misma razón que en
// asientoFacturaVenta/asientoPagoVenta/buildLineasPago: la cuenta de Banco
// (o de Anticipos) puede estar configurada en USD en la nomenclatura, y
// necesita su monto real (moneda_orig/monto_orig) para poder conciliarse,
// además del equivalente en GTQ que ya calcula crearAsiento() para el
// balance general.
//
// NOTA — a diferencia de buildLineasPago()/asientoPagoVenta(), este asiento
// SÍ sigue contabilizando directo contra el banco (no contra una cuenta
// transitoria). Motivo: erp_extracto_bancario.pago_id solo referencia
// erp_pagos, no erp_oc_anticipos — hoy no hay forma de vincular un anticipo
// a una línea del extracto bancario, así que si se contabilizara contra la
// transitoria, ese saldo nunca se limpiaría. Pendiente: extender la
// conciliación bancaria para soportar anticipos y homologar este asiento.
async function asientoAnticipoOC(anticipoId) {
  const ant    = state.ocAnticipos.find(x => x.id === anticipoId);
  if (!ant) return;
  const oc     = state.oc.find(o => o.id === ant.oc_id);
  const prov   = state.proveedores.find(p => p.id === oc?.proveedor_id);
  const cuenta = state.cuentas.find(c => c.id === ant.cuenta_id);
  const monedaProv = getMonedaOC(oc?.id);
  const esUSD      = monedaProv === 'USD';
  const montoOrig  = Number(ant.monto||0);

  const ctaBanco    = bancoNomenclatura(ant.cuenta_id);
  const ctaAnticipo = state.nomenclatura.find(n => n.codigo === '11204001')
    || state.nomenclatura.find(n => (n.nombre||'').toLowerCase().includes('anticipo') && (n.nombre||'').toLowerCase().includes('proveedor'));

  // Si hay factura previa de OC, calcular diferencial cambiario (desfase
  // entre el TC vigente cuando se emitió la factura y el TC del día del
  // anticipo) — independiente de la conversión GTQ que hace crearAsiento
  // línea por línea.
  const facturaOC = state.ocFacturas.find(f => f.oc_id === oc?.id);
  if (esUSD && facturaOC?.fecha) {
    const tcPago    = getTCFecha(ant.fecha);
    const tcFactura = getTCFecha(facturaOC.fecha);
    if (Math.abs(tcPago - tcFactura) > 0.0001) {
      await asientoDiferencialCambiario({
        montoUSD: montoOrig,
        tcOriginal: tcFactura,
        tcLiquidacion: tcPago,
        fecha: ant.fecha,
        referencia: `OC ${oc?.numero||''}`,
        referencia_id: anticipoId,
        tipo: 'pago',
      });
    }
  }

  await crearAsiento({
    diario: 'PAGOS', fecha: ant.fecha,
    descripcion: `Anticipo a ${prov?.name||'Proveedor'} — ${oc?.numero||''}`,
    referencia: `Anticipo OC ${oc?.numero||''}`, referencia_id: anticipoId,
    moneda: monedaProv,
    lineas: [
      { cuenta_id: ctaAnticipo?.id||null, cuenta_codigo: ctaAnticipo?.codigo||'ANTICIPOS', cuenta_nombre: ctaAnticipo?.nombre||'Anticipos a Proveedores', debe: montoOrig, haber: 0, descripcion: 'Anticipo' },
      { cuenta_id: ctaBanco?.id||null,    cuenta_codigo: ctaBanco?.codigo||'BANCO',        cuenta_nombre: cuenta?.name||'Banco/Caja', debe: 0, haber: montoOrig, descripcion: 'Salida de banco' },
    ],
  });
}

// 5. INVENTARIO — Al crear movimiento de inventario
async function asientoMovInventarioManual(movId, cat, moneda='GTQ') {
  const mov   = state.movimientos.find(x => x.mov_id === movId);
  if (!mov) return;
  if (mov.tipo === 'consignacion') return;

  const prod      = state.productos.find(p => p.id === mov.producto_id);
  const monto     = Number(mov.costo_total_gtq || mov.costo_total || 0);
  if (!monto) return;

  const isEntrada    = mov.tipo === 'entrada' || mov.tipo === 'ajuste_positivo';
  const isDevolucion = mov.referencia_tipo === 'DEV-OC';

  // For manual: use cta_ingresos for entries, cta_gasto for exits
  const ctaIngresos = mov.snap_cta_ingresos || cat?.cta_ingresos || null;
  const ctaGasto    = mov.snap_cta_gasto    || cat?.cta_gasto    || null;
  const ctaNom      = id => state.nomenclatura.find(n => n.id === id);

  let debe, haber;
  if (isDevolucion) {
    debe  = ctaIngresos; haber = ctaGasto;
  } else if (isEntrada) {
    debe  = ctaIngresos; haber = ctaGasto;
  } else {
    debe  = ctaGasto;    haber = ctaIngresos;
  }

  if (!debe && !haber) return; // no accounts configured

  await crearAsiento({
    diario: 'INVENTARIO', fecha: mov.fecha,
    descripcion: `${isEntrada?'Entrada':'Salida'} inventario (manual) — ${prod?.description||''} (${mov.mov_id})`,
    referencia: mov.mov_id, referencia_id: mov.id,
    moneda: 'GTQ',
    lineas: [
      { cuenta_id: debe||null,  cuenta_codigo: ctaNom(debe)?.codigo||'INV-DEBE',   cuenta_nombre: ctaNom(debe)?.nombre||'Inventario',  debe: monto, haber: 0,     descripcion: mov.mov_id },
      { cuenta_id: haber||null, cuenta_codigo: ctaNom(haber)?.codigo||'INV-HABER', cuenta_nombre: ctaNom(haber)?.nombre||'Contra inv.', debe: 0,     haber: monto, descripcion: mov.mov_id },
    ],
  });
}

// NOTA: monedaParam se conserva por compatibilidad con el llamador
// (crearMovimientoConAsiento), pero ya NO se usa: la moneda y el TC se leen
// directamente de la fila del movimiento, que es la fuente de verdad de cómo
// se valorizó esa entrada. Antes se recibía y también se ignoraba, con la
// diferencia de que entonces el asiento quedaba mal.
async function asientoMovInventario(movId, monedaParam = null) {
  const mov  = state.movimientos.find(x => x.mov_id === movId);
  if (!mov) return;

  if (mov.tipo === 'consignacion') return;

  // Check category valoracion — if manual, no accounting entry
  const prod = state.productos.find(p => p.id === mov.producto_id);
  const cat  = prod?.categoria ? state.categorias?.find(c => c.id === prod.categoria) : null;
  if (!cat || cat.valoracion === 'manual' || !cat.valoracion) return;

  const ctaValoracion = mov.snap_cta_valoracion || null;
  const ctaEntrada    = mov.snap_cta_entrada || null;
  const ctaSalida     = mov.snap_cta_salida  || null;
  const ctaTransito   = mov.snap_cta_transito || null;
  const ctaNom = id => state.nomenclatura.find(n => n.id === id);

  const isEntrada    = mov.tipo === 'entrada' || mov.tipo === 'ajuste_positivo';
  const isDevolucion = mov.referencia_tipo === 'DEV-OC';

  let debe, haber;
  if (isDevolucion) {
    // Devolución = reversa de entrada: Entrada Stock (Debe) / Valoración Stock (Haber)
    debe  = ctaEntrada;
    haber = ctaValoracion;
  } else if (isEntrada) {
    debe  = ctaValoracion;
    haber = ctaEntrada;
  } else {
    debe  = ctaSalida;
    haber = ctaValoracion;
  }

  // FIX (26/Ago/2026): antes esta función forzaba moneda:'GTQ' y mandaba el
  // costo YA convertido, así que el asiento guardaba monto_orig en GTQ y se
  // perdía la moneda original de la compra (una OC en USD 1,300 aparecía en
  // el Diario General como GTQ 9,910.81 en "Monto Original").
  //
  // Ahora se pasan los valores tal como quedaron guardados en el movimiento:
  // costo_total (moneda original), moneda, y el TC implícito de esa misma
  // fila. Al heredar el TC del movimiento — en vez de dejar que crearAsiento
  // busque el del día — el GTQ del asiento queda idéntico a costo_total_gtq,
  // así que el mayor cuadra siempre contra el auxiliar de inventario.
  const esUSD = (mov.moneda || 'GTQ') === 'USD';
  const gtqReal   = Number(mov.costo_total_gtq || 0);
  const totalGTQ  = gtqReal || Number(mov.costo_total || 0);
  const totalOrig = Number(esUSD ? (mov.costo_total || 0) : totalGTQ);

  // TC del movimiento. Prioridad:
  //   1. mov.tipo_cambio — columna guardada al crear el movimiento
  //      (26/Ago/2026). Es la fuente correcta: sobrevive al caso de costo
  //      cero, donde no hay nada que dividir.
  //   2. Derivación gtqReal/costo_total — solo para filas anteriores a esa
  //      columna. Requiere ambos lados > 0; si no, se deja null y
  //      crearAsiento usa el TC del día.
  // Nunca se deriva de totalGTQ (que cae al costo_total como respaldo):
  // eso daría TC = 1 y contabilizaría USD 100 como Q100.
  let tcMov = Number(mov.tipo_cambio) > 0 ? Number(mov.tipo_cambio) : null;
  if (!tcMov && esUSD && Number(mov.costo_total) > 0 && gtqReal > 0) {
    tcMov = Number((gtqReal / Number(mov.costo_total)).toFixed(6));
  }
  // En GTQ el TC es 1 y no hay nada que forzar: se deja null para que
  // crearAsiento siga su camino normal.
  if (!esUSD) tcMov = null;

  const monto = totalOrig;
  if (!monto) return;

  await crearAsiento({
    diario: 'INVENTARIO', fecha: mov.fecha,
    descripcion: `${isEntrada?'Entrada':'Salida'} inventario — ${prod?.description||''} (${mov.mov_id})`,
    referencia: mov.mov_id, referencia_id: mov.id,
    moneda: mov.moneda || 'GTQ',
    tc_forzado: tcMov,
    lineas: [
      { cuenta_id: debe||null,  cuenta_codigo: ctaNom(debe)?.codigo||'INV-DEBE',   cuenta_nombre: ctaNom(debe)?.nombre||'Inventario',        debe: monto, haber: 0,     descripcion: mov.mov_id },
      { cuenta_id: haber||null, cuenta_codigo: ctaNom(haber)?.codigo||'INV-HABER', cuenta_nombre: ctaNom(haber)?.nombre||'Contra inventario', debe: 0,     haber: monto, descripcion: mov.mov_id },
    ],
  });
}

// ──────────────────────────────────────────────────
// DIARIO GENERAL — RENDER
// ──────────────────────────────────────────────────
function renderDiarioGeneral() {
  const q   = (document.getElementById('search-dg')?.value||'').toLowerCase();
  const dj  = document.getElementById('filter-dg-diario')?.value||'';
  const mes = document.getElementById('filter-dg-mes')?.value||'';

  // Filter asientos
  let asientos = [...state.asientos].sort((a,b) => {
    const dc = (a.fecha||'').localeCompare(b.fecha||'');
    return dc !== 0 ? dc : (a.numero||'').localeCompare(b.numero||'');
  });
  asientos = asientos.filter(a =>
    (!dj  || a.diario === dj) &&
    (!mes || (a.fecha||'').startsWith(mes))
  );

  // Expand to one row per asiento line
  let rows = [];
  asientos.forEach(a => {
    const lineas = (state.asientoLineas||[]).filter(l => l.asiento_id === a.id);
    lineas.forEach(l => {
      // Apply search filter on any field
      if (q && !(
        (a.numero||'').toLowerCase().includes(q) ||
        (a.descripcion||'').toLowerCase().includes(q) ||
        (a.referencia||'').toLowerCase().includes(q) ||
        (l.cuenta_codigo||'').toLowerCase().includes(q) ||
        (l.cuenta_nombre||'').toLowerCase().includes(q) ||
        (l.descripcion||'').toLowerCase().includes(q)
      )) return;
      rows.push({ a, l });
    });
  });

  let sumDebe = 0, sumHaber = 0;
  const tbody = document.getElementById('tbl-dg');
  if (!tbody) return;

  // Group rows by asiento for visual grouping
  let lastAsientoId = null;
  tbody.innerHTML = rows.length ? rows.map(({ a, l }) => {
    const fechaFmt   = fmtDate(a.fecha);
    const pendienteTC = a.estado_tc === 'pendiente_tc';
    const debeGTQ    = Number(l.debe_gtq||l.debe||0);
    const haberGTQ   = Number(l.haber_gtq||l.haber||0);
    const montoOrig  = Number(l.monto_orig||0);
    const monedaOrig = l.moneda_orig || a.moneda || 'GTQ';
    const isNewAsiento = a.id !== lastAsientoId;
    lastAsientoId = a.id;
    sumDebe  += debeGTQ;
    sumHaber += haberGTQ;

    // El número abre la hoja de detalle del asiento (26/Ago/2026, a pedido
    // explícito). El Libro Mayor se deja tal cual — una fila por línea —;
    // esto solo agrega el acceso al detalle desde el correlativo.
    const numCell    = `<span class="td-mono" onclick="showAsientoDetail('${a.id}')" title="Ver detalle del asiento" style="font-weight:700;color:var(--accent);font-size:11px;cursor:pointer">${a.numero||'—'}</span>`;
    const diarioCell = `<span class="badge ${DIARIO_COLOR[a.diario]||'badge-gray'}" style="font-size:10px">${DIARIO_LABEL[a.diario]||a.diario}</span>`;
    const refCell    = a.referencia||'—';
    const estadoCell = pendienteTC
      ? '<span class="badge badge-yellow" style="font-size:10px">⏳ TC</span>'
      : '<span class="badge badge-green" style="font-size:10px">✓</span>';

    return `<tr style="${pendienteTC?'background:#FFFBEB;':''}${isNewAsiento&&rows.findIndex(r=>r.a.id===a.id)>0?'border-top:2px solid var(--border);':''}">
      <td class="td-mono" style="font-size:11px;white-space:nowrap">${numCell}</td>
      <td style="white-space:nowrap;font-size:12px">${fechaFmt}</td>
      <td>${diarioCell}</td>
      <td style="font-size:12px;color:var(--text2)">${a.descripcion||'—'}</td>
      <td class="td-mono" style="font-size:11px;font-weight:600;color:var(--text)">${l.cuenta_codigo||'—'}</td>
      <td style="font-size:12px">
        <div style="font-weight:500">${l.cuenta_nombre||'—'}</div>
        ${l.descripcion?`<div style="font-size:10px;color:var(--text3)">${l.descripcion}</div>`:''}
      </td>
      <td class="hide-mobile" style="font-size:11px;color:var(--text2)">${refCell}</td>
      <td class="td-mono" style="text-align:right;font-size:11px;color:var(--text2)">
        ${montoOrig>0
          ? `<span style="font-size:10px;color:var(--text3)">${monedaOrig}</span> ${fmtMoney(montoOrig, monedaOrig)}`
          : '—'}
      </td>
      <td class="td-mono" style="text-align:right;color:var(--accent3);font-weight:600">${debeGTQ>0?fmtGTQ(debeGTQ):''}</td>
      <td class="td-mono" style="text-align:right;color:var(--accent3);font-weight:600">${haberGTQ>0?fmtGTQ(haberGTQ):''}</td>
      <td>${estadoCell}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="11"><div class="empty-state"><p>Sin movimientos contables</p></div></td></tr>';

  const tfoot = document.getElementById('tfoot-dg');
  const pendientesCount = asientos.filter(a => a.estado_tc === 'pendiente_tc').length;
  if (tfoot) tfoot.innerHTML = `
    ${pendientesCount > 0 ? `<tr style="background:#FFFBEB"><td colspan="11" style="padding:8px 14px;font-size:12px;color:var(--yellow);font-weight:600">
      ⚠ ${pendientesCount} asiento${pendientesCount!==1?'s':''} pendiente${pendientesCount!==1?'s':''} de TC — Cierre contable bloqueado hasta confirmar tipo de cambio.
    </td></tr>` : ''}
    ${rows.length ? `<tr style="background:var(--surface2);font-weight:600">
      <td colspan="8" style="padding:10px 14px;font-size:12px;color:var(--text2)">TOTALES — ${rows.length} línea${rows.length!==1?'s':''} (${asientos.length} asiento${asientos.length!==1?'s':''})</td>
      <td class="td-mono" style="text-align:right;padding:10px 14px;color:var(--accent3)">${fmtGTQ(sumDebe)}</td>
      <td class="td-mono" style="text-align:right;padding:10px 14px;color:var(--accent3)">${fmtGTQ(sumHaber)}</td>
      <td></td>
    </tr>` : ''}`;
}

// ── DETALLE DE ASIENTO CONTABLE (26/Ago/2026, a pedido explícito) ──
// Hoja con la cabecera del asiento y todas sus líneas, imprimible, con
// drill-through al documento que lo originó. El Libro Mayor no cambia:
// sigue mostrando una fila por línea; esto es la vista de un asiento.
//
// Antes estas dos funciones existían vacías (`function showAsientoDetail(){}`)
// de una versión anterior en que el diario mostraba una fila por asiento.

// Resuelve a qué documento apunta un asiento y cómo abrirlo. La referencia
// guardada es el correlativo de negocio (OC-…, OP-…, REA-…, MV-…), así que
// se identifica por prefijo. Devuelve null si no hay destino conocido —
// en ese caso simplemente no se ofrece el botón, en vez de fallar.
function _asientoDrillDestino(a) {
  const ref = (a?.referencia||'').trim();
  if (!ref) return null;

  if (/^OC-/.test(ref)) {
    const oc = (state.oc||[]).find(o => o.numero === ref);
    return oc ? { label:`Ver ${ref}`, fn:`closeModal('modal-asiento-detail');showOCPanel('${oc.id}')` } : null;
  }
  if (/^OP-/.test(ref)) {
    const op = (state.op||[]).find(o => o.numero === ref);
    return op ? { label:`Ver ${ref}`, fn:`closeModal('modal-asiento-detail');showOPDetail('${op.id}')` } : null;
  }
  if (/^REA-/.test(ref)) {
    const existe = (state.reabastecimiento||[]).some(r => r.numero === ref);
    return existe ? { label:`Ver ${ref}`, fn:`closeModal('modal-asiento-detail');verReabastecimiento('${ref}')` } : null;
  }
  if (/^MV-/.test(ref)) {
    // Los movimientos de inventario no tienen ficha propia; el destino útil
    // es el Kardex del producto involucrado.
    const mov = (state.movimientos||[]).find(m => m.mov_id === ref);
    return mov ? { label:'Ver en Kardex', fn:`closeModal('modal-asiento-detail');showPage('kardex',null)` } : null;
  }
  return null;
}

function showAsientoDetail(id) {
  const a = (state.asientos||[]).find(x => x.id === id);
  if (!a) { toast('Asiento no encontrado','error'); return; }
  const lineas = (state.asientoLineas||[]).filter(l => l.asiento_id === a.id);
  const totDebe  = lineas.reduce((s,l) => s + Number(l.debe||0), 0);
  const totHaber = lineas.reduce((s,l) => s + Number(l.haber||0), 0);
  // Tolerancia de un centavo: los montos se redondean a 4 decimales por
  // línea, así que exigir igualdad exacta daría falsos descuadres.
  const cuadra = Math.abs(totDebe - totHaber) < 0.01;
  const esUSD  = a.moneda === 'USD';

  document.getElementById('asiento-detail-title').textContent = `${a.numero} — ${DIARIO_LABEL[a.diario]||a.diario}`;
  document.getElementById('asiento-detail-body').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px">
      <div><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:3px">Fecha</div>
        <div style="font-size:13px;font-weight:600">${fmtDate(a.fecha)}</div></div>
      <div><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:3px">Diario</div>
        <span class="badge ${DIARIO_COLOR[a.diario]||'badge-gray'}">${DIARIO_LABEL[a.diario]||a.diario}</span></div>
      <div><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:3px">Referencia</div>
        ${(() => {
          // La referencia es el acceso al documento origen (26/Ago/2026, a
          // pedido explícito): se hace clic sobre el albarán, sin botón
          // aparte en el pie. Si el documento no existe o el prefijo no se
          // reconoce, se muestra como texto plano en vez de un enlace muerto.
          const d = _asientoDrillDestino(a);
          return d
            ? `<div class="td-mono" onclick="${d.fn}" title="Abrir ${a.referencia}" style="font-size:13px;font-weight:600;color:var(--accent);cursor:pointer">${a.referencia}</div>`
            : `<div class="td-mono" style="font-size:13px;font-weight:600">${a.referencia||'—'}</div>`;
        })()}</div>
      <div><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:3px">Moneda</div>
        <div style="font-size:13px;font-weight:600">${a.moneda||'GTQ'}${esUSD?` · TC ${Number(a.tipo_cambio||0).toFixed(4)}`:''}</div></div>
    </div>

    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:4px">Descripción</div>
    <div style="font-size:13px;color:var(--text2);margin-bottom:20px">${a.descripcion||'—'}</div>

    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Cuenta</th><th>Descripción</th>
          ${esUSD?'<th style="text-align:right">Monto Orig.</th>':''}
          <th style="text-align:right">Debe</th><th style="text-align:right">Haber</th>
        </tr></thead>
        <tbody>${lineas.map(l => `<tr>
          <td><div class="td-mono" style="font-weight:600;font-size:12px">${l.cuenta_codigo||'—'}</div>
              <div style="font-size:11px;color:var(--text3)">${l.cuenta_nombre||''}</div></td>
          <td style="font-size:12px;color:var(--text2)">${l.descripcion||'—'}</td>
          ${esUSD?`<td class="td-mono" style="text-align:right;color:var(--text3);font-size:12px">${l.moneda_orig||''} ${fmtNum(l.monto_orig)}</td>`:''}
          <td class="td-mono" style="text-align:right">${Number(l.debe||0)?fmtGTQ(l.debe):''}</td>
          <td class="td-mono" style="text-align:right">${Number(l.haber||0)?fmtGTQ(l.haber):''}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr style="border-top:2px solid var(--border);font-weight:700">
          <td colspan="${esUSD?3:2}" style="text-align:right;padding-right:12px">Totales</td>
          <td class="td-mono" style="text-align:right;color:var(--accent3)">${fmtGTQ(totDebe)}</td>
          <td class="td-mono" style="text-align:right;color:var(--accent3)">${fmtGTQ(totHaber)}</td>
        </tr></tfoot>
      </table>
    </div>
    <div style="margin-top:12px">
      ${cuadra
        ? '<span class="badge badge-green">✓ Cuadra</span>'
        : `<span class="badge badge-red">✗ Descuadrado por ${fmtGTQ(Math.abs(totDebe-totHaber))}</span>`}
      ${a.estado_tc==='pendiente_tc'?'<span class="badge badge-yellow" style="margin-left:6px">Pendiente de TC</span>':''}
    </div>`;

  // El pie solo lleva Imprimir. El acceso al documento origen se hace
  // haciendo clic sobre la referencia en la cabecera, no con un botón aparte.
  document.getElementById('asiento-detail-footer-actions').innerHTML =
    `<button class="btn btn-ghost btn-sm" onclick="imprimirAsiento('${a.id}')">🖨 Imprimir</button>`;

  openModal('modal-asiento-detail');
}

function closeAsientoDetail() { closeModal('modal-asiento-detail'); }

function imprimirAsiento(id) {
  const a = (state.asientos||[]).find(x => x.id === id);
  if (!a) return;
  const lineas   = (state.asientoLineas||[]).filter(l => l.asiento_id === a.id);
  const totDebe  = lineas.reduce((s,l) => s + Number(l.debe||0), 0);
  const totHaber = lineas.reduce((s,l) => s + Number(l.haber||0), 0);
  const esUSD    = a.moneda === 'USD';

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
    <title>${a.numero}</title>
    <style>
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:32px;color:#1a1a1a;font-size:12px}
      h1{font-size:18px;margin:0 0 2px}
      .sub{color:#666;font-size:12px;margin-bottom:18px}
      .meta{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}
      .meta div span{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#888;font-weight:700}
      .meta div strong{font-size:12px}
      table{width:100%;border-collapse:collapse;margin-top:8px}
      th,td{padding:7px 8px;border-bottom:1px solid #e5e5e5;text-align:left}
      th{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#666;border-bottom:1.5px solid #999}
      .r{text-align:right}
      .mono{font-family:'DM Mono',Menlo,Consolas,monospace}
      tfoot td{font-weight:700;border-top:2px solid #999;border-bottom:none}
      .desc{color:#666;font-size:11px}
      .foot{margin-top:22px;font-size:10px;color:#888;border-top:1px solid #e5e5e5;padding-top:8px}
    </style></head><body>
    <h1>${a.numero}</h1>
    <div class="sub">${DIARIO_LABEL[a.diario]||a.diario} · ${fmtDate(a.fecha)}</div>
    <div class="meta">
      <div><span>Referencia</span><strong class="mono">${a.referencia||'—'}</strong></div>
      <div><span>Moneda</span><strong>${a.moneda||'GTQ'}</strong></div>
      <div><span>Tipo de Cambio</span><strong>${esUSD?Number(a.tipo_cambio||0).toFixed(4):'—'}</strong></div>
      <div><span>Estado</span><strong>${a.estado_tc==='pendiente_tc'?'Pendiente de TC':'Aplicado'}</strong></div>
    </div>
    <div><span style="font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#888;font-weight:700">Descripción</span><br/>${a.descripcion||'—'}</div>
    <table>
      <thead><tr><th>Cuenta</th><th>Descripción</th>${esUSD?'<th class="r">Monto Orig.</th>':''}<th class="r">Debe</th><th class="r">Haber</th></tr></thead>
      <tbody>${lineas.map(l=>`<tr>
        <td><strong class="mono">${l.cuenta_codigo||'—'}</strong><br/><span class="desc">${l.cuenta_nombre||''}</span></td>
        <td class="desc">${l.descripcion||'—'}</td>
        ${esUSD?`<td class="r mono desc">${l.moneda_orig||''} ${fmtNum(l.monto_orig)}</td>`:''}
        <td class="r mono">${Number(l.debe||0)?fmtGTQ(l.debe):''}</td>
        <td class="r mono">${Number(l.haber||0)?fmtGTQ(l.haber):''}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="${esUSD?3:2}" class="r">Totales</td>
        <td class="r mono">${fmtGTQ(totDebe)}</td><td class="r mono">${fmtGTQ(totHaber)}</td></tr></tfoot>
    </table>
    <div class="foot">Impreso el ${fmtDate(today())}${Math.abs(totDebe-totHaber)>=0.01?' · ATENCIÓN: asiento descuadrado':''}</div>
    <script>window.onload=()=>window.print();<\/script>
    </body></html>`;

  const w = window.open('', '_blank');
  if (!w) { toast('El navegador bloqueó la ventana de impresión','error'); return; }
  w.document.write(html); w.document.close();
}

// Imprime exactamente lo que está filtrado/visible en pantalla — reusa
// los mismos 3 filtros (búsqueda, diario, mes) que renderDiarioGeneral(),
// para que el reporte impreso siempre coincida con lo que el usuario ve.
function imprimirDiarioGeneral() {
  const q   = (document.getElementById('search-dg')?.value||'').toLowerCase();
  const dj  = document.getElementById('filter-dg-diario')?.value||'';
  const mes = document.getElementById('filter-dg-mes')?.value||'';

  let asientos = [...state.asientos].sort((a,b) => {
    const dc = (a.fecha||'').localeCompare(b.fecha||'');
    return dc !== 0 ? dc : (a.numero||'').localeCompare(b.numero||'');
  });
  asientos = asientos.filter(a =>
    (!dj  || a.diario === dj) &&
    (!mes || (a.fecha||'').startsWith(mes))
  );

  let rows = [];
  asientos.forEach(a => {
    const lineas = (state.asientoLineas||[]).filter(l => l.asiento_id === a.id);
    lineas.forEach(l => {
      if (q && !(
        (a.numero||'').toLowerCase().includes(q) ||
        (a.descripcion||'').toLowerCase().includes(q) ||
        (a.referencia||'').toLowerCase().includes(q) ||
        (l.cuenta_codigo||'').toLowerCase().includes(q) ||
        (l.cuenta_nombre||'').toLowerCase().includes(q) ||
        (l.descripcion||'').toLowerCase().includes(q)
      )) return;
      rows.push({ a, l });
    });
  });

  if (!rows.length) { toast('No hay movimientos para imprimir con los filtros actuales','error'); return; }

  let sumDebe = 0, sumHaber = 0;
  let lastAsientoId = null;
  const bodyRows = rows.map(({ a, l }) => {
    const debeGTQ    = Number(l.debe_gtq||l.debe||0);
    const haberGTQ   = Number(l.haber_gtq||l.haber||0);
    const montoOrig  = Number(l.monto_orig||0);
    const monedaOrig = l.moneda_orig || a.moneda || 'GTQ';
    sumDebe  += debeGTQ;
    sumHaber += haberGTQ;
    const nuevoAsiento = a.id !== lastAsientoId;
    lastAsientoId = a.id;
    return `<tr style="${nuevoAsiento?'border-top:1.5px solid #E2E4E9':''}">
      <td class="mono">${nuevoAsiento?(a.numero||'—'):''}</td>
      <td>${nuevoAsiento?fmtDate(a.fecha):''}</td>
      <td>${nuevoAsiento?(DIARIO_LABEL[a.diario]||a.diario):''}</td>
      <td>${nuevoAsiento?(a.descripcion||'—'):''}</td>
      <td class="mono">${l.cuenta_codigo||'—'}</td>
      <td>${l.cuenta_nombre||'—'}${l.descripcion?`<div class="sub">${l.descripcion}</div>`:''}</td>
      <td class="mono">${montoOrig>0?fmtMoney(montoOrig,monedaOrig):'—'}</td>
      <td class="num">${debeGTQ>0?fmtGTQ(debeGTQ):''}</td>
      <td class="num">${haberGTQ>0?fmtGTQ(haberGTQ):''}</td>
    </tr>`;
  }).join('');

  const filtrosTxt = [
    dj ? `Diario: ${DIARIO_LABEL[dj]||dj}` : null,
    mes ? `Mes: ${mes}` : null,
    q ? `Búsqueda: "${q}"` : null,
  ].filter(Boolean).join(' · ') || 'Todos los movimientos';

  const win = window.open('','_blank','width=1100,height=750');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8"/>
    <title>Diario Mayor General</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Inter',sans-serif;font-size:11px;color:#1A1C21;padding:28px;background:#fff}
      .doc-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;padding-bottom:16px;border-bottom:2px solid #101820}
      .brand{font-size:11px;color:#5E6470;margin-top:4px}
      .doc-fecha{font-size:11px;color:#5E6470;text-align:right;margin-top:4px}
      .filtros{font-size:11px;color:#5E6470;margin:12px 0 16px}
      table{width:100%;border-collapse:collapse;margin-bottom:12px}
      thead th{background:#F4F5F7;padding:6px 8px;text-align:left;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#5E6470;border-bottom:1px solid #E2E4E9}
      tbody td{padding:5px 8px;border-bottom:1px solid #F0F1F3;font-size:10.5px;vertical-align:top}
      .mono{font-family:monospace}
      .num{text-align:right;font-family:monospace}
      .sub{font-size:9px;color:#9EA4B0}
      tfoot td{padding:8px;font-size:11px;font-weight:700;border-top:2px solid #101820}
      @media print{body{padding:14px} @page{margin:10mm;size:landscape}}
    </style>
  </head><body>
    <div class="doc-header">
      <div>
        <h1 style="font-size:18px;font-weight:700">Diario Mayor General</h1>
        <div class="brand">TEXTILES CIRCULARES, S.A.</div>
      </div>
      <div class="doc-fecha">Generado: ${fmtDate(today())}</div>
    </div>
    <div class="filtros">${filtrosTxt}</div>
    <table>
      <thead><tr>
        <th>No. Asiento</th><th>Fecha</th><th>Diario</th><th>Descripción</th>
        <th>Cuenta</th><th>Descripción Cuenta</th><th>Monto Orig.</th>
        <th style="text-align:right">Debe (GTQ)</th><th style="text-align:right">Haber (GTQ)</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot><tr>
        <td colspan="7">TOTALES — ${rows.length} línea${rows.length!==1?'s':''} (${asientos.length} asiento${asientos.length!==1?'s':''})</td>
        <td class="num">${fmtGTQ(sumDebe)}</td>
        <td class="num">${fmtGTQ(sumHaber)}</td>
      </tr></tfoot>
    </table>
    <scr` + `ipt>window.onload=()=>window.print();</scr` + `ipt>
  </body></html>`);
  win.document.close();
}

// ──────────────────────────────────────────────────
// ASIENTO MANUAL — CRUD
// ──────────────────────────────────────────────────
let asiLineCount = 0;

function addAsiLine(cta_id='', debe=0, haber=0, desc='') {
  asiLineCount++;
  const id = 'asil_'+asiLineCount;
  const opts = state.nomenclatura.map(n =>
    `<option value="${n.id}" data-codigo="${n.codigo}">${n.codigo} — ${n.nombre}</option>`
  ).join('');
  const tr = document.createElement('tr'); tr.id = id;
  tr.innerHTML = `
    <td><select style="width:100%;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-size:12px">
      <option value="">— Cuenta —</option>${opts}</select></td>
    <td><input type="text" value="${desc}" placeholder="Descripción" style="width:100%;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-size:12px"/></td>
    <td><input type="number" step="0.01" min="0" value="${debe||''}" placeholder="0.00" oninput="calcAsiTotals()" style="width:90px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px"/></td>
    <td><input type="number" step="0.01" min="0" value="${haber||''}" placeholder="0.00" oninput="calcAsiTotals()" style="width:90px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px"/></td>
    <td><button class="btn btn-sm btn-danger" onclick="document.getElementById('${id}').remove();calcAsiTotals()">✕</button></td>`;
  document.getElementById('asi-lines').appendChild(tr);
  if (cta_id) tr.querySelector('select').value = cta_id;
  calcAsiTotals();
}

function calcAsiTotals() {
  let d = 0, h = 0;
  document.querySelectorAll('#asi-lines tr').forEach(tr => {
    const inputs = tr.querySelectorAll('input[type=number]');
    if (inputs.length < 2) return;
    d += Number(inputs[0].value||0);
    h += Number(inputs[1].value||0);
  });
  document.getElementById('asi-total-debe').textContent  = d.toFixed(2);
  document.getElementById('asi-total-haber').textContent = h.toFixed(2);
  const diff = Math.abs(d-h);
  const msg  = document.getElementById('asi-balance-msg');
  if (diff < 0.01) { msg.innerHTML = '<span style="color:var(--green)">✓ Asiento cuadrado</span>'; }
  else { msg.innerHTML = `<span style="color:var(--red)">⚠ Diferencia: ${fmtMoney(diff)}</span>`; }
}

function getAsiLines() {
  const lines = [];
  document.querySelectorAll('#asi-lines tr').forEach(tr => {
    const sel    = tr.querySelector('select');
    const inputs = tr.querySelectorAll('input');
    if (!sel?.value) return;
    const cta = state.nomenclatura.find(n => n.id === sel.value);
    lines.push({
      cuenta_id:     sel.value,
      cuenta_codigo: cta?.codigo||'',
      cuenta_nombre: cta?.nombre||'',
      descripcion:   inputs[0]?.value||'',
      debe:  parseFloat(inputs[1]?.value)||0,
      haber: parseFloat(inputs[2]?.value)||0,
    });
  });
  return lines;
}

async function openNuevoAsiento() {
  document.getElementById('asi-id').value        = '';
  document.getElementById('asi-numero').value    = await nextAsientoNum();
  document.getElementById('asi-fecha').value     = today();
  document.getElementById('asi-diario').value    = 'GENERAL';
  document.getElementById('asi-moneda').value    = 'GTQ';
  document.getElementById('asi-descripcion').value = '';
  document.getElementById('asi-tipo-cambio').value = '';
  document.getElementById('asi-tc-field').style.display = 'none';
  document.getElementById('asi-lines').innerHTML = '';
  asiLineCount = 0;
  document.getElementById('modal-asiento-title').textContent = 'Nuevo Asiento Manual';
  addAsiLine(); addAsiLine();
  document.getElementById('asi-moneda').onchange = () => {
    const isDual = document.getElementById('asi-moneda').value === 'USD';
    document.getElementById('asi-tc-field').style.display = isDual ? 'block' : 'none';
  };
  openModal('modal-asiento');
}

function editAsiento(id) {
  const a = state.asientos.find(x => x.id === id);
  if (!a || a.auto) return;
  document.getElementById('asi-id').value          = a.id;
  document.getElementById('asi-numero').value      = a.numero||'';
  document.getElementById('asi-fecha').value       = fmtDate(a.fecha);
  document.getElementById('asi-diario').value      = a.diario||'GENERAL';
  document.getElementById('asi-moneda').value      = a.moneda||'GTQ';
  document.getElementById('asi-descripcion').value = a.descripcion||'';
  document.getElementById('asi-tipo-cambio').value = a.tipo_cambio||'';
  document.getElementById('asi-tc-field').style.display = a.moneda==='USD'?'block':'none';
  document.getElementById('asi-lines').innerHTML = '';
  asiLineCount = 0;
  state.asientoLineas.filter(l=>l.asiento_id===id).forEach(l =>
    addAsiLine(l.cuenta_id, l.debe, l.haber, l.descripcion)
  );
  document.getElementById('modal-asiento-title').textContent = 'Editar Asiento';
  openModal('modal-asiento');
}

async function saveAsiento(estado='publicado') {
  const id = document.getElementById('asi-id').value;
  const fecha       = document.getElementById('asi-fecha').value;
  const descripcion = document.getElementById('asi-descripcion').value.trim();
  if (!fecha || !descripcion) { toast('Fecha y descripción son requeridos','error'); return; }
  const lineas = getAsiLines();
  if (lineas.length < 2) { toast('Agrega al menos 2 líneas','error'); return; }
  const debe_total  = lineas.reduce((s,l)=>s+l.debe, 0);
  const haber_total = lineas.reduce((s,l)=>s+l.haber, 0);
  if (estado === 'publicado' && Math.abs(debe_total-haber_total) > 0.01) {
    toast('El asiento no está cuadrado (Debe ≠ Haber)','error'); return;
  }
  const row = {
    numero: document.getElementById('asi-numero').value,
    fecha, descripcion, estado,
    diario:       document.getElementById('asi-diario').value,
    moneda:       document.getElementById('asi-moneda').value,
    tipo_cambio:  parseFloat(document.getElementById('asi-tipo-cambio').value)||1,
    debe_total, haber_total, auto: false,
  };
  let asientoId = id, err;
  if (id) {
    ({error:err} = await sb.from('erp_asientos').update(row).eq('id',id));
    if (!err) await sb.from('erp_asiento_lineas').delete().eq('asiento_id',id);
  } else {
    const {data,error} = await sb.from('erp_asientos').insert(row).select().single();
    if (error) { toast('Error: '+error.message,'error'); return; }
    asientoId = data.id;
  }
  if (err) { toast('Error: '+err.message,'error'); return; }
  await sb.from('erp_asiento_lineas').insert(lineas.map(l=>({...l, asiento_id:asientoId})));
  toast(estado==='publicado'?'Asiento publicado':'Borrador guardado');
  closeModal('modal-asiento');
  await loadAll();
}

async function publicarAsiento(id) {
  await sb.from('erp_asientos').update({estado:'publicado'}).eq('id',id);
  await loadAll();
  toast('Asiento publicado');
}

async function deleteAsiento(id) {
  if (!confirm('¿Eliminar este asiento contable?')) return;
  await sb.from('erp_asiento_lineas').delete().eq('asiento_id',id);
  await sb.from('erp_asientos').delete().eq('id',id);
  await loadAll();
  toast('Asiento eliminado');
}

// ──────────────────────────────────────────────────
// ESTADO DE RESULTADOS
// ──────────────────────────────────────────────────
function renderEstadoResultados() {
  const periodo = document.getElementById('er-periodo')?.value||'mes';
  const isPers  = periodo === 'personalizado';
  document.getElementById('er-desde').style.display = isPers?'':'none';
  document.getElementById('er-hasta').style.display = isPers?'':'none';

  let desde, hasta;
  if (isPers) {
    desde = document.getElementById('er-desde').value;
    hasta = document.getElementById('er-hasta').value;
    if (!desde||!hasta) return;
  } else {
    ({desde, hasta} = periodoFechas(periodo));
  }

  // Filter published asientos in period
  const asientos = state.asientos.filter(a =>
    a.estado==='publicado' && a.fecha>=desde && a.fecha<=hasta
  );
  const asientoIds = new Set(asientos.map(a=>a.id));
  const lineas = state.asientoLineas.filter(l => asientoIds.has(l.asiento_id));

  // Aggregate by cuenta tipo
  const byTipo = {};
  lineas.forEach(l => {
    const cta = state.nomenclatura.find(n=>n.id===l.cuenta_id);
    if (!cta) return;
    if (!byTipo[cta.tipo]) byTipo[cta.tipo] = {};
    const key = cta.id;
    if (!byTipo[cta.tipo][key]) byTipo[cta.tipo][key] = {codigo:cta.codigo, nombre:cta.nombre, debe:0, haber:0, net:0};
    byTipo[cta.tipo][key].debe  += Number(l.debe_gtq||l.debe||0);
    byTipo[cta.tipo][key].haber += Number(l.haber_gtq||l.haber||0);
    byTipo[cta.tipo][key].net   += Number(l.haber_gtq||l.haber||0)-Number(l.debe_gtq||l.debe||0);
  });

  const seccion = (tipos, titulo, esIngreso) => {
    let total = 0;
    let rows = '';
    tipos.forEach(tipo => {
      const cuentas = byTipo[tipo]||{};
      Object.values(cuentas).sort((a,b)=>(a.codigo||'').localeCompare(b.codigo||'')).forEach(v => {
        const val = esIngreso ? v.haber-v.debe : v.debe-v.haber;
        if (Math.abs(val)<0.01) return;
        total += val;
        rows += `<tr><td style="padding:6px 24px;font-size:13px">
            <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--text3);margin-right:8px">${v.codigo||''}</span>${v.nombre}
          </td>
          <td style="text-align:right;font-family:'DM Mono',monospace;padding:6px 16px">${fmtGTQ(val)}</td></tr>`;
      });
    });
    if (!rows) return {html:'', total:0};
    return {
      html:`<tr style="background:var(--surface2)"><td colspan="2" style="padding:10px 16px;font-weight:700;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:var(--text2)">${titulo}</td></tr>
      ${rows}
      <tr style="border-top:2px solid var(--border)"><td style="padding:8px 16px;font-weight:600">Total ${titulo}</td>
        <td style="text-align:right;font-family:'DM Mono',monospace;font-weight:700;padding:8px 16px;color:${total>=0?'var(--green)':'var(--red)'}">${fmtGTQ(total)}</td></tr>`,
      total
    };
  };

  const ingresos  = seccion(['Ingreso','Otro Ingreso'], 'Ingresos', true);
  const costos    = seccion(['Costo de ingresos'], 'Costo de Ingresos', false);
  const gastos    = seccion(['Gastos'], 'Gastos', false);
  const utilBruta = ingresos.total - costos.total;
  const utilNeta  = utilBruta - gastos.total;
  const periodoLabel = `${desde} al ${hasta}`;

  document.getElementById('er-report').innerHTML = `
    <div style="text-align:center;margin-bottom:28px">
      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em">MTG Textiles</div>
      <div style="font-size:20px;font-weight:700;margin:4px 0">Estado de Resultados</div>
      <div style="font-size:12px;color:var(--text2)">${periodoLabel}</div>
    </div>
    <table style="width:100%;border-collapse:collapse">
      ${ingresos.html}
      <tr><td colspan="2" style="padding:8px 0"></td></tr>
      ${costos.html}
      <tr style="border-top:2px solid var(--text);background:var(--bg)">
        <td style="padding:12px 16px;font-weight:700;font-size:15px">UTILIDAD BRUTA</td>
        <td style="text-align:right;font-family:'DM Mono',monospace;font-weight:700;font-size:15px;padding:12px 16px;color:${utilBruta>=0?'var(--green)':'var(--red)'}">${fmtGTQ(utilBruta)}</td>
      </tr>
      <tr><td colspan="2" style="padding:8px 0"></td></tr>
      ${gastos.html}
      <tr style="border-top:3px solid var(--text);background:var(--accent2)">
        <td style="padding:14px 16px;font-weight:700;font-size:16px">UTILIDAD NETA</td>
        <td style="text-align:right;font-family:'DM Mono',monospace;font-weight:700;font-size:16px;padding:14px 16px;color:${utilNeta>=0?'var(--green)':'var(--red)'}">${fmtGTQ(utilNeta)}</td>
      </tr>
    </table>`;
}

// ──────────────────────────────────────────────────
// BALANCE GENERAL
// ──────────────────────────────────────────────────
function renderBalanceGeneral() {
  const fechaEl = document.getElementById('bg-fecha');
  if (!fechaEl.value) fechaEl.value = today();
  const hasta = fechaEl.value;

  const asientos = state.asientos.filter(a => a.estado==='publicado' && a.fecha<=hasta);
  const asientoIds = new Set(asientos.map(a=>a.id));
  const lineas = state.asientoLineas.filter(l => asientoIds.has(l.asiento_id));

  // Saldo por cuenta (haber - debe para cuentas de crédito, debe - haber para débito)
  const saldos = {};
  lineas.forEach(l => {
    const cta = state.nomenclatura.find(n=>n.id===l.cuenta_id);
    if (!cta) return;
    if (!saldos[cta.id]) saldos[cta.id] = {cta, debe:0, haber:0};
    saldos[cta.id].debe  += Number(l.debe_gtq||l.debe||0);
    saldos[cta.id].haber += Number(l.haber_gtq||l.haber||0);
  });

  const grupoActivo   = ['Activos Circulantes','Activos no-circulantes','Banco y efectivo','Por cobrar'];
  const grupoPasivo   = ['Pasivos Circulantes','Pasivos no-circulantes','Por pagar'];
  const grupoCapital  = ['Capital','Ganancias del año actual'];
  const grupoIngresos = ['Ingresos','Ventas'];
  const grupoGastos   = ['Gastos','Costo de Ventas','Costos'];

  // Calculate Resultado del Ejercicio = Ingresos - Gastos
  let totalIngresos = 0, totalGastos = 0;
  Object.values(saldos).forEach(({cta,debe,haber}) => {
    if (grupoIngresos.some(g => (cta.tipo||'').toLowerCase().includes(g.toLowerCase()))) {
      totalIngresos += haber - debe; // ingresos: saldo crédito
    }
    if (grupoGastos.some(g => (cta.tipo||'').toLowerCase().includes(g.toLowerCase()))) {
      totalGastos += debe - haber; // gastos: saldo débito
    }
  });
  const resultadoEjercicio = totalIngresos - totalGastos;

  const seccionBG = (grupos, titulo) => {
    let total = 0, rows = '';
    Object.values(saldos)
      .sort((a,b)=>(a.cta.codigo||'').localeCompare(b.cta.codigo||''))
      .forEach(({cta,debe,haber}) => {
        if (!grupos.includes(cta.tipo)) return;
        const isActivo = grupos === grupoActivo;
        const saldo = isActivo ? debe-haber : haber-debe;
        if (Math.abs(saldo)<0.01) return;
        total += saldo;
        rows += `<tr><td style="padding:5px 24px;font-size:13px">
            <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--text3);margin-right:8px">${cta.codigo||''}</span>${cta.nombre}
          </td>
          <td style="text-align:right;font-family:'DM Mono',monospace;padding:5px 16px">${fmtGTQ(saldo)}</td></tr>`;
      });
    if (!rows) rows = '<tr><td colspan="2" style="padding:6px 24px;color:var(--text3);font-size:12px">Sin movimientos</td></tr>';
    return {
      html:`<tr style="background:var(--surface2)"><td colspan="2" style="padding:10px 16px;font-weight:700;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:var(--text2)">${titulo}</td></tr>
      ${rows}
      <tr style="border-top:2px solid var(--border)"><td style="padding:8px 16px;font-weight:600">Total ${titulo}</td>
        <td style="text-align:right;font-family:'DM Mono',monospace;font-weight:700;padding:8px 16px">${fmtGTQ(total)}</td></tr>`,
      total
    };
  };

  const activos  = seccionBG(grupoActivo, 'Activos');
  const pasivos  = seccionBG(grupoPasivo, 'Pasivos');
  const capital  = seccionBG(grupoCapital,'Capital');

  // Add Resultado del Ejercicio to capital section
  const resultadoRow = Math.abs(resultadoEjercicio) > 0.01 ? `
    <tr style="background:${resultadoEjercicio>=0?'#F0FDF4':'#FFF1F2'}">
      <td style="padding:5px 24px;font-size:13px;font-weight:600;color:${resultadoEjercicio>=0?'var(--green)':'var(--red)'}">
        Resultado del Ejercicio ${resultadoEjercicio>=0?'(Utilidad)':'(Pérdida)'}
      </td>
      <td style="text-align:right;font-family:'DM Mono',monospace;padding:5px 16px;font-weight:700;color:${resultadoEjercicio>=0?'var(--green)':'var(--red)'}">
        ${fmtGTQ(resultadoEjercicio)}
      </td>
    </tr>` : '';

  const capitalTotal = capital.total + resultadoEjercicio;
  const capitalHtml  = capital.html.replace(
    `<tr style="border-top:2px solid var(--border)"><td style="padding:8px 16px;font-weight:600">Total Capital</td>`,
    `${resultadoRow}<tr style="border-top:2px solid var(--border)"><td style="padding:8px 16px;font-weight:600">Total Capital</td>`
  ).replace(
    `<td style="text-align:right;font-family:'DM Mono',monospace;font-weight:700;padding:8px 16px">${fmtGTQ(capital.total)}</td></tr>`,
    `<td style="text-align:right;font-family:'DM Mono',monospace;font-weight:700;padding:8px 16px">${fmtGTQ(capitalTotal)}</td></tr>`
  );

  const totalPasCap = pasivos.total + capitalTotal;
  const diff = activos.total - totalPasCap;

  document.getElementById('bg-report').innerHTML = `
    <div style="text-align:center;margin-bottom:28px">
      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em">MTG Textiles</div>
      <div style="font-size:20px;font-weight:700;margin:4px 0">Balance General</div>
      <div style="font-size:12px;color:var(--text2)">Al ${hasta}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
      <table style="width:100%;border-collapse:collapse">
        ${activos.html}
      </table>
      <table style="width:100%;border-collapse:collapse">
        ${pasivos.html}
        <tr><td colspan="2" style="padding:8px 0"></td></tr>
        ${capitalHtml}
        <tr style="border-top:3px solid var(--text)">
          <td style="padding:10px 16px;font-weight:700">Total Pasivos + Capital</td>
          <td style="text-align:right;font-family:'DM Mono',monospace;font-weight:700;padding:10px 16px">${fmtGTQ(totalPasCap)}</td>
        </tr>
      </table>
    </div>
    ${Math.abs(diff)>0.01?`<div style="margin-top:16px;padding:12px 16px;background:var(--red-bg);border-radius:8px;color:var(--red);font-size:13px">⚠ Diferencia de balance: ${fmtGTQ(Math.abs(diff))} — revisar asientos</div>`:'<div style="margin-top:16px;padding:12px 16px;background:var(--green-bg);border-radius:8px;color:var(--green);font-size:13px">✓ Balance cuadrado</div>'}`;
}

// ──────────────────────────────────────────────────
// FLUJO DE CAJA — GRÁFICO PROYECTADO (por fecha de vencimiento de facturas)
// ──────────────────────────────────────────────────
// A diferencia de renderFlujoCaja() (que muestra caja REAL: pagos ya
// recibidos/realizados), este gráfico proyecta cuándo se DEBEN cancelar los
// documentos ya emitidos — facturas de venta (ingresos) y facturas de
// compra a proveedor (egresos) — según su fecha de vencimiento.
// Para egresos: se excluye toda factura de compra con
// erp_oc_facturas.estado_pago === 'pagado' (ya no representa una salida de
// caja futura). Todo lo demás (pendiente, parcial, o sin estado_pago aún)
// sí se proyecta, por el saldo pendiente (total - monto_pagado).
//
// Dos controles independientes:
// - Plazo (fc-periodo): rango de fechas mostrado (mes/trimestre/año actual).
// - Intervalo (fc-intervalo): granularidad del eje X dentro de ese rango
//   (día/mes/año) — permite, por ejemplo, ver el Plazo "Este Año" agrupado
//   por mes, o el Plazo "Este Mes" con el detalle día a día.
let fcChartInstance = null;

// diasCreditoVenta() vive ahora en js/helpers-calculo.js

// Fecha de vencimiento de una factura de venta = fecha de emisión + días de crédito.
// facturaVentaVencimiento() vive ahora en js/helpers-calculo.js

// Reduce una fecha exacta (yyyy-mm-dd) al bucket del eje X según el
// intervalo elegido: día = la fecha tal cual, mes = yyyy-mm, año = yyyy.
// fcBucketKey() vive ahora en js/helpers-calculo.js

// fcBucketLabel() vive ahora en js/helpers-calculo.js

// Junta cada factura (ingreso o egreso) como un ítem individual, agrupado
// por bucket de tiempo — a propósito NO suma los montos de antemano: cada
// factura debe quedar identificable por separado para dibujarse como su
// propio segmento dentro de la columna apilada (stacked column).
function computeFlujoCajaItems(desde, hasta, intervalo) {
  const porBucket = {};
  const addItem = (fecha, campo, monto, id) => {
    if (!fecha || fecha < desde || fecha > hasta) return;
    const key = fcBucketKey(fecha, intervalo);
    if (!porBucket[key]) porBucket[key] = { ingresos: [], egresos: [] };
    porBucket[key][campo].push({ id: id || '—', monto: Number(monto || 0) });
  };

  (state.facturas || []).filter(f => f.status !== 'cancelada').forEach(f => {
    addItem(facturaVentaVencimiento(f), 'ingresos', f.total, f.num_interno || f.numero || f.id);
  });

  // Facturas de compra pendientes de pago — fuente: erp_oc_facturas.
  // Identificador: num_interno. Fecha: fecha_vencimiento. Monto: saldo
  // pendiente (total - monto_pagado).
  (state.ocFacturas || [])
    .filter(f => f.status !== 'cancelada' && f.estado_pago !== 'pagado')
    .forEach(f => {
      const venc  = f.fecha_vencimiento || f.fecha;
      const saldo = Math.max(0, Number(f.total || 0) - Number(f.monto_pagado || 0));
      if (saldo <= 0) return;
      const monedaOC = getMonedaOC(f.oc_id);
      const saldoGTQ = monedaOC === 'GTQ'
        ? saldo
        : saldo * (Number(f.tc) || getTCFecha(f.fecha) || 1);
      addItem(venc, 'egresos', saldoGTQ, f.num_interno || `${f.serie||''}${f.numero||''}`);
    });

  const buckets = Object.keys(porBucket).sort();
  let balance = 0;
  const dataBalance = [];
  buckets.forEach(key => {
    const v = porBucket[key];
    const totIng = v.ingresos.reduce((s, i) => s + i.monto, 0);
    const totEgr = v.egresos.reduce((s, i) => s + i.monto, 0);
    balance += (totIng - totEgr);
    dataBalance.push(balance);
  });

  return { buckets, porBucket, dataBalance };
}

// Paletas para diferenciar cada factura individual dentro de su columna
// apilada, manteniendo la familia de color (verde=ingreso, rojo=egreso).
// FC_GREENS, FC_REDS viven ahora en js/constantes.js

function renderFlujoCajaChart() {
  const canvas = document.getElementById('fc-chart-canvas');
  const emptyEl = document.getElementById('fc-chart-empty');
  if (!canvas) return;

  const periodo   = document.getElementById('fc-periodo')?.value   || 'mes';
  const intervalo = document.getElementById('fc-intervalo')?.value || 'dia';
  const { desde, hasta } = periodoFechas(periodo);
  const { buckets, porBucket, dataBalance } = computeFlujoCajaItems(desde, hasta, intervalo);

  if (fcChartInstance) { fcChartInstance.destroy(); fcChartInstance = null; }

  if (!buckets.length || typeof Chart === 'undefined') {
    canvas.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'flex';
    return;
  }
  canvas.style.display = '';
  if (emptyEl) emptyEl.style.display = 'none';

  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;

  // Cada factura se convierte en su propio dataset — Chart.js la dibuja
  // como un segmento propio dentro de la barra apilada (stack: 'ingresos'
  // o 'egresos'), en vez de un solo bloque agregado por fecha/mes/año.
  const ingresoIds = [], egresoIds = [];
  buckets.forEach(key => {
    porBucket[key].ingresos.forEach(it => { if (!ingresoIds.includes(it.id)) ingresoIds.push(it.id); });
    porBucket[key].egresos.forEach(it  => { if (!egresoIds.includes(it.id))  egresoIds.push(it.id); });
  });

  const datasetsIngresos = ingresoIds.map((id, idx) => ({
    type: 'bar', label: id, stack: 'ingresos', order: 2,
    backgroundColor: FC_GREENS[idx % FC_GREENS.length], borderRadius: 2,
    data: buckets.map(key => (porBucket[key].ingresos.find(x => x.id === id)?.monto) || 0),
  }));

  const datasetsEgresos = egresoIds.map((id, idx) => ({
    type: 'bar', label: id, stack: 'egresos', order: 2,
    backgroundColor: FC_REDS[idx % FC_REDS.length], borderRadius: 2,
    data: buckets.map(key => {
      const it = porBucket[key].egresos.find(x => x.id === id);
      return it ? -it.monto : 0;
    }),
  }));

  fcChartInstance = new Chart(ctx, {
    data: {
      labels: buckets.map(k => fcBucketLabel(k, intervalo)),
      datasets: [
        ...datasetsIngresos,
        ...datasetsEgresos,
        { type: 'line', label: 'Balance acumulado', data: dataBalance, borderColor: '#2563EB', backgroundColor: '#2563EB', pointRadius: 3, pointBackgroundColor: '#2563EB', tension: 0.25, fill: false, order: 1 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, ticks: { callback: v => fmtGTQ(v) }, grid: { color: '#E2E4E9' } },
      },
      plugins: {
        // Leyenda desactivada por completo — con una entrada por factura,
        // se sobrepobla rápido. La identificación de cada factura
        // (num_interno + monto) se ve en el tooltip al pasar el mouse.
        legend: { display: false },
        tooltip: {
          filter: item => Number(item.raw) !== 0,
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${fmtGTQ(Math.abs(ctx.raw))}`,
            footer: items => {
              const ing = items.filter(i => i.dataset.stack==='ingresos').reduce((s,i)=>s+Number(i.raw||0),0);
              const egr = items.filter(i => i.dataset.stack==='egresos').reduce((s,i)=>s+Math.abs(Number(i.raw||0)),0);
              const lines = [];
              if (ing) lines.push(`Total ingresos: ${fmtGTQ(ing)}`);
              if (egr) lines.push(`Total egresos: ${fmtGTQ(egr)}`);
              return lines;
            },
          },
        },
      },
    },
  });
}

// ──────────────────────────────────────────────────
// FLUJO DE CAJA
// ──────────────────────────────────────────────────
function renderFlujoCaja() {
  renderFlujoCajaChart();
  const periodo = document.getElementById('fc-periodo')?.value||'mes';
  const {desde, hasta} = periodoFechas(periodo);

  // Base caja: pagos reales recibidos y realizados.
  // Entradas = cobros de clientes (erp_pagos, state.pagos).
  // Salidas = pagos de facturas a proveedores (erp_pagos_oc, state.pagosOC)
  // + anticipos a proveedores (erp_oc_anticipos, state.ocAnticipos). Antes
  // solo se contaban los anticipos, así que el reporte se veía vacío para
  // cualquier período sin anticipos aunque sí hubiera pagos de facturas
  // reales — que son la salida de caja más común.
  const cobros    = state.pagos.filter(p => p.fecha>=desde && p.fecha<=hasta);
  const pagosProv = (state.pagosOC||[]).filter(p => p.fecha>=desde && p.fecha<=hasta);
  const anticipos = state.ocAnticipos.filter(a => a.fecha>=desde && a.fecha<=hasta);

  // Group by week
  const totalCobros   = cobros.reduce((s,p)=>s+Number(p.monto||0),0);
  const totalPagos    = pagosProv.reduce((s,p)=>s+Number(p.monto||0),0) + anticipos.reduce((s,a)=>s+Number(a.monto||0),0);
  const flujoNeto     = totalCobros - totalPagos;

  // Monthly breakdown from pagos
  const porMes = {};
  cobros.forEach(p => {
    const mes = (p.fecha||'').slice(0,7);
    if (!porMes[mes]) porMes[mes] = {cobros:0, pagos:0};
    porMes[mes].cobros += Number(p.monto||0);
  });
  pagosProv.forEach(p => {
    const mes = (p.fecha||'').slice(0,7);
    if (!porMes[mes]) porMes[mes] = {cobros:0, pagos:0};
    porMes[mes].pagos += Number(p.monto||0);
  });
  anticipos.forEach(a => {
    const mes = (a.fecha||'').slice(0,7);
    if (!porMes[mes]) porMes[mes] = {cobros:0, pagos:0};
    porMes[mes].pagos += Number(a.monto||0);
  });

  const filas = Object.entries(porMes).sort().map(([mes,v]) => {
    const neto = v.cobros-v.pagos;
    return `<tr>
      <td style="padding:8px 16px">${fmtMesAbrev(mes)}</td>
      <td class="td-mono" style="text-align:right;padding:8px 16px;color:var(--green)">${fmtGTQ(v.cobros)}</td>
      <td class="td-mono" style="text-align:right;padding:8px 16px;color:var(--red)">${fmtGTQ(v.pagos)}</td>
      <td class="td-mono" style="text-align:right;padding:8px 16px;font-weight:600;color:${neto>=0?'var(--green)':'var(--red)'}">${fmtGTQ(neto)}</td>
    </tr>`;
  }).join('');

  document.getElementById('fc-report').innerHTML = `
    <div style="text-align:center;margin-bottom:28px">
      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em">MTG Textiles</div>
      <div style="font-size:20px;font-weight:700;margin:4px 0">Flujo de Caja</div>
      <div style="font-size:12px;color:var(--text2)">${desde} al ${hasta}</div>
    </div>
    <!-- Resumen -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:24px">
      <div style="background:var(--green-bg);border-radius:10px;padding:16px;text-align:center">
        <div style="font-size:11px;color:var(--green);text-transform:uppercase;font-weight:600;letter-spacing:0.06em;margin-bottom:6px">Entradas</div>
        <div style="font-size:22px;font-weight:700;font-family:'DM Mono',monospace;color:var(--green)">${fmtGTQ(totalCobros)}</div>
      </div>
      <div style="background:var(--red-bg);border-radius:10px;padding:16px;text-align:center">
        <div style="font-size:11px;color:var(--red);text-transform:uppercase;font-weight:600;letter-spacing:0.06em;margin-bottom:6px">Salidas</div>
        <div style="font-size:22px;font-weight:700;font-family:'DM Mono',monospace;color:var(--red)">${fmtGTQ(totalPagos)}</div>
      </div>
      <div style="background:${flujoNeto>=0?'var(--green-bg)':'var(--red-bg)'};border-radius:10px;padding:16px;text-align:center">
        <div style="font-size:11px;color:${flujoNeto>=0?'var(--green)':'var(--red)'};text-transform:uppercase;font-weight:600;letter-spacing:0.06em;margin-bottom:6px">Flujo Neto</div>
        <div style="font-size:22px;font-weight:700;font-family:'DM Mono',monospace;color:${flujoNeto>=0?'var(--green)':'var(--red)'}">${fmtGTQ(flujoNeto)}</div>
      </div>
    </div>
    <!-- Detalle por mes -->
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:var(--surface2)">
        <th style="padding:10px 16px;text-align:left;font-size:12px">Período</th>
        <th style="padding:10px 16px;text-align:right;font-size:12px;color:var(--green)">Entradas</th>
        <th style="padding:10px 16px;text-align:right;font-size:12px;color:var(--red)">Salidas</th>
        <th style="padding:10px 16px;text-align:right;font-size:12px">Flujo Neto</th>
      </tr></thead>
      <tbody>${filas||'<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text3)">Sin movimientos en el período</td></tr>'}</tbody>
      <tfoot><tr style="background:var(--surface2);font-weight:600;border-top:2px solid var(--border)">
        <td style="padding:10px 16px">TOTAL</td>
        <td class="td-mono" style="text-align:right;padding:10px 16px;color:var(--green)">${fmtGTQ(totalCobros)}</td>
        <td class="td-mono" style="text-align:right;padding:10px 16px;color:var(--red)">${fmtGTQ(totalPagos)}</td>
        <td class="td-mono" style="text-align:right;padding:10px 16px;color:${flujoNeto>=0?'var(--green)':'var(--red)'}">${fmtGTQ(flujoNeto)}</td>
      </tfoot>
    </table>`;
}

// ──────────────────────────────────────────────────
// DIARIOS — CONFIG
// ──────────────────────────────────────────────────
function renderDiarios() {
  const q = (document.getElementById('search-diarios')?.value||'').toLowerCase();
  const data = state.diarios.filter(d =>
    (d.nombre||'').toLowerCase().includes(q) || (d.codigo||'').toLowerCase().includes(q)
  );
  const tbody = document.getElementById('tbl-diarios');
  if (!tbody) return;
  const TIPO_LABEL = {ventas:'Ventas',compras:'Compras',banco:'Banco/Efectivo',general:'General',inventario:'Inventario'};
  tbody.innerHTML = data.length ? data.map(d=>`<tr>
    <td class="td-mono" style="font-weight:600">${d.codigo}</td>
    <td style="font-weight:500">${d.nombre}</td>
    <td class="hide-mobile"><span class="badge badge-blue">${TIPO_LABEL[d.tipo]||d.tipo||'—'}</span></td>
    <td class="hide-mobile" style="font-size:12px">${d.moneda||'GTQ'}</td>
    <td>${statusBadge(d.activo!==false?'activo':'inactivo')}</td>
    <td><div class="td-actions">
      <button class="btn btn-sm btn-ghost" onclick="editDiario('${d.id}')">Editar</button>
      <button class="btn btn-sm btn-danger" onclick="deleteDiario('${d.id}')">Eliminar</button>
    </div></td>
  </tr>`).join('') :
  '<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">◈</div><p>Sin diarios configurados</p></div></td></tr>';

  // Update cat-diario-stock dropdowns
  const djSels = document.querySelectorAll('select[id^="cat-diario"]');
  if (djSels.length && state.diarios.length) {
    const opts = '<option value="">— Seleccionar diario —</option>' +
      state.diarios.filter(d=>d.activo!==false).map(d=>`<option value="${d.id}">${d.codigo} — ${d.nombre}</option>`).join('');
    djSels.forEach(sel => { const cur=sel.value; if(sel.tagName==='SELECT'){sel.innerHTML=opts;sel.value=cur;} });
  }
}

async function openNewDiario() {
  document.getElementById('dj-id').value     = '';
  document.getElementById('dj-codigo').value  = '';
  document.getElementById('dj-nombre').value  = '';
  document.getElementById('dj-tipo').value    = 'general';
  document.getElementById('dj-moneda').value  = 'GTQ';
  document.getElementById('dj-activo').value  = 'true';
  document.getElementById('dj-notas').value   = '';
  const nomOpts_ = '<option value="">— Seleccionar —</option>' +
    state.nomenclatura.map(n=>`<option value="${n.id}">${n.codigo} — ${n.nombre}</option>`).join('');
  document.getElementById('dj-cta-debito').innerHTML  = nomOpts_;
  document.getElementById('dj-cta-credito').innerHTML = nomOpts_;
  document.getElementById('modal-diario-title').textContent = 'Nuevo Diario';
  openModal('modal-diario');
}

async function editDiario(id) {
  const d = state.diarios.find(x=>x.id===id);
  document.getElementById('dj-id').value     = d.id;
  document.getElementById('dj-codigo').value  = d.codigo||'';
  document.getElementById('dj-nombre').value  = d.nombre||'';
  document.getElementById('dj-tipo').value    = d.tipo||'general';
  document.getElementById('dj-moneda').value  = d.moneda||'GTQ';
  document.getElementById('dj-activo').value  = String(d.activo!==false);
  document.getElementById('dj-notas').value   = d.notas||'';
  const nomOpts_ = '<option value="">— Seleccionar —</option>' +
    state.nomenclatura.map(n=>`<option value="${n.id}">${n.codigo} — ${n.nombre}</option>`).join('');
  document.getElementById('dj-cta-debito').innerHTML  = nomOpts_;
  document.getElementById('dj-cta-credito').innerHTML = nomOpts_;
  setTimeout(()=>{
    document.getElementById('dj-cta-debito').value  = d.cta_debito||'';
    document.getElementById('dj-cta-credito').value = d.cta_credito||'';
  },30);
  document.getElementById('modal-diario-title').textContent = 'Editar Diario';
  openModal('modal-diario');
}

async function saveDiario() {
  const id     = document.getElementById('dj-id').value;
  const codigo = document.getElementById('dj-codigo').value.trim();
  const nombre = document.getElementById('dj-nombre').value.trim();
  if (!codigo||!nombre) { toast('Código y nombre son requeridos','error'); return; }
  const row = {
    codigo, nombre,
    tipo:        document.getElementById('dj-tipo').value,
    moneda:      document.getElementById('dj-moneda').value,
    cta_debito:  document.getElementById('dj-cta-debito').value||null,
    cta_credito: document.getElementById('dj-cta-credito').value||null,
    activo:      document.getElementById('dj-activo').value==='true',
    notas:       document.getElementById('dj-notas').value.trim(),
  };
  let err;
  if (id) ({error:err}=await sb.from('erp_diarios').update(row).eq('id',id));
  else    ({error:err}=await sb.from('erp_diarios').insert(row));
  if (err) { toast('Error: '+err.message,'error'); return; }
  toast('Diario guardado');
  closeModal('modal-diario');
  await loadAll();
}

async function deleteDiario(id) {
  if (!confirm('¿Eliminar este diario?')) return;
  const {error}=await sb.from('erp_diarios').delete().eq('id',id);
  if (error) { toast('Error: '+error.message,'error'); return; }
  toast('Diario eliminado');
  await loadAll();
}

// ──────────────────────────────────────────────────
// HOOKS: conectar asientos automáticos a eventos
// ──────────────────────────────────────────────────

// NOTA (26/Ago/2026, Fase 5): aquí vivían cuatro variables _orig* que
// pretendían guardar la función original para hacer monkey-patching
// (_origSaveFactura, _origSaveFacturaOC, _origSaveAnticipo,
// _origCrearMovimiento). El parcheo nunca se implementó: las cuatro se
// declaraban y jamás se usaban. Se eliminaron al extraer este módulo —
// además, en el nuevo orden de carga habrían capturado null en silencio,
// porque este script corre antes que el principal donde viven esas
// funciones. Los asientos automáticos se disparan por llamada explícita
// (registrarPagoConAsiento, crearMovimientoConAsiento), no por parcheo.

// Hook en pago de venta — llamar después de registrar pago
async function registrarPagoConAsiento(facturaId, monto, cuentaId, fecha, forma, notas) {
  const {data:pago, error} = await sb.from('erp_pagos').insert({
    factura_id: facturaId, monto, cuenta_id: cuentaId, fecha, forma, notas
  }).select().single();
  if (error) { toast('Error: '+error.message,'error'); return false; }
  await loadAll();
  await asientoPagoVenta(pago.id);
  await loadAll();
  return true;
}

// Wrapper para crearMovimiento que también genera asiento
async function crearMovimientoConAsiento(params) {
  // Check category valoracion
  const prod = state.productos.find(p => p.id === params.producto_id);
  const cat  = prod?.categoria ? state.categorias?.find(c => c.id === prod.categoria) : null;
  const esManual = !cat || cat.valoracion === 'manual' || !cat.valoracion;

  const movId = await crearMovimiento(params);
  if (!movId) {
    throw new Error('crearMovimiento retornó null — revisar error de Supabase');
  }
  await loadAll();

  if (esManual) {
    // Manual: use cta_ingresos for entries, cta_gasto for exits
    await asientoMovInventarioManual(movId, cat, params.moneda || 'GTQ');
  } else {
    // Automatico: use stock accounts from category
    await asientoMovInventario(movId, params.moneda || 'GTQ');
  }
  return movId;
}

// ═══════════════════════════════════════════════════════════════════
// NOMENCLATURA CONTABLE Y TIPO DE CAMBIO
// ═══════════════════════════════════════════════════════════════════

// ═══ NOMENCLATURA CONTABLE ═══

// NOM_TIPO_COLOR vive ahora en js/constantes.js

function nomOpts(filterFn) {
  // Build <option> list from nomenclatura, optionally filtered
  const list = filterFn ? state.nomenclatura.filter(filterFn) : state.nomenclatura;
  return '<option value="">— Seleccionar cuenta —</option>' +
    list.map(n => `<option value="${n.id}">${n.codigo} — ${n.nombre}</option>`).join('');
}

function populateNomDropdowns() {
  // Populate all categoria selects that reference nomenclatura
  const allOpts = nomOpts();
  ['cat-cta-ingresos','cat-cta-gasto',
   'cat-cta-valoracion','cat-cta-entrada','cat-cta-salida'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.tagName === 'SELECT') {
      const cur = el.value;
      el.innerHTML = allOpts;
      el.value = cur;
    }
  });
  // Diario de stock is now a text field — handled separately when Diarios module is built
}

// Track which groups are open
const nomOpenGroups = new Set();

// Ordered group definitions
const NOM_GROUPS = [
  { key:'1-activo',    label:'1. Activos',                 prefix:['1'], tipos:['Activos Circulantes','Activos no-circulantes','Por cobrar','Banco y efectivo'] },
  { key:'2-pasivo',    label:'2. Pasivos',                 prefix:['2','3'], tipos:['Pasivos Circulantes','Pasivos no-circulantes','Por pagar'] },
  { key:'4-capital',   label:'3. Capital',                 prefix:['4'], tipos:['Capital','Ganancias del año actual'] },
  { key:'5-costo',     label:'4. Costo de Ingresos',       prefix:['5'], tipos:['Costo de ingresos'] },
  { key:'6-gastos',    label:'5. Gastos',                  prefix:['6'], tipos:['Gastos'] },
  { key:'7-ingresos',  label:'6. Ingresos',                prefix:['4','41','42'], tipos:['Ingreso','Otro Ingreso'] },
  { key:'9-otros',     label:'7. Otros',                   prefix:['9'], tipos:[] },
];

// Compute hierarchy depth from code length
// nomDepth() vive ahora en js/helpers-calculo.js

function renderNomenclatura() {
  const q = (document.getElementById('search-nomenclatura')?.value||'').toLowerCase();
  const container = document.getElementById('nom-tree');
  if (!container) return;

  // Filter accounts
  let data = state.nomenclatura.filter(n =>
    !q || (n.codigo||'').toLowerCase().includes(q) || (n.nombre||'').toLowerCase().includes(q)
  );
  // Sort by codigo
  data = [...data].sort((a,b) => (a.codigo||'').localeCompare(b.codigo||''));

  // If searching, open all groups
  if (q) data.forEach((_, i) => nomOpenGroups.add('search-all'));

  // Group accounts by type groups
  const grouped = {};
  NOM_GROUPS.forEach(g => { grouped[g.key] = []; });
  grouped['__otros__'] = [];

  data.forEach(n => {
    let placed = false;
    for (const g of NOM_GROUPS) {
      if (g.tipos.includes(n.tipo)) {
        grouped[g.key].push(n); placed = true; break;
      }
    }
    if (!placed) grouped['__otros__'].push(n);
  });

  const renderRow = (n) => {
    const depth = nomDepth(n.codigo);
    const indent = depth * 20;
    const mono = n.moneda ? `<span style="font-size:10px;color:var(--text3)">${n.moneda}</span>` : '';
    const conc = n.permite_conciliacion ? '<span style="font-size:10px;color:var(--green)">●</span>' : '';
    return `<div class="nom-row nom-depth-${Math.min(depth,3)}" style="padding-left:${18+indent}px">
      <div class="nom-code">${n.codigo}</div>
      <div class="nom-name">${n.nombre}</div>
      <div class="nom-meta">${mono} ${conc}</div>
      <div class="nom-actions">
        <button class="btn btn-sm btn-ghost" style="padding:3px 8px;font-size:11px" onclick="editNomenclatura('${n.id}')">Editar</button>
        <button class="btn btn-sm btn-danger" style="padding:3px 8px;font-size:11px" onclick="deleteNomenclatura('${n.id}')">✕</button>
      </div>
    </div>`;
  };

  let html = '';
  const allGroups = [...NOM_GROUPS, { key:'__otros__', label:'Otros', tipos:[] }];

  allGroups.forEach(g => {
    const accounts = grouped[g.key] || [];
    if (!accounts.length) return;
    const isOpen = q || nomOpenGroups.has(g.key);
    const badge = NOM_TIPO_COLOR[g.tipos?.[0]] || 'badge-gray';
    html += `<div class="nom-group" id="nomg-${g.key}">
      <div class="nom-group-header" onclick="toggleNomGroup('${g.key}')">
        <span class="nom-group-toggle${isOpen?' open':''}">▶</span>
        <span class="nom-group-label">${g.label}</span>
        <span class="nom-group-count">${accounts.length} cuenta${accounts.length!==1?'s':''}</span>
      </div>
      <div class="nom-group-body${isOpen?' open':''}">
        ${accounts.map(renderRow).join('')}
      </div>
    </div>`;
  });

  container.innerHTML = html || '<div style="padding:40px;text-align:center;color:var(--text3)">Sin resultados</div>';
}

function toggleNomGroup(key) {
  const body   = document.querySelector(`#nomg-${key} .nom-group-body`);
  const toggle = document.querySelector(`#nomg-${key} .nom-group-toggle`);
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  toggle.classList.toggle('open', !isOpen);
  if (!isOpen) nomOpenGroups.add(key); else nomOpenGroups.delete(key);
}

function nomExpandAll() {
  document.querySelectorAll('.nom-group-body').forEach(b => b.classList.add('open'));
  document.querySelectorAll('.nom-group-toggle').forEach(t => t.classList.add('open'));
  NOM_GROUPS.forEach(g => nomOpenGroups.add(g.key));
  nomOpenGroups.add('__otros__');
}

function nomCollapseAll() {
  document.querySelectorAll('.nom-group-body').forEach(b => b.classList.remove('open'));
  document.querySelectorAll('.nom-group-toggle').forEach(t => t.classList.remove('open'));
  nomOpenGroups.clear();
}

function openNewNomenclatura() {
  document.getElementById('nom-id').value           = '';
  document.getElementById('nom-codigo').value        = '';
  document.getElementById('nom-nombre').value        = '';
  document.getElementById('nom-tipo').value          = '';
  document.getElementById('nom-moneda').value        = '';
  document.getElementById('nom-conciliacion').value  = 'false';
  document.getElementById('nom-activo').value        = 'true';
  document.getElementById('modal-nomenclatura-title').textContent = 'Nueva Cuenta';
  openModal('modal-nomenclatura');
}

function editNomenclatura(id) {
  const n = state.nomenclatura.find(x => x.id === id);
  document.getElementById('nom-id').value           = n.id;
  document.getElementById('nom-codigo').value        = n.codigo||'';
  document.getElementById('nom-nombre').value        = n.nombre||'';
  document.getElementById('nom-tipo').value          = n.tipo||'';
  document.getElementById('nom-moneda').value        = n.moneda||'';
  document.getElementById('nom-conciliacion').value  = String(!!n.permite_conciliacion);
  document.getElementById('nom-activo').value        = String(n.activo !== false);
  document.getElementById('modal-nomenclatura-title').textContent = 'Editar Cuenta';
  openModal('modal-nomenclatura');
}

async function saveNomenclatura() {
  const id     = document.getElementById('nom-id').value;
  const codigo = document.getElementById('nom-codigo').value.trim();
  const nombre = document.getElementById('nom-nombre').value.trim();
  const tipo   = document.getElementById('nom-tipo').value;
  if (!codigo || !nombre || !tipo) { toast('Código, nombre y tipo son requeridos','error'); return; }
  const row = {
    codigo, nombre, tipo,
    moneda:               document.getElementById('nom-moneda').value,
    permite_conciliacion: document.getElementById('nom-conciliacion').value === 'true',
    activo:               document.getElementById('nom-activo').value === 'true',
  };
  let err;
  if (id) { ({error:err} = await sb.from('erp_nomenclatura').update(row).eq('id',id)); }
  else     { ({error:err} = await sb.from('erp_nomenclatura').insert(row)); }
  if (err) { toast('Error: '+err.message,'error'); return; }
  toast('Cuenta guardada');
  closeModal('modal-nomenclatura');
  await loadAll();
}

async function deleteNomenclatura(id) {
  if (!confirm('¿Eliminar esta cuenta?')) return;
  const {error} = await sb.from('erp_nomenclatura').delete().eq('id',id);
  if (error) { toast('Error: '+error.message,'error'); return; }
  toast('Cuenta eliminada');
  await loadAll();
}

// ═══════════════════════════════════════════════════
// MÓDULO: TIPO DE CAMBIO — Banguat GTQ/USD
// ═══════════════════════════════════════════════════

// ── Tipo de Cambio — obtención automática con fallbacks ─────────

// BANGUAT_URL vive ahora en js/constantes.js

/**
 * Obtiene el TC de referencia OFICIAL del Banguat.
 * La página banguat.gob.gt/cambio/tc.asp devuelve el número exacto como texto.
 * Usamos proxies CORS públicos en cascada para leerla.
 * Retorna { gtq, fuente } o null si todos los proxies fallan.
 */
async function fetchTCFromAPIs() {
  // TC viene de la base de datos — guardado por cron job de Supabase
  // No se hace fetch externo desde el browser
  const hoy = today();
  const tc = state.tiposCambio?.find(t => t.fecha === hoy);
  if (tc) return { gtq: Number(tc.referencia), fuente: tc.fuente || 'Banguat' };
  // Si no hay TC de hoy, usar el más reciente
  const ultimo = state.tiposCambio?.[0];
  if (ultimo) return { gtq: Number(ultimo.referencia), fuente: ultimo.fuente || 'Banguat' };
  return null;
}

async function fetchTipoCambio(manual = false) {
  const btn = document.getElementById('btn-actualizar-tc');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Cargando...'; }

  // Reload TC from DB to get latest
  const { data } = await sb.from('erp_tipos_cambio').select('*').order('fecha', {ascending:false}).limit(90);
  if (data) state.tiposCambio = data;
  updateTCTopbar();

  if (btn) { btn.disabled = false; btn.textContent = '↻ Actualizar ahora'; }

  const hoy = today();
  const tcHoyDb = state.tiposCambio?.find(t => t.fecha === hoy);
  const ultimo  = state.tiposCambio?.[0];

  // If we have today's TC and not manual, just update display
  if (tcHoyDb && !manual) {
    renderTipoCambio();
    return;
  }

  // Show confirmation modal with DB value
  const ref    = tcHoyDb?.referencia || ultimo?.referencia || null;
  const fuente = tcHoyDb?.fuente || ultimo?.fuente || 'Banguat';
  showTCModal(ref ? Number(ref) : null, fuente, !!tcHoyDb);
}

/**
 * Muestra el modal de confirmación de TC.
 * Si auto=true, el campo viene pre-llenado y el usuario solo confirma.
 * Si auto=false, muestra el último TC conocido y pide que lo actualice.
 */
function showTCModal(tcSugerido, fuente, autoObtained) {
  // Crear o limpiar modal
  let modal = document.getElementById('modal-tc-confirm');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'modal-tc-confirm';
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal('modal-tc-confirm'); });
  }

  const ultimo = state.tiposCambio?.[0];
  const ultimoLabel = ultimo ? `Q ${Number(ultimo.referencia).toFixed(4)} (${fmtDate(ultimo.fecha)})` : '—';

  modal.innerHTML = `
    <div class="modal" style="max-width:500px">
      <div class="modal-header">
        <div class="modal-title">💱 Tipo de Cambio — ${new Date().toLocaleDateString('es-GT',{weekday:'long',day:'numeric',month:'long'})}</div>
      </div>
      <div class="modal-body" style="padding:24px">

        ${autoObtained ? `
        <div style="background:#ECFDF5;border:1.5px solid #A7F3D0;border-radius:8px;padding:12px 16px;margin-bottom:20px;display:flex;align-items:flex-start;gap:10px">
          <span style="font-size:18px;flex-shrink:0">✅</span>
          <div>
            <div style="font-weight:600;color:#065F46;font-size:13px">TC obtenido automáticamente — ${fuente}</div>
            <div style="font-size:12px;color:#059669;margin-top:2px">Verifica el dato oficial en <a href="${BANGUAT_URL}" target="_blank" style="color:#047857;font-weight:700;text-decoration:underline">banguat.gob.gt ↗</a> y edita si es necesario.</div>
          </div>
        </div>` : `
        <div style="background:#FFFBEB;border:1.5px solid #FDE68A;border-radius:8px;padding:12px 16px;margin-bottom:20px;display:flex;align-items:flex-start;gap:10px">
          <span style="font-size:18px;flex-shrink:0">⚠️</span>
          <div>
            <div style="font-weight:600;color:#92400E;font-size:13px">No se pudo obtener el TC automáticamente</div>
            <div style="font-size:12px;color:#B45309;margin-top:2px">Consulta el TC oficial en <a href="${BANGUAT_URL}" target="_blank" style="color:#D97706;font-weight:700;text-decoration:underline">banguat.gob.gt ↗</a> e ingrésalo abajo.</div>
          </div>
        </div>`}

        <!-- TC value display -->
        <div id="tc-display-value" style="text-align:center;margin:20px 0">
          <div style="font-size:42px;font-weight:700;font-family:'DM Mono',monospace;color:var(--accent3);letter-spacing:-1px">
            Q <span id="tc-val-display">${tcSugerido ? Number(tcSugerido).toFixed(5) : '—'}</span>
          </div>
          <div style="font-size:12px;color:var(--text3);margin-top:4px">por 1 USD</div>
        </div>

        <!-- Edit field - hidden by default -->
        <div id="tc-edit-field" style="display:none;margin-bottom:16px">
          <div class="field" style="margin:0">
            <label>Editar TC de Referencia (GTQ/USD)</label>
            <input type="number" id="tc-input-edit" step="0.0001"
              value="${tcSugerido || ''}"
              style="font-family:'DM Mono',monospace;font-size:22px;font-weight:700;color:var(--accent3);padding:10px 14px;text-align:center"
              oninput="document.getElementById('tc-val-display').textContent = parseFloat(this.value).toFixed(5)||'—'"
              onkeydown="if(event.key==='Enter') confirmTC()"/>
          </div>
        </div>

        <!-- Verify link -->
        <div style="text-align:center;margin-bottom:8px">
          <a href="${BANGUAT_URL}" target="_blank"
             style="font-size:12px;color:var(--accent3);text-decoration:none;display:inline-flex;align-items:center;gap:4px;padding:6px 12px;border:1px solid var(--border);border-radius:6px;transition:background 0.12s"
             onmouseenter="this.style.background='var(--surface2)'"
             onmouseleave="this.style.background=''">
            🔗 Verificar en Banguat ↗
          </a>
        </div>

        ${ultimo ? `<div style="text-align:center;font-size:11px;color:var(--text3)">Último registrado: ${ultimoLabel}</div>` : ''}

      </div>
      <div class="modal-footer" style="justify-content:space-between">
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" onclick="closeModal('modal-tc-confirm')">Omitir</button>
          <button class="btn btn-secondary" id="btn-tc-edit" onclick="toggleTCEdit()">✎ Editar</button>
        </div>
        <button class="btn btn-primary" style="min-width:140px;font-size:14px" onclick="confirmTC()">
          ✓ Confirmar
        </button>
      </div>
    </div>`;

  // Store suggested value
  modal._tcSugerido = tcSugerido;
  openModal('modal-tc-confirm');
}

function toggleTCEdit() {
  const field  = document.getElementById('tc-edit-field');
  const btn    = document.getElementById('btn-tc-edit');
  const modal  = document.getElementById('modal-tc-confirm');
  const isOpen = field.style.display !== 'none';
  if (isOpen) {
    field.style.display = 'none';
    btn.textContent = '✎ Editar';
  } else {
    field.style.display = 'block';
    btn.textContent = '✕ Cancelar edición';
    const input = document.getElementById('tc-input-edit');
    input.value = modal._tcSugerido || '';
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }
}

async function confirmTC() {
  const modal = document.getElementById('modal-tc-confirm');
  const editField = document.getElementById('tc-edit-field');
  const editOpen  = editField?.style.display !== 'none';

  let ref;
  if (editOpen) {
    ref = parseFloat(document.getElementById('tc-input-edit')?.value);
    if (isNaN(ref) || ref <= 0) { toast('Ingresa un TC válido','error'); return; }
  } else {
    ref = modal?._tcSugerido;
    if (!ref || ref <= 0) {
      // No value — open edit
      toggleTCEdit();
      toast('Por favor ingresa el TC antes de confirmar','error');
      return;
    }
  }

  const ok = await _guardarTC({ fecha: today(), referencia: ref, notas: 'Banguat' }, 'Banguat');
  if (ok) closeModal('modal-tc-confirm');
}

// ── Aplicar TC a asientos pendientes ───────────────────────────
async function aplicarTCPendientes(fecha, tc) {
  // Find all asientos with estado_tc = 'pendiente_tc' on or before this date
  const pendientes = state.asientos.filter(a =>
    a.estado_tc === 'pendiente_tc' && a.fecha <= fecha
  ).sort((a,b) => a.fecha?.localeCompare(b.fecha||'')||0); // chronological order

  if (!pendientes.length) return;

  let procesados = 0;
  for (const asiento of pendientes) {
    const tcUsar = asiento.moneda === 'USD' ? tc : 1;

    // Update each linea with GTQ conversion
    const lineas = state.asientoLineas.filter(l => l.asiento_id === asiento.id);
    for (const l of lineas) {
      const esUSD = asiento.moneda === 'USD';
      const monto = Number(l.monto_orig||0) || (Number(l.debe_gtq||0) + Number(l.haber_gtq||0));
      const debeOrig  = Number(l.debe_gtq||0) / (esUSD ? (asiento.tc_aplicado||1) : 1);
      const haberOrig = Number(l.haber_gtq||0) / (esUSD ? (asiento.tc_aplicado||1) : 1);
      const debeGTQ   = esUSD ? parseFloat((debeOrig  * tcUsar).toFixed(4)) : debeOrig;
      const haberGTQ  = esUSD ? parseFloat((haberOrig * tcUsar).toFixed(4)) : haberOrig;
      await sb.from('erp_asiento_lineas').update({
        debe: debeGTQ, haber: haberGTQ,
        debe_gtq: debeGTQ, haber_gtq: haberGTQ,
      }).eq('id', l.id);
    }

    // Update asiento header
    const lineasActualizadas = lineas.map(l => ({
      ...l,
      debe:  asiento.moneda==='USD' ? Number(l.monto_orig||0)*tcUsar : Number(l.debe||0),
      haber: asiento.moneda==='USD' ? 0 : Number(l.haber||0),
    }));
    await sb.from('erp_asientos').update({
      estado_tc:   'aplicado',
      fecha_tc:    fecha,
      tc_aplicado: tcUsar,
      tipo_cambio: tcUsar,
    }).eq('id', asiento.id);

    procesados++;
  }

  if (procesados > 0) {
    toast(`TC aplicado a ${procesados} asiento${procesados!==1?'s':''} pendientes`, 'success');
    // Hide pending badge
    const badge = document.getElementById('tc-pending-badge');
    if (badge) badge.style.display = 'none';
  }
}

async function _guardarTC(datos, fuente = 'Banguat') {
  const row = {
    fecha:      datos.fecha,
    referencia: datos.referencia,
    fuente,
    notas: datos.notas || fuente,
  };
  const existe = state.tiposCambio.find(t => t.fecha === datos.fecha);
  let err;
  if (existe) ({error:err} = await sb.from('erp_tipos_cambio').update(row).eq('id', existe.id));
  else        ({error:err} = await sb.from('erp_tipos_cambio').insert(row));
  if (err) { toast('Error: '+err.message,'error'); return false; }
  toast(`TC confirmado: Q${Number(datos.referencia).toFixed(4)}/USD`);
  await loadAll();
  // Apply TC to any pending asientos for this date
  await aplicarTCPendientes(datos.fecha, Number(datos.referencia));
  await loadAll();
  return true;
}

// (22/Ago/2026, barrida de sistema): existía un editTC() duplicado acá,
// usando el flujo viejo de tc-edit-field/tc-input-edit. Nunca se
// ejecutaba en producción (la declaración real, más abajo con
// openTCConfirm/tc-manual-notas, siempre ganaba por redeclaración) — se
// eliminó. Mismo motivo que confirmPL(): en type="module" esto pasó de
// inofensivo a SyntaxError fatal.

// openTCConfirm — alias for backwards compat
function openTCConfirm() { fetchTipoCambio(true); }
function saveTCManual() { confirmTC(); }

// ── Obtener TC vigente para una fecha (más cercano anterior) ────

function getTCParaFecha(fecha) {
  if (!state.tiposCambio.length) return null;
  // Find exact match or closest prior date
  const ordenados = [...state.tiposCambio].sort((a,b) => b.fecha.localeCompare(a.fecha));
  const exacto = ordenados.find(t => t.fecha === fecha);
  if (exacto) return exacto;
  // Find closest prior
  return ordenados.find(t => t.fecha <= fecha) || null;
}

// Helper: get current TC reference value
function tcHoy() {
  const hoy = today();
  const tc = getTCParaFecha(hoy);
  return tc ? Number(tc.referencia) : null;
}

function updateTCTopbar() {
  const tc = state.tiposCambio?.[0];
  const valEl  = document.getElementById('tc-topbar-valor');
  const fechaEl = document.getElementById('tc-topbar-fecha');
  if (!valEl) return;
  if (tc) {
    valEl.textContent  = `Q ${Number(tc.referencia).toFixed(4)}`;
    fechaEl.textContent = fmtDateCorto(tc.fecha);
    // Highlight red if TC is not from today
    const esHoy = tc.fecha === today();
    valEl.style.color = esHoy ? 'var(--accent3)' : 'var(--red)';
    document.getElementById('tc-topbar').title =
      esHoy ? `TC vigente al ${fmtDate(tc.fecha)} — Click para ver historial`
             : `⚠ TC desactualizado (${fmtDate(tc.fecha)}) — Click para actualizar`;
  } else {
    valEl.textContent  = 'Sin TC';
    fechaEl.textContent = '';
    valEl.style.color = 'var(--text3)';
  }
}

// ── Render principal ────────────────────────────────────────────
function renderTipoCambio() {
  updateTCTopbar();
  const datos = state.tiposCambio;

  // Header — TC vigente
  const ultimo = datos[0]; // already sorted desc
  if (ultimo) {
    const el  = document.getElementById('tc-valor-grande');
    const fe  = document.getElementById('tc-fecha-vigente');
    const fu  = document.getElementById('tc-fuente');
    const ua  = document.getElementById('tc-ultima-actualizacion');
    if (el) el.textContent = `Q ${Number(ultimo.referencia).toFixed(4)}`;
    if (fe) {
      fe.textContent = `Vigente al ${fmtDate(ultimo.fecha)}`;
    }
    if (fu) fu.textContent = `Fuente: ${ultimo.fuente||'Banguat'}`;
    if (ua) ua.textContent = new Date(ultimo.created_at||Date.now()).toLocaleString('es-GT');
    const cl = document.getElementById('conv-tc-label');
    if (cl) cl.textContent = `Q${Number(ultimo.referencia).toFixed(4)}`;
  }

  // Populate month filter
  const meses = [...new Set(datos.map(t => t.fecha?.slice(0,7)))].sort().reverse();
  const filtroSel = document.getElementById('tc-filtro-mes');
  if (filtroSel) {
    const curVal = filtroSel.value;
    filtroSel.innerHTML = '<option value="">Todos (90 días)</option>' +
      meses.map(m => {
        const [y,mo] = m.split('-');
        const label = new Date(y, mo-1).toLocaleString('es-GT', {month:'long', year:'numeric'});
        return `<option value="${m}">${label}</option>`;
      }).join('');
    filtroSel.value = curVal;
  }

  renderHistorialTC();
}

function renderHistorialTC() {
  const filtroMes = document.getElementById('tc-filtro-mes')?.value || '';
  let datos = state.tiposCambio;
  if (filtroMes) datos = datos.filter(t => (t.fecha||'').startsWith(filtroMes));

  const tbody = document.getElementById('tbl-tc');
  if (!tbody) return;

  const hoy = today();
  tbody.innerHTML = datos.length ? datos.map(t => {
    const esHoy = t.fecha === hoy;
    const fuenteColor = t.fuente === 'Banguat' ? 'badge-green' : 'badge-yellow';
    return `<tr style="${esHoy ? 'background:var(--accent-bg);' : ''}">
      <td>
        <span style="white-space:nowrap;font-weight:${esHoy?'600':'400'}">${fmtDate(t.fecha)}</span>
        ${esHoy ? '<span class="badge badge-green" style="margin-left:6px">Hoy</span>' : ''}
      </td>
      <td class="td-mono" style="text-align:right;font-size:18px;font-weight:700;color:var(--accent3)">Q ${Number(t.referencia).toFixed(4)}</td>
      <td><span class="badge ${fuenteColor}">${t.fuente||'—'}</span></td>
      <td><div class="td-actions">
        <button class="btn btn-sm btn-ghost" onclick="editTC('${t.id}')">Editar</button>
        <button class="btn btn-sm btn-danger" onclick="deleteTC('${t.id}')">✕</button>
      </div></td>
    </tr>`;
  }).join('') :
  '<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">💱</div><p>Sin registros de tipo de cambio</p><p style="font-size:12px;margin-top:4px">Haz click en "Actualizar ahora" para consultar el Banguat</p></div></td></tr>';
}

function editTC(id) {
  const t = state.tiposCambio.find(x => x.id === id);
  if (!t) return;
  openTCConfirm({
    ref:    t.referencia,
    fuente: 'Manual',
    fechaBanguat: t.fecha,
  });
  setTimeout(() => {
    document.getElementById('tc-manual-notas').value = t.notas||'';
  }, 100);
}

async function deleteTC(id) {
  if (!confirm('¿Eliminar este registro de tipo de cambio?')) return;
  const {error} = await sb.from('erp_tipos_cambio').delete().eq('id',id);
  if (error) { toast('Error: '+error.message,'error'); return; }
  toast('Registro eliminado');
  await loadAll();
}

// ── Conversión rápida ───────────────────────────────────────────
function calcConversion(desde) {
  const tcManual = parseFloat(document.getElementById('conv-tc-manual')?.value) || 0;
  const tc = tcManual || tcHoy() || 7.75; // fallback estimado
  const label = document.getElementById('conv-tc-label');
  if (label) label.textContent = `Q${tc.toFixed(4)}`;

  if (desde === 'usd' || desde === 'manual') {
    const usd = parseFloat(document.getElementById('conv-usd')?.value) || 0;
    const gtqEl = document.getElementById('conv-gtq');
    if (gtqEl) gtqEl.value = usd ? (usd * tc).toFixed(2) : '';
  } else if (desde === 'gtq') {
    const gtq = parseFloat(document.getElementById('conv-gtq')?.value) || 0;
    const usdEl = document.getElementById('conv-usd');
    if (usdEl) usdEl.value = gtq && tc ? (gtq / tc).toFixed(2) : '';
  }
}

// ── Exportar CSV ────────────────────────────────────────────────
function exportarTC() {
  const datos = state.tiposCambio;
  if (!datos.length) { toast('Sin datos para exportar','error'); return; }
  const csv = ['Fecha,TC Referencia (GTQ/USD),Fuente',
    ...datos.map(t => `${t.fecha},${t.referencia||''},${t.fuente||''}`)
  ].join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tipo_cambio_${today()}.csv`;
  a.click();
}

// ── Auto-actualizar TC al cargar si es día hábil ────────────────
// Se llama desde loadAll → renderTipoCambio maneja el auto-fetch
