
// ═══════════════════════════════════════════════════════
// CONSTANTES DE NEGOCIO — extraídas de index.html (Fase 2 modularización, 25/Ago/2026)
// Cero lógica, cero dependencia de state/sb/DOM. Cargar ANTES del script principal,
// después de js/utils.js.
// ═══════════════════════════════════════════════════════

// ── Órdenes de Producción (OP) ──
const OP_ESTADO_LABEL = { borrador:'Borrador', confirmada:'Confirmada', en_proceso:'En Proceso', enviado_terceros:'Enviado a Terceros', recibido_terceros:'Recibido de Terceros', completada:'Completada', cancelada:'Cancelada' };
const OP_ESTADO_COLOR = { borrador:'badge-gray', confirmada:'badge-yellow', en_proceso:'badge-blue', enviado_terceros:'badge-yellow', recibido_terceros:'badge-blue', completada:'badge-green', cancelada:'badge-red' };
const OP_TIPO_LABEL   = {
  tejido_interno:     'Tejido Interno',
  tejido_subcontrato: 'Tejido Subcontrato',
  tenido_subcontrato: 'Teñido Subcontrato',
  acabado_subcontrato: 'Acabado Subcontrato',
};

// ── Recetas (BOM) ──
const RECETA_TIPO_BADGE = {
  tejido_interno:      '<span class="badge badge-green">Tejido Interno</span>',
  tejido_subcontrato:  '<span class="badge badge-yellow">Tejido Subcontrato</span>',
  tenido_subcontrato:  '<span class="badge badge-yellow">Teñido Subcontrato</span>',
  acabado_subcontrato: '<span class="badge badge-yellow">Acabado Subcontrato</span>',
};

// ── Hilos ──
const HIL_CONSTRUCCION_LABEL = {
  anillos_peinado: 'Anillos Peinado',
  anillos_cardado: 'Anillos Cardado',
  open_end:        'Open End',
  filamento:       'Filamento',
  elastano:        'Elastano',
  otro:            'Otro',
};

// ── Productos ──
const PROD_TIPO_LABEL = { almacenable:'Almacenable', servicio:'Servicio', tela:'Almacenable', hilo:'Almacenable', general:'Almacenable' };
const PROD_TIPO_COLOR = { tela:'badge-green', hilo:'badge-blue', general:'badge-yellow' };

// ── Impuestos ──
const IVA_RATE = 0.12;

// ── Compras (OC) — Incoterms y términos de pago ──
const INCOTERMS_LIST = ['EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP'];
const TERMINOS_PAGO_LIST = [
  { value:'inmediato', label:'Pago Inmediato' },
  { value:'15',  label:'15 días' },
  { value:'30',  label:'30 días' },
  { value:'45',  label:'45 días' },
  { value:'60',  label:'60 días' },
];
const TERMINOS_PAGO_LABEL = { inmediato:'Pago Inmediato', '15':'15 días', '30':'30 días', '45':'45 días', '60':'60 días' };

// ── Órdenes de Compra (OC) — estados ──
const OC_STATUS_COLOR = {
  borrador:'badge-gray', confirmada:'badge-blue', recibiendo:'badge-yellow',
  completada:'badge-green', cancelada:'badge-red',
  enviada:'badge-blue',
};
const OC_STATUS_LABEL = {
  borrador:'Borrador', confirmada:'Confirmada', recibiendo:'Recibiendo',
  completada:'Completada', cancelada:'Cancelada', enviada:'Enviada',
};

// ── Contabilidad — diarios ──
const DIARIO_LABEL = {
  VENTAS:'Ventas', COBROS:'Cobros', COMPRAS:'Compras',
  PAGOS:'Pagos', INVENTARIO:'Inventario', GENERAL:'General',
  CAMBIARIO:'Diferencial Cambiario', MANUFACTURA:'Manufactura',
};
const DIARIO_COLOR = {
  VENTAS:'badge-green', COBROS:'badge-blue', COMPRAS:'badge-yellow',
  PAGOS:'badge-red', INVENTARIO:'badge-blue', GENERAL:'badge-gray',
  CAMBIARIO:'badge-yellow', MANUFACTURA:'badge-green',
};

