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
