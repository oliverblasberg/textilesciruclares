// ═══════════════════════════════════════════════════════════════════
// js/utils.js — Fase 1 de la división del monolito (22/Ago/2026)
//
// IMPORTANTE — por qué es un script CLÁSICO y no un ES Module:
// index.html usa onclick="funcName()" en cientos de lugares, lo que
// exige que las funciones sean globales (window.funcName). Un
// <script type="module"> NO expone sus declaraciones globalmente, y
// además se ejecuta diferido (después de los scripts clásicos), lo que
// rompería el arranque de la app. Un <script src> clásico, en cambio,
// se ejecuta en orden y sincrónicamente, y sus funciones de nivel
// superior quedan globales automáticamente — exactamente el
// comportamiento que el HTML existente necesita.
//
// Este archivo debe cargarse ANTES del script principal de index.html.
//
// Contenido: funciones de formateo puras — sin dependencia de `state`,
// `sb` (Supabase), ni del DOM. Es el bloque más seguro para extraer
// primero: nada acá puede romper por orden de carga.
// ═══════════════════════════════════════════════════════════════════
// Formato estándar de fecha en toda la app: dd/Mmm/aaaa (ej. 08/Ago/2026).
// Único punto de conversión — cualquier pantalla que muestre una fecha debe
// pasar por aquí (o por fmtDateCorto/fmtMesAbrev) en vez de armar el string
// a mano, para que un cambio de formato futuro solo se edite en un lugar.
const MESES_ABREV = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
function fmtDate(d) {
  if (!d) return '—';
  const iso = d.split('T')[0];
  const [y,m,day] = iso.split('-');
  const mi = parseInt(m,10) - 1;
  if (!y || !day || !MESES_ABREV[mi]) return iso; // fecha no reconocida: se muestra tal cual (fallback seguro)
  return `${day}/${MESES_ABREV[mi]}/${y}`;
}
// Variante compacta sin año — para espacios muy reducidos (ej. topbar de TC).
function fmtDateCorto(d) {
  if (!d) return '—';
  const iso = d.split('T')[0];
  const [y,m,day] = iso.split('-');
  const mi = parseInt(m,10) - 1;
  if (!day || !MESES_ABREV[mi]) return iso;
  return `${day}/${MESES_ABREV[mi]}`;
}
// "aaaa-mm" (ej. de un <input type="month"> o de agrupar movimientos por
// mes) -> "Mmm/aaaa" (ej. 08/2026 -> Ago/2026).
function fmtMesAbrev(ym) {
  if (!ym) return '—';
  const [y,m] = ym.split('-');
  const mi = parseInt(m,10) - 1;
  if (!y || !MESES_ABREV[mi]) return ym;
  return `${MESES_ABREV[mi]}/${y}`;
}
function fmtMoney(n, moneda='GTQ') {
  const num = Number(n||0).toLocaleString('es-GT',{minimumFractionDigits:2,maximumFractionDigits:2});
  return moneda === 'USD' ? '$' + num : 'Q' + num;
}
function fmtGTQ(n) { return fmtMoney(n, 'GTQ'); }
function fmtUSD(n) { return fmtMoney(n, 'USD'); }
function fmtKg(n) { return Number(n||0).toLocaleString('es-GT',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' kg'; }
function today() { return new Date().toISOString().split('T')[0]; }
function fmtNum(n) {
  const num = Number(n || 0);
  return num % 1 === 0 ? num.toLocaleString('es-GT') : num.toFixed(2);
}

// ═══ REDONDEO ═══
// Política de decimales (29/Oct/2026, confirmada por Oliver):
//   · round2 — todo MONTO de dinero que se guarda (asientos, facturas,
//     pagos, NC, costo total de movimientos). El quetzal, los bancos y la
//     SAT trabajan en centavos; guardar 3–4 decimales dejaba residuos
//     (ej. Q0.004 en 51101099 por cada ciclo de Nota de Crédito).
//   · round3 — CANTIDADES (kg).
//   · round4 — TASAS y COSTOS UNITARIOS (tipo de cambio, Q/kg), donde 2
//     decimales distorsionarían el costo de lotes grandes.
// Nunca usar toFixed() para redondear un valor que se guarda: toFixed(2)
// de 1.005 da "1.00". Estas funciones corrigen ese error de coma flotante y
// redondean simétrico (half away from zero) también en negativos.
function roundN(n, dec) {
  const x = Number(n) || 0;
  const f = Math.pow(10, dec);
  return Math.sign(x) * Math.round(Math.abs(x) * f * (1 + Number.EPSILON)) / f;
}
function round2(n) { return roundN(n, 2); }
function round3(n) { return roundN(n, 3); }
function round4(n) { return roundN(n, 4); }