// ── Contabilidad — cuentas contables (códigos fijos del catálogo) ──
const CTA_GANANCIA_CAMBIARIA = '71101002';
const CTA_PERDIDA_CAMBIARIA  = '71201003';

// Variación de precio de compra (30/Ago/2026). Reciben la diferencia entre el
// precio facturado por el proveedor y el precio pactado en la orden.
//
// Van a RESULTADO, no al costo del inventario: cargarlas al inventario dejaba
// residuos permanentes en el balance, porque el FIFO consume al costo del
// movimiento (precio de orden) y la diferencia nunca salía.
//
// Son DOS cuentas, mismo patrón que el diferencial cambiario: separar
// desfavorable de favorable deja ver en el Estado de Resultados cuánto se
// pagó de más y cuánto de menos, en vez de un neto que esconde ambos.
// Ubicadas en 51101xxx (costos de materia prima) para que afecten el MARGEN
// BRUTO. Ambos son movimientos DEFINITIVOS: no se liquidan después.
const CTA_VARIACION_PRECIO_DESF = '51101097'; // facturaron de más  → mayor costo
const CTA_VARIACION_PRECIO_FAV  = '51101098'; // facturaron de menos → menor costo
const DIARIO_CAMBIARIO       = 'CAMBIARIO';

const CTA_INV_HILO      = '11301001'; // Inventario de Hilo
const CTA_INV_PROCESO   = '11301002'; // Inventario Producto en Proceso (WIP)
const CTA_INV_TERMINADO = '11301003'; // Inventario Producto Terminado
const DIARIO_MANUFACTURA = 'MANUFACTURA';

// ── Nomenclatura contable — colores por tipo de cuenta ──
const NOM_TIPO_COLOR = {
  'Activos Circulantes':   'badge-blue',
  'Activos no-circulantes':'badge-blue',
  'Pasivos Circulantes':   'badge-red',
  'Pasivos no-circulantes':'badge-red',
  'Capital':               'badge-green',
  'Banco y efectivo':      'badge-green',
  'Ingreso':               'badge-green',
  'Otro Ingreso':          'badge-green',
  'Por cobrar':            'badge-blue',
  'Por pagar':             'badge-red',
  'Costo de ingresos':     'badge-yellow',
  'Gastos':                'badge-yellow',
  'Ganancias del año actual':'badge-green',
};

// ── Tipo de cambio (Banguat) ──
const BANGUAT_URL = 'https://banguat.gob.gt/cambio/tc.asp';

// ── Kardex ──
const KX_TIPO_LABEL = {
  entrada:'Entrada', salida:'Salida',
  ajuste_positivo:'Ajuste +', ajuste_negativo:'Ajuste −',
  consignacion:'Consignación',
};
const KX_TIPO_COLOR = {
  entrada:'badge-green', salida:'badge-red',
  ajuste_positivo:'badge-blue', ajuste_negativo:'badge-yellow',
  consignacion:'badge-blue',
};
const KX_ES_ENTRADA = t => ['entrada','ajuste_positivo','consignacion'].includes(t);

// ── Bodegas ──
const BODEGA_TIPO_LABEL = {
  general:'General', materia_prima:'Materia Prima',
  producto_terminado:'Producto Terminado', transito:'Tránsito', devoluciones:'Devoluciones',
  en_terceros:'En Poder de Terceros'
};

// ── Colores de gráficos (Chart.js) ──
const FC_GREENS = ['#16A34A','#22C55E','#4ADE80','#15803D','#10B981','#059669','#065F46','#86EFAC'];
const FC_REDS   = ['#DC2626','#EF4444','#F87171','#B91C1C','#F43F5E','#E11D48','#7F1D1D','#FB7185'];
