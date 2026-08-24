// ═══════════════════════════════════════════════════════════════════
// utils.js — Fase 1 de la modularización a ES Modules nativos (22/Ago/2026)
// Primer módulo extraído: funciones de formateo puras, sin dependencia
// de `state`, `sb` (Supabase), ni del DOM. Es el punto de partida más
// seguro posible — nada aquí puede romper por orden de carga o por
// referencias circulares.
//
// Estas funciones NO se llaman nunca directo desde onclick="" en el
// HTML (confirmado por auditoría) — solo se usan dentro de otro código
// JS, así que no necesitan exponerse en `window`. El script principal
// las importa y las usa normalmente dentro de su propio scope de módulo.
// ═══════════════════════════════════════════════════════════════════

export const MESES_ABREV = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

export function fmtDate(d) {
  if (!d) return '—';
  const iso = d.split('T')[0];
  const [y,m,day] = iso.split('-');
  const mi = parseInt(m,10) - 1;
  if (!y || !day || !MESES_ABREV[mi]) return iso; // fecha no reconocida: se muestra tal cual (fallback seguro)
  return `${day}/${MESES_ABREV[mi]}/${y}`;
}

// Variante compacta sin año — para espacios muy reducidos (ej. topbar de TC).
export function fmtDateCorto(d) {
  if (!d) return '—';
  const iso = d.split('T')[0];
  const [y,m,day] = iso.split('-');
  const mi = parseInt(m,10) - 1;
  if (!day || !MESES_ABREV[mi]) return iso;
  return `${day}/${MESES_ABREV[mi]}`;
}

// "aaaa-mm" (ej. de un <input type="month"> o de agrupar movimientos por
// mes) -> "Mmm/aaaa" (ej. 08/2026 -> Ago/2026).
export function fmtMesAbrev(ym) {
  if (!ym) return '—';
  const [y,m] = ym.split('-');
  const mi = parseInt(m,10) - 1;
  if (!y || !MESES_ABREV[mi]) return ym;
  return `${MESES_ABREV[mi]}/${y}`;
}

export function fmtMoney(n, moneda='GTQ') {
  const num = Number(n||0).toLocaleString('es-GT',{minimumFractionDigits:2,maximumFractionDigits:2});
  return moneda === 'USD' ? '$' + num : 'Q' + num;
}

export function fmtGTQ(n) { return fmtMoney(n, 'GTQ'); }
export function fmtUSD(n) { return fmtMoney(n, 'USD'); }
export function fmtKg(n) { return Number(n||0).toLocaleString('es-GT',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' kg'; }
export function today() { return new Date().toISOString().split('T')[0]; }

export function fmtNum(n) {
  const num = Number(n || 0);
  return num % 1 === 0 ? num.toLocaleString('es-GT') : num.toFixed(2);
}
