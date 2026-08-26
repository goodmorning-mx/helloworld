import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent, type ReactNode } from 'react';
import { AuthGuard, AuthProvider, createAuthClient, useAuth, type AuthClient } from '@goodmorning/gm-auth';
import { PwaRuntime } from '@goodmorning/gm-pwa';
import { CandlestickSeries, createChart, type IPriceLine, type Time, type UTCTimestamp } from 'lightweight-charts';
import LabWindow, { type LabRecommendation } from './LabWindow';
import { cacheBars } from './marketData';
import './styles.css';

const configuredApiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
const apiUrl = configuredApiUrl === '/api' && window.location.hostname === 'dev.helloworld.goodmorning.mx'
  ? 'https://api.dev.helloworld.goodmorning.mx'
  : configuredApiUrl;

// Broker contract limits used by paper trading until live symbol metadata is
// available. The effective paper leverage is always the lower of the Lab
// recommendation and this broker/symbol limit.
const SYMBOL_MAX_LEVERAGE: Record<string, number> = {
  'binance:BTCUSDT': 125, 'binance:ETHUSDT': 100, 'binance:BNBUSDT': 75,
  'binance:SOLUSDT': 100, 'binance:XRPUSDT': 75, 'binance:DOGEUSDT': 75,
  'ctrader:AUDUSD': 30, 'ctrader:XAUUSD': 20, 'ctrader:XAGUSD': 20,
};

function maxLeverageFor(broker: 'binance' | 'ctrader', symbol: string) {
  return SYMBOL_MAX_LEVERAGE[`${broker}:${symbol}`] ?? (broker === 'binance' ? 20 : 10);
}

type CTraderCandleRow = { timestamp: number; low: number; delta_open: number; delta_high: number; delta_close: number };
function parseCTraderCandles(payload: unknown): Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }> {
  const rows = (payload as { data?: CTraderCandleRow[] })?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map(row => ({
    time: Math.floor(Number(row.timestamp) * 60) as UTCTimestamp,
    low: Number(row.low),
    open: Number(row.low) + Number(row.delta_open),
    high: Number(row.low) + Number(row.delta_high),
    close: Number(row.low) + Number(row.delta_close),
  })).filter(row => Number.isFinite(Number(row.time)) && Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close));
}

const SESSION_TIMEZONE = 'America/Mexico_City';
const MARKET_SESSIONS = [
  { name: 'Tokyo', open: 18, close: 3, color: '#f59e0b' },
  { name: 'London', open: 2, close: 11, color: '#22c55e' },
  { name: 'New York', open: 7, close: 16, color: '#ef4444' },
  { name: 'Sydney', open: 16, close: 1, color: '#a855f7' },
];
const TIMEZONES = [
  ['Ciudad de México', 'America/Mexico_City'], ['UTC', 'UTC'], ['Nueva York', 'America/New_York'],
  ['Chicago', 'America/Chicago'], ['Los Ángeles', 'America/Los_Angeles'], ['Londres', 'Europe/London'],
  ['Madrid', 'Europe/Madrid'], ['Tokio', 'Asia/Tokyo'], ['Sídney', 'Australia/Sydney'],
] as const;

function timeNumber(time: unknown) {
  if (typeof time === 'number') return time;
  if (time && typeof time === 'object' && 'year' in time && 'month' in time && 'day' in time) {
    const value = time as { year: number; month: number; day: number };
    return Date.UTC(value.year, value.month - 1, value.day) / 1000;
  }
  return 0;
}

function timezoneParts(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp * 1000));
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

/**
 * Converts a wall-clock time in `timezone` to the UTC epoch used by the
 * chart. Lightweight Charts expects numeric times to always be UTC seconds;
 * passing the local hour as a timestamp shifts session lines by the zone
 * offset (for example, 07:00 becomes 13:00 in Mexico City).
 */
function timestampInTimezone(year: number, month: number, day: number, hour: number, timezone: string) {
  const wallClock = Date.UTC(year, month - 1, day, hour, 0, 0);
  const parts = timezoneParts(wallClock / 1000, timezone);
  const representedWallClock = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  const timezoneOffset = representedWallClock - wallClock;
  return Math.round((wallClock - timezoneOffset) / 1000);
}

function chartTimeLabel(time: Time, timezone: string, detailed: boolean) {
  const options: Intl.DateTimeFormatOptions = detailed
    ? { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { hour: '2-digit', minute: '2-digit', hour12: false };
  return new Intl.DateTimeFormat('es-MX', { ...options, timeZone: timezone }).format(new Date(timeNumber(time) * 1000));
}

function sessionDateLabel(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('es-MX', {
    timeZone: timezone, weekday: 'long', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(timestamp * 1000));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const month = (values.month ?? '').replace('.', '').toLowerCase();
  return `${(values.weekday ?? '').toLowerCase()} ${values.hour ?? ''}:${values.minute ?? ''} ${values.day ?? ''} de ${month}`;
}

function useMobilePwa() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px), (display-mode: standalone)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px), (display-mode: standalone)');
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return mobile;
}

function MobileSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="mobile-modal-backdrop" role="presentation" onClick={onClose}>
    <section className="mobile-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
      <div className="mobile-sheet-head"><h2>{title}</h2><button onClick={onClose} aria-label="Cerrar">×</button></div>
      {children}
    </section>
  </div>;
}

type BinancePosition = {
  symbol?: string; side?: string; quantity?: string; entry_price?: string;
  mark_price?: string; unrealized_pnl?: string; liquidation_price?: string;
};
type BinanceAccount = {
  enabled?: boolean; healthy?: boolean; stream_connected?: boolean;
  last_update?: string; last_event?: string; error?: string | null;
  error_kind?: string | null; error_title?: string | null; error_message?: string | null; error_action?: string | null;
  wallet_balance?: string | null; futures_balance?: string | number | null; available_balance?: string | null;
  total_unrealized_pnl?: string | null; positions?: BinancePosition[];
  events?: Array<{ time?: string; type?: string; symbol?: string; status?: string }>;
};
type CTraderAccount = {
  enabled?: boolean; configured?: boolean; healthy?: boolean; stream_connected?: boolean;
  account_id?: number | string | null; trader_login?: number | string | null; balance?: number | null; money_digits?: number | null; broker?: string | null;
  symbols?: string[]; error_kind?: string | null;
  accounts?: Array<{ account_id: number; broker?: string; is_live?: boolean }>;
  error_title?: string | null; error_message?: string | null; error_action?: string | null;
  last_tick?: { symbol?: string; bid?: number; ask?: number; price?: number; time?: number } | null;
};

function BalanceSummary({ paperBalance, revision = 0 }: { paperBalance: number; revision?: number }) {
  const auth = useAuth();
  const [binance, setBinance] = useState<BinanceAccount | null>(null);
  const [ctrader, setCtrader] = useState<CTraderAccount | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const headers: Record<string, string> = auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {};
      const [binanceResponse, ctraderResponse] = await Promise.allSettled([
        fetch(`${apiUrl}/trading/binance`, { headers, credentials: 'include' }),
        fetch(`${apiUrl}/trading/ctrader`, { headers, credentials: 'include' }),
      ]);
      if (!active) return;
      if (binanceResponse.status === 'fulfilled' && binanceResponse.value.ok) setBinance(await binanceResponse.value.json() as BinanceAccount);
      if (ctraderResponse.status === 'fulfilled' && ctraderResponse.value.ok) setCtrader(await ctraderResponse.value.json() as CTraderAccount);
    };
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [auth.accessToken, revision]);
  return <section className="balances-panel" aria-label="Balances"><div className="positions-panel-head"><div><span className="positions-kicker">ACCOUNT SUMMARY</span><h2>Balances</h2></div></div><div className="balances-table-wrap"><table className="balances-table"><thead><tr><th>Cuenta</th><th>Balance</th><th>Estado</th></tr></thead><tbody><tr><td>Paper</td><td>{paperBalance.toFixed(2)} USD</td><td><span className="stream-badge stream-good">Simulado</span></td></tr><tr><td>Binance</td><td>{binance?.futures_balance ?? '—'}</td><td><span className={`stream-badge ${binance?.healthy ? 'stream-good' : 'stream-bad'}`}>{binance?.healthy ? 'Saludable' : 'Sin conexión'}</span></td></tr><tr><td>cTrader</td><td>{ctrader?.balance == null ? '—' : `${ctrader.balance.toFixed(ctrader.money_digits ?? 2)} USD`}</td><td><span className={`stream-badge ${ctrader?.healthy ? 'stream-good' : 'stream-bad'}`}>{ctrader?.healthy ? 'Saludable' : 'Sin conexión'}</span></td></tr></tbody></table></div></section>;
}

function ProfileModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const auth = useAuth();
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [status, setStatus] = useState<{ configured: boolean; masked_api_key?: string | null; updated_at?: string | null } | null>(null);
  const [ctraderAccessToken, setCtraderAccessToken] = useState('');
  const [ctraderRefreshToken, setCtraderRefreshToken] = useState('');
  const [ctraderAccountId, setCtraderAccountId] = useState('');
  const [ctraderStatus, setCtraderStatus] = useState<{ configured: boolean; enabled?: boolean; account_id?: string | null; accounts?: Array<{ account_id: number; broker?: string; is_live?: boolean }>; updated_at?: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const headers: Record<string, string> = auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {};

  useEffect(() => {
    let active = true;
    fetch(`${apiUrl}/trading/binance/credentials`, { headers, credentials: 'include' })
      .then(async response => { if (!response.ok) throw new Error('No se pudo consultar tu perfil.'); return response.json() as Promise<{ configured: boolean; masked_api_key?: string | null; updated_at?: string | null }>; })
      .then(payload => { if (active) setStatus(payload); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'No se pudo consultar tu perfil.'); })
      .finally(() => { if (active) setLoading(false); });
    fetch(`${apiUrl}/trading/ctrader/credentials`, { headers, credentials: 'include' })
      .then(async response => { if (!response.ok) throw new Error('No se pudo consultar cTrader.'); return response.json() as Promise<typeof ctraderStatus>; })
      .then(payload => { if (active) setCtraderStatus(payload); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [auth.accessToken]);

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setMessage('');
    try {
      const response = await fetch(`${apiUrl}/trading/binance/credentials`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ api_key: apiKey, api_secret: apiSecret }) });
      const payload = await response.json() as { detail?: string; message?: string; configured?: boolean; masked_api_key?: string };
      if (!response.ok) throw new Error(payload.detail ?? 'No se pudieron guardar las credenciales.');
      setStatus(payload as typeof status); setApiKey(''); setApiSecret(''); setMessage('Credenciales guardadas. El monitor comenzará a validar la conexión.'); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudieron guardar las credenciales.'); }
    finally { setSaving(false); }
  }

  async function remove() {
    setRemoving(true); setError(''); setMessage('');
    try {
      const response = await fetch(`${apiUrl}/trading/binance/credentials`, { method: 'DELETE', headers, credentials: 'include' });
      if (!response.ok) throw new Error('No se pudieron eliminar las credenciales.');
      setStatus({ configured: false }); setMessage('Credenciales eliminadas.'); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudieron eliminar las credenciales.'); }
    finally { setRemoving(false); }
  }

  async function saveCtrader(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setMessage('');
    try {
      const response = await fetch(`${apiUrl}/trading/ctrader/credentials`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ access_token: ctraderAccessToken, refresh_token: ctraderRefreshToken, account_id: Number(ctraderAccountId) || 0 }) });
      const payload = await response.json() as { detail?: string; message?: string; configured?: boolean; account_id?: string; accounts?: Array<{ account_id: number; broker?: string; is_live?: boolean }> };
      if (!response.ok) throw new Error(payload.detail ?? 'No se pudieron guardar las credenciales cTrader.');
      setCtraderStatus(payload as typeof ctraderStatus); setCtraderAccessToken(''); setCtraderRefreshToken(''); setCtraderAccountId(''); setMessage(payload.message ?? 'Credenciales cTrader guardadas.'); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudieron guardar las credenciales cTrader.'); }
    finally { setSaving(false); }
  }

  async function removeCtrader() {
    setRemoving(true); setError(''); setMessage('');
    try {
      const response = await fetch(`${apiUrl}/trading/ctrader/credentials`, { method: 'DELETE', headers, credentials: 'include' });
      if (!response.ok) throw new Error('No se pudieron eliminar las credenciales cTrader.');
      setCtraderStatus({ configured: false }); setMessage('Credenciales cTrader eliminadas.'); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudieron eliminar las credenciales cTrader.'); }
    finally { setRemoving(false); }
  }

  async function connectCtrader() {
    setSaving(true); setError('');
    try {
      const response = await fetch(`${apiUrl}/trading/ctrader/oauth/url`, { headers, credentials: 'include' });
      const payload = await response.json() as { url?: string; detail?: string };
      if (!response.ok || !payload.url) throw new Error(payload.detail ?? 'No se pudo iniciar la autorización cTrader.');
      window.location.assign(payload.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo iniciar la autorización cTrader.');
      setSaving(false);
    }
  }

  return <div className="profile-modal-backdrop" role="presentation" onClick={onClose}>
    <section className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title" onClick={event => event.stopPropagation()}>
      <div className="profile-modal-head"><div><span className="positions-kicker">CUENTA</span><h2 id="profile-title">Perfil</h2></div><button onClick={onClose} aria-label="Cerrar">×</button></div>
      <div className="profile-identity"><span className="profile-avatar profile-avatar-large">{(auth.identity?.name ?? auth.identity?.email ?? 'U').slice(0, 1).toUpperCase()}</span><div><strong>{auth.identity?.name ?? 'Usuario'}</strong><small>{auth.identity?.email ?? ''}</small></div></div>
      <div className="profile-section"><span className="positions-kicker">BINANCE · FUTURES</span><p className="profile-note">Tus claves son por usuario, se cifran en el backend y nunca se muestran de nuevo. Usa una key sin permisos de retiro y limita su IP.</p>{loading ? <p className="profile-muted">Consultando configuración…</p> : status?.configured ? <p className="profile-configured">Configurada · {status.masked_api_key}</p> : <p className="profile-muted">Aún no hay credenciales configuradas.</p>}</div>
      <form className="profile-form" onSubmit={save}><label className="profile-field"><span>API key</span><input type="text" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" placeholder={status?.configured ? 'Reemplazar API key' : 'Pega tu API key'} required /></label><label className="profile-field"><span>API secret</span><input type="password" value={apiSecret} onChange={event => setApiSecret(event.target.value)} autoComplete="new-password" placeholder="Pega tu API secret" required /></label>{error && <p className="profile-error" role="alert">{error}</p>}{message && <p className="profile-success" role="status">{message}</p>}<div className="profile-actions"><button className="profile-save" type="submit" disabled={saving || removing}>{saving ? 'Guardando…' : 'Guardar credenciales'}</button>{status?.configured && <button className="profile-remove" type="button" onClick={() => void remove()} disabled={saving || removing}>{removing ? 'Eliminando…' : 'Eliminar claves'}</button>}</div></form>
      <div className="profile-section profile-broker-section"><span className="positions-kicker">cTRADER · FOREX</span><p className="profile-note">El client ID y secreto de la aplicación permanecen en el backend. Aquí sólo se guardan tus tokens OAuth y el account ID, cifrados por usuario.</p>{!ctraderStatus?.enabled ? <p className="profile-muted">cTrader aún no está habilitado en este entorno.</p> : ctraderStatus.configured ? <p className="profile-configured">Configurada · cuenta {ctraderStatus.account_id ?? '—'}</p> : <p className="profile-muted">Aún no hay una cuenta cTrader configurada.</p>}</div>
      <div className="profile-actions"><button className="profile-save" type="button" onClick={() => void connectCtrader()} disabled={saving || removing || !ctraderStatus?.enabled}>{saving ? 'Abriendo cTrader…' : 'Conectar con cTrader'}</button></div>
      <p className="profile-note">También puedes pegar tokens manualmente:</p><form className="profile-form" onSubmit={saveCtrader}><label className="profile-field"><span>Access token</span><input type="password" value={ctraderAccessToken} onChange={event => setCtraderAccessToken(event.target.value)} autoComplete="off" placeholder="Pega tu access token" /></label><label className="profile-field"><span>Refresh token</span><input type="password" value={ctraderRefreshToken} onChange={event => setCtraderRefreshToken(event.target.value)} autoComplete="off" placeholder="Pega tu refresh token" /></label><label className="profile-field"><span>Account ID <small>(opcional; se autodetecta)</small></span><input type="number" value={ctraderAccountId} onChange={event => setCtraderAccountId(event.target.value)} placeholder="Se seleccionará la primera cuenta autorizada" /></label>{ctraderStatus?.accounts?.length ? <p className="profile-configured">Cuentas detectadas: {ctraderStatus.accounts.map(account => `${account.broker || 'cTrader'} · ${account.is_live ? 'Live' : 'Demo'} · ${account.account_id}`).join(' · ')}</p> : null}{error && <p className="profile-error" role="alert">{error}</p>}{message && <p className="profile-success" role="status">{message}</p>}<div className="profile-actions"><button className="profile-save" type="submit" disabled={saving || removing || !ctraderStatus?.enabled}>{saving ? 'Guardando…' : 'Guardar tokens manualmente'}</button>{ctraderStatus?.configured && <button className="profile-remove" type="button" onClick={() => void removeCtrader()} disabled={saving || removing}>{removing ? 'Eliminando…' : 'Eliminar cTrader'}</button>}</div></form>
    </section>
  </div>;
}

function BinanceAccountPanel({ revision = 0 }: { revision?: number }) {
  const auth = useAuth();
  const [account, setAccount] = useState<BinanceAccount | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${apiUrl}/trading/binance`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}, credentials: 'include' });
        if (!response.ok) throw new Error(`Binance ${response.status}`);
        const payload = await response.json() as BinanceAccount;
        if (active) setAccount(payload);
      } catch {
        if (active) setAccount({ enabled: true, healthy: false, error: 'No fue posible consultar el monitor Binance.' });
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [auth.accessToken, revision]);
  const online = Boolean(account?.healthy && account?.stream_connected);
  return <section className="binance-account-panel" aria-label="Estado de Binance">
    <div className="binance-panel-head"><div><span className="positions-kicker">BINANCE · CUENTA</span><h2>Estado de Binance</h2></div><span className={`stream-badge ${online ? 'stream-good' : 'stream-bad'}`}>{loading ? 'Consultando…' : online ? 'Saludable · User Stream' : 'Sin conexión'}</span></div>
    {account?.error && <div className="binance-error" role="status"><strong>{account.error_title ?? 'Binance no está disponible'}</strong><span>{account.error_message ?? account.error}</span>{account.error_action && <small>Qué hacer: {account.error_action}</small>}<em>El monitor seguirá reintentando automáticamente.</em></div>}
    <div className="binance-metrics"><div><small>Saldo Futures</small><strong>{account?.futures_balance ?? '—'}</strong></div><div><small>Wallet</small><strong>{account?.wallet_balance ?? '—'}</strong></div><div><small>Disponible</small><strong>{account?.available_balance ?? '—'}</strong></div><div><small>PNL no realizado</small><strong>{account?.total_unrealized_pnl ?? '—'}</strong></div><div><small>Última actualización</small><strong>{account?.last_update ? new Date(account.last_update).toLocaleTimeString() : '—'}</strong></div></div>
    <h3>Posiciones de Binance</h3>
    <div className="positions-table-scroll"><table className="positions-table binance-table"><thead><tr><th>Símbolo</th><th>Lado</th><th>Cantidad</th><th>Entrada</th><th>Mark</th><th>UPNL</th></tr></thead><tbody>{account?.positions?.length ? account.positions.map((position, index) => <tr key={`${position.symbol}-${index}`}><td>{position.symbol ?? '—'}</td><td className={position.side === 'LONG' ? 'value-positive' : 'value-negative'}>{position.side ?? '—'}</td><td>{position.quantity ?? '—'}</td><td>{position.entry_price ?? '—'}</td><td>{position.mark_price ?? '—'}</td><td>{position.unrealized_pnl ?? '—'}</td></tr>) : <tr><td colSpan={6}>Sin posiciones abiertas</td></tr>}</tbody></table></div>
    <h3>Últimos eventos del User Stream</h3>
    <div className="binance-events">{account?.events?.length ? account.events.slice(-5).reverse().map((event, index) => <div key={`${event.time}-${index}`}><span>{event.time ? new Date(event.time).toLocaleTimeString() : '—'}</span>{event.type ?? 'evento'} · {event.symbol ?? ''} · {event.status ?? ''}</div>) : 'Sin eventos recientes'}</div>
  </section>;
}

function CTraderAccountPanel({ revision = 0 }: { revision?: number }) {
  const auth = useAuth();
  const [account, setAccount] = useState<CTraderAccount | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${apiUrl}/trading/ctrader`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}, credentials: 'include' });
        if (!response.ok) throw new Error(`cTrader ${response.status}`);
        const payload = await response.json() as CTraderAccount;
        if (active) setAccount(payload);
      } catch {
        if (active) setAccount({ enabled: true, healthy: false, error_kind: 'UNAVAILABLE', error_title: 'cTrader no está disponible', error_message: 'No fue posible consultar el monitor cTrader.' });
      } finally { if (active) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [auth.accessToken, revision]);
  const online = Boolean(account?.healthy && account?.stream_connected);
  return <section className="binance-account-panel ctrader-account-panel" aria-label="Estado de cTrader">
    <div className="binance-panel-head"><div><span className="positions-kicker">cTRADER · FOREX</span><h2>Estado de cTrader</h2></div><span className={`stream-badge ${online ? 'stream-good' : 'stream-bad'}`}>{loading ? 'Consultando…' : online ? 'Saludable · Stream' : 'Sin conexión'}</span></div>
    {account?.error_message && <div className="binance-error" role="status"><strong>{account.error_title ?? 'cTrader no está disponible'}</strong><span>{account.error_message}</span>{account.error_action && <small>Qué hacer: {account.error_action}</small>}<em>El monitor seguirá reintentando automáticamente.</em></div>}
    <div className="binance-metrics"><div><small>Cuenta broker</small><strong>{account?.trader_login ?? '—'}</strong></div><div><small>ID interno cTrader</small><strong>{account?.account_id ?? '—'}</strong></div><div><small>Balance cTrader</small><strong>{account?.balance == null ? '—' : `${account.balance.toFixed(account.money_digits ?? 2)} USD`}</strong></div><div><small>Símbolos cTrader</small><strong>{account?.symbols?.length ?? 0}</strong></div><div><small>Stream</small><strong>{online ? 'Activo' : '—'}</strong></div></div>
    <h3>Símbolos forex disponibles</h3><div className="binance-events">{account?.symbols?.length ? account.symbols.join(' · ') : 'Configura una cuenta cTrader desde Perfil.'}</div>
  </section>;
}

function Access() {
  const auth = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);

  async function login(event: FormEvent) {
    event.preventDefault();
    await auth.login(username, password, remember);
  }

  return <main className="access-shell"><form className="login-card" onSubmit={login} aria-label="Iniciar sesión">
    <h1>helloworld</h1>
    <input type="text" autoComplete="username" placeholder="Usuario" value={username} onChange={e => setUsername(e.target.value)} required />
    <div className="password-field"><input type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Contraseña" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} /><button type="button" className="password-toggle" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Ocultar contraseña' : 'Ver contraseña'}>{showPassword ? 'Ocultar' : 'Ver'}</button></div>
    <label className="remember-me"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Recordarme</label>
    {auth.error && <p className="login-error" role="alert">{auth.error}</p>}
    <button type="submit" disabled={auth.loading}>{auth.loading ? 'Entrando…' : 'Entrar'}</button>
  </form></main>;
}

function storedAuthTokens() {
  const local = localStorage.getItem('gm-auth-tokens');
  const session = sessionStorage.getItem('gm-auth-tokens');
  const raw = local ?? session;
  if (!raw) return null;
  try {
    const tokens = JSON.parse(raw) as { access_token: string; refresh_token: string };
    if (!local) localStorage.setItem('gm-auth-tokens', JSON.stringify(tokens));
    return { tokens, storage: localStorage };
  } catch {
    return null;
  }
}

function accessTokenExpiresAt(token: string) {
  try {
    const encoded = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
    if (!encoded) return null;
    const payload = JSON.parse(atob(encoded.padEnd(encoded.length + (4 - encoded.length % 4) % 4, '='))) as { exp?: number };
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

function AuthSessionKeeper({ client }: { client: AuthClient }) {
  const auth = useAuth();
  const refreshing = useRef(false);
  useEffect(() => {
    if (!auth.accessToken) return;
    const check = async () => {
      const stored = storedAuthTokens();
      const expiresAt = stored ? accessTokenExpiresAt(stored.tokens.access_token) : null;
      if (!stored || !expiresAt || expiresAt - Date.now() / 1000 > 120 || refreshing.current) return;
      refreshing.current = true;
      try {
        const next = await client.refresh(stored.tokens.refresh_token);
        stored.storage.setItem('gm-auth-tokens', JSON.stringify(next));
        window.location.reload();
      } catch {
        // Keep the current session visible and retry on the next interval.
      } finally {
        refreshing.current = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 60_000);
    return () => window.clearInterval(timer);
  }, [auth.accessToken, client]);
  return null;
}

function CTraderOAuthCallback() {
  const auth = useAuth();
  const [message, setMessage] = useState('Completando autorización cTrader…');
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) { setMessage('cTrader no devolvió un código de autorización.'); return; }
    fetch(`${apiUrl}/trading/ctrader/oauth/exchange`, { method: 'POST', headers: { ...(auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}), 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ code }) })
      .then(async response => { const payload = await response.json() as { detail?: string; message?: string }; if (!response.ok) throw new Error(payload.detail ?? 'No se pudo completar la autorización cTrader.'); return payload; })
      .then(payload => { setMessage(payload.message ?? 'cTrader autorizado. Detectando cuentas…'); window.setTimeout(() => window.location.assign('/'), 1200); })
      .catch(reason => setMessage(reason instanceof Error ? reason.message : 'No se pudo completar la autorización cTrader.'));
  }, [auth.accessToken]);
  return <main className="access-shell"><section className="login-card"><h1>helloworld</h1><p className="profile-success">{message}</p></section></main>;
}

function Workspace() {
  const auth = useAuth();
  const mobilePwa = useMobilePwa();
  const [showProfile, setShowProfile] = useState(false);
  const [profileRevision, setProfileRevision] = useState(0);
  const [labRecommendation, setLabRecommendation] = useState<LabRecommendation | null>(null);
  const chartContainer = useRef<HTMLDivElement>(null);
  const overviewChartContainer = useRef<HTMLDivElement>(null);
  const overviewChartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const overviewCandlesRef = useRef<ReturnType<ReturnType<typeof createChart>['addSeries']> | null>(null);
  const overviewCandleDataRef = useRef<Array<{ time: UTCTimestamp; close: number }>>([]);
  const overviewBarsRef = useRef<Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>>([]);
  const overviewLoadingOlderRef = useRef(false);
  const overviewStage = useRef<HTMLDivElement>(null);
  const chartStage = useRef<HTMLDivElement>(null);
  const labSection = useRef<HTMLElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const candlesRef = useRef<ReturnType<ReturnType<typeof createChart>['addSeries']> | null>(null);
  const candleBarsRef = useRef<Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>>([]);
  const loadingOlderRef = useRef(false);
  const candleDataRef = useRef<Array<{ time: UTCTimestamp; close: number }>>([]);
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [broker, setBroker] = useState<'binance' | 'ctrader'>('binance');
  const [interval, setInterval] = useState<'1s' | '1m' | '3m' | '5m' | '15m'>('5m');
  const entryInterval = '1m' as const;
  const brokerSymbols = broker === 'ctrader' ? ['AUDUSD', 'XAUUSD', 'XAGUSD'] : ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
  const [timezone, setTimezone] = useState('America/Mexico_City');
  const [showSessions, setShowSessions] = useState(true);
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [overviewSize, setOverviewSize] = useState({ width: 1, height: 1 });
  const [tool, setTool] = useState<'line' | 'ruler' | 'long' | 'short' | null>(null);
  const [viewportRevision, setViewportRevision] = useState(0);
  const [overviewRevision, setOverviewRevision] = useState(0);
  type ChartPoint = { time: UTCTimestamp; price: number };
  type ChartCanvas = 'entry' | 'context';
  type Drawing = { id?: string; symbol?: string; type: 'line' | 'ruler' | 'long' | 'short'; start: ChartPoint; end: ChartPoint; stop?: ChartPoint; target?: ChartPoint; chart?: ChartCanvas; paper?: boolean; closed?: boolean; closeReason?: 'TP' | 'SL' | 'MANUAL'; status?: 'OPEN' | 'CLOSED - WIN' | 'CLOSED - FAILED'; riskPercent?: number; notional?: number; margin?: number; pnl?: number };
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [drawingStart, setDrawingStart] = useState<ChartPoint | null>(null);
  const [drawingEnd, setDrawingEnd] = useState<ChartPoint | null>(null);
  const [resizeStart, setResizeStart] = useState<{ index: number; endpoint: 'start' | 'end' | 'stop' | 'target' } | null>(null);
  const [selectedDrawing, setSelectedDrawing] = useState<number | null>(null);
  const [selectedDrawings, setSelectedDrawings] = useState<number[]>([]);
  const [lassoStart, setLassoStart] = useState<{ x: number; y: number } | null>(null);
  const [lassoEnd, setLassoEnd] = useState<{ x: number; y: number } | null>(null);
  const [drawingCanvas, setDrawingCanvas] = useState<ChartCanvas>('entry');
  const [moveStart, setMoveStart] = useState<{ index: number; point: ChartPoint; drawing: Drawing } | null>(null);
  const [mobileSheet, setMobileSheet] = useState<'indicators' | 'tools' | null>(null);
  const [, setActivePositionIndex] = useState<number | null>(null);
  const activePositionIndexRef = useRef<number | null>(null);
  const nativePriceLinesRef = useRef<Array<{ series: ReturnType<ReturnType<typeof createChart>['addSeries']>; line: IPriceLine }>>([]);
  const paperReadyRef = useRef(false);
  const [paperReady, setPaperReady] = useState(false);
  const [paperSyncError, setPaperSyncError] = useState('');
  const [visibleClosedId, setVisibleClosedId] = useState<string | null>(null);
  const [paperTab, setPaperTab] = useState<'open' | 'closed'>('open');
  const [showPaperSettings, setShowPaperSettings] = useState(false);
  const [paperInitialBalance, setPaperInitialBalance] = useState(() => { const value = Number(localStorage.getItem('helloworld-paper-balance') ?? 100); return Number.isFinite(value) && value >= 1 ? value : 100; });
  const [depositAmount, setDepositAmount] = useState('');
  const [paperRiskPercent, setPaperRiskPercent] = useState(() => Number(JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}').riskPercent ?? 1) || 1);

  useEffect(() => {
    const syncAssist = () => {
      const balance = Number(localStorage.getItem('helloworld-paper-balance') ?? 100);
      const raw = JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}') as { riskPercent?: number };
      if (Number.isFinite(balance) && balance >= 1) setPaperInitialBalance(balance);
      if (Number.isFinite(raw.riskPercent) && (raw.riskPercent ?? 0) > 0) setPaperRiskPercent(raw.riskPercent as number);
    };
    window.addEventListener('helloworld-paper-assist-updated', syncAssist);
    return () => window.removeEventListener('helloworld-paper-assist-updated', syncAssist);
  }, []);

  useEffect(() => {
    const removeSelected = (event: KeyboardEvent) => {
      if ((event.key !== 'Delete' && event.key !== 'Backspace') || selectedDrawings.length === 0) return;
      event.preventDefault();
      setDrawings(current => current.filter((_, index) => !selectedDrawings.includes(index)));
      setSelectedDrawings([]);
      setSelectedDrawing(null);
      activePositionIndexRef.current = null;
      setActivePositionIndex(null);
    };
    window.addEventListener('keydown', removeSelected);
    return () => window.removeEventListener('keydown', removeSelected);
  }, [selectedDrawings]);

  useEffect(() => {
    if (!auth.accessToken) return;
    let active = true;
    paperReadyRef.current = false;
    setPaperReady(false);
    fetch(`${apiUrl}/trading/paper/operations`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      credentials: 'include',
    }).then(async response => {
      if (!response.ok) throw new Error('No se pudieron cargar las paper operations.');
      return response.json() as Promise<Array<{
        id: string; symbol: string; side: 'long' | 'short'; chart: ChartCanvas;
        entry_time: number; entry_price: number; current_time: number; current_price: number;
        stop_time: number; stop_price: number; target_time: number; target_price: number;
        risk_percent?: number | null; notional?: number | null; margin?: number | null; pnl?: number | null;
        status: 'OPEN' | 'CLOSED - WIN' | 'CLOSED - FAILED'; close_reason?: 'TP' | 'SL' | 'MANUAL' | null; updated_at?: string;
      }>>;
    }).then(operations => {
      if (!active) return;
      const restored = operations.map(operation => ({
        id: operation.id,
        symbol: operation.symbol,
        type: operation.side,
        paper: true,
        chart: operation.chart,
        start: { time: operation.entry_time as UTCTimestamp, price: operation.entry_price },
        end: { time: operation.current_time as UTCTimestamp, price: operation.current_price },
        stop: { time: operation.stop_time as UTCTimestamp, price: operation.stop_price },
        target: { time: operation.target_time as UTCTimestamp, price: operation.target_price },
        closed: operation.status !== 'OPEN',
        status: operation.status,
        closeReason: operation.close_reason ?? undefined,
        riskPercent: operation.risk_percent ?? undefined,
        notional: operation.notional ?? undefined,
        margin: operation.margin ?? undefined,
        pnl: operation.pnl ?? undefined,
      } satisfies Drawing));
      setDrawings(current => [...current.filter(drawing => !drawing.paper), ...restored]);
      const activeIndex = restored.findIndex(operation => !operation.closed);
      const lastClosed = [...operations].filter(operation => operation.status !== 'OPEN').sort((left, right) => Date.parse(right.updated_at ?? '') - Date.parse(left.updated_at ?? ''))[0];
      setVisibleClosedId(lastClosed?.id ?? null);
      activePositionIndexRef.current = activeIndex >= 0 ? activeIndex : null;
      setActivePositionIndex(activePositionIndexRef.current);
      paperReadyRef.current = true;
      setPaperReady(true);
      setPaperSyncError('');
    }).catch(reason => {
      if (!active) return;
      setPaperSyncError(reason instanceof Error ? reason.message : 'No se pudieron cargar las paper operations.');
    });
    return () => { active = false; };
  }, [auth.accessToken]);

  useEffect(() => {
    if (!auth.accessToken || !paperReadyRef.current) return;
    const operations = drawings.filter(drawing => drawing.paper && drawing.id && (drawing.type === 'long' || drawing.type === 'short'));
    const timer = window.setTimeout(() => {
      void Promise.all(operations.map(async drawing => {
        const response = await fetch(`${apiUrl}/trading/paper/operations/${drawing.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            symbol: drawing.symbol ?? symbol,
            side: drawing.type,
            chart: drawing.chart === 'context' ? 'context' : 'entry',
            entry_time: Number(drawing.start.time), entry_price: drawing.start.price,
            current_time: Number(drawing.end.time), current_price: drawing.end.price,
            stop_time: Number(drawing.stop?.time ?? drawing.end.time), stop_price: drawing.stop?.price ?? drawing.start.price,
            target_time: Number(drawing.target?.time ?? drawing.end.time), target_price: drawing.target?.price ?? drawing.end.price,
            risk_percent: drawing.riskPercent ?? null, notional: drawing.notional ?? null,
            margin: drawing.margin ?? null, pnl: drawing.pnl ?? null,
            status: drawing.status ?? (drawing.closed ? 'CLOSED - FAILED' : 'OPEN'),
            close_reason: drawing.closeReason ?? null,
          }),
        });
        if (!response.ok) throw new Error('No se pudo guardar una paper operation.');
      })).catch(reason => setPaperSyncError(reason instanceof Error ? reason.message : 'No se pudo guardar una paper operation.'));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [drawings, auth.accessToken, paperReady, symbol]);

  useEffect(() => {
    nativePriceLinesRef.current.forEach(({ series, line }) => series.removePriceLine(line));
    nativePriceLinesRef.current = [];
    const addLines = (canvas: ChartCanvas, series: ReturnType<ReturnType<typeof createChart>['addSeries']> | null) => {
      if (!series) return;
      drawings.forEach((drawing, index) => {
        if (!drawing.paper || (drawing.type !== 'long' && drawing.type !== 'short')) return;
        if (drawing.closed && drawing.id !== visibleClosedId) return;
        if (canvas === 'context' ? drawing.chart !== 'context' : drawing.chart === 'context') return;
        const targetPrice = drawing.target?.price ?? drawing.end.price;
        const stopPrice = drawing.stop?.price;
        if (stopPrice === undefined) return;
        const targetLine = series.createPriceLine({
          id: `paper-${index}-tp-${canvas}`,
          price: targetPrice,
          color: '#3b82f6',
          lineWidth: 3,
          lineStyle: 2,
          lineVisible: true,
          axisLabelVisible: true,
          title: 'TP',
          axisLabelColor: '#2563eb',
          axisLabelTextColor: '#eff6ff',
        });
        const stopLine = series.createPriceLine({
          id: `paper-${index}-sl-${canvas}`,
          price: stopPrice,
          color: '#ef4444',
          lineWidth: 4,
          lineStyle: 2,
          lineVisible: true,
          axisLabelVisible: true,
          title: 'SL',
          axisLabelColor: '#dc2626',
          axisLabelTextColor: '#fff1f2',
        });
        nativePriceLinesRef.current.push({ series, line: targetLine }, { series, line: stopLine });
      });
    };
    addLines('entry', candlesRef.current);
    if (!mobilePwa) addLines('context', overviewCandlesRef.current);
    return () => {
      nativePriceLinesRef.current.forEach(({ series, line }) => series.removePriceLine(line));
      nativePriceLinesRef.current = [];
    };
  }, [drawings, symbol, interval, mobilePwa, visibleClosedId]);

  useEffect(() => {
    if (!chartStage.current) return;
    const updateSize = () => {
      if (chartStage.current) {
        setStageSize({ width: chartStage.current.clientWidth, height: chartStage.current.clientHeight });
        setViewportRevision(value => value + 1);
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(chartStage.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (mobilePwa || !overviewStage.current) return;
    const updateSize = () => overviewStage.current && setOverviewSize({ width: overviewStage.current.clientWidth, height: overviewStage.current.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(overviewStage.current);
    return () => observer.disconnect();
  }, [mobilePwa]);

  useEffect(() => {
    if (!chartContainer.current) return;
    activePositionIndexRef.current = null;
    setActivePositionIndex(null);
    const chart = createChart(chartContainer.current, {
      autoSize: true,
      layout: { background: { color: '#080a0d' }, textColor: '#89909b' },
      grid: { vertLines: { color: '#151a20' }, horzLines: { color: '#151a20' } },
      rightPriceScale: { borderColor: '#252a31' },
      localization: { locale: 'es-MX', timeFormatter: (time: Time) => chartTimeLabel(time, timezone, true) },
      timeScale: { borderColor: '#252a31', timeVisible: true, secondsVisible: false, tickMarkFormatter: (time: Time) => chartTimeLabel(time, timezone, false) },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#64d39a', downColor: '#f27e7e', borderVisible: false, wickUpColor: '#64d39a', wickDownColor: '#f27e7e' });
    chartRef.current = chart;
    candlesRef.current = candles;
    let active = true;
    const refreshDrawings = () => {
      const logicalRange = chart.timeScale().getVisibleLogicalRange();
      if (logicalRange && logicalRange.from < 80 && !loadingOlderRef.current && candleBarsRef.current.length > 0) {
        const oldest = Number(candleBarsRef.current[0].time);
        const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
        if (oldest > sevenDaysAgo) {
          loadingOlderRef.current = true;
          const previousRange = { from: logicalRange.from, to: logicalRange.to };
          const dayStart = Math.max(sevenDaysAgo, oldest - 86400);
          const fetchChunk = (endTime: number, limit: number) => fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${entryInterval}&limit=${limit}&endTime=${Math.max(sevenDaysAgo * 1000, endTime * 1000 - 1)}`).then(response => response.json());
          fetchChunk(oldest, 1000).then(firstRows => {
              if (!active || !Array.isArray(firstRows)) return [];
              const first = firstRows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }));
              const remaining = Math.max(0, Math.round((oldest - dayStart) / 60) - first.length);
              return remaining > 0 && first.length > 0 ? fetchChunk(Number(first[0].time), Math.min(1000, remaining)).then(secondRows => first.concat(Array.isArray(secondRows) ? secondRows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) })) : []).sort((left, right) => Number(left.time) - Number(right.time))) : first;
            }).then(older => {
              if (!active || older.length === 0) return;
              candleBarsRef.current = [...older, ...candleBarsRef.current].filter((bar, index, all) => index === 0 || bar.time !== all[index - 1].time);
              candleBarsRef.current = candleBarsRef.current.filter(bar => Number(bar.time) >= sevenDaysAgo);
              void cacheBars(symbol, entryInterval, candleBarsRef.current);
              candleDataRef.current = candleBarsRef.current.map(({ time, close }) => ({ time, close }));
              candles.setData(candleBarsRef.current);
              chart.timeScale().setVisibleLogicalRange({ from: previousRange.from + older.length, to: previousRange.to + older.length });
              setViewportRevision(value => value + 1);
            })
            .catch(() => undefined)
            .finally(() => { loadingOlderRef.current = false; });
        }
      }
      setViewportRevision(value => value + 1);
    };
    chart.timeScale().subscribeVisibleTimeRangeChange(refreshDrawings);
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshDrawings);
    candleDataRef.current = [];
    candleBarsRef.current = [];
    if (broker === 'ctrader') {
      let polling = 0;
      // A cTrader weekend can contain no candles in the last 24 hours. Keep
      // the entry chart useful without making the worker request an oversized
      // history window.
      const loadCTrader = () => fetch(`${apiUrl}/trading/ctrader/candles/${encodeURIComponent(symbol)}?interval=${entryInterval}&days=3`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}, credentials: 'include' })
        .then(response => response.ok ? response.json() : Promise.reject(new Error(`cTrader ${response.status}`)))
        .then(payload => {
          if (!active) return;
          const parsed = parseCTraderCandles(payload);
          if (!parsed.length) return;
          candleBarsRef.current = parsed;
          candleDataRef.current = parsed.map(({ time, close }) => ({ time, close }));
          candles.setData(parsed);
          if (!polling) chart.timeScale().fitContent();
          polling += 1;
          setViewportRevision(value => value + 1);
        })
        .catch(() => undefined);
      void loadCTrader();
      const timer = window.setInterval(() => void loadCTrader(), 5_000);
      return () => { active = false; window.clearInterval(timer); chart.timeScale().unsubscribeVisibleTimeRangeChange(refreshDrawings); chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshDrawings); chartRef.current = null; candlesRef.current = null; candleDataRef.current = []; candleBarsRef.current = []; loadingOlderRef.current = false; chart.remove(); };
    }
    const stream = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${entryInterval}`);
    fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${entryInterval}&limit=500`)
      .then(response => response.json())
      .then(rows => {
        if (!active || !Array.isArray(rows)) return;
        const parsed = rows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }));
        candleBarsRef.current = parsed;
        void cacheBars(symbol, entryInterval, parsed);
        candleDataRef.current = parsed.map(({ time, close }) => ({ time, close }));
        candles.setData(parsed);
        chart.timeScale().fitContent();
        setViewportRevision(value => value + 1);
      })
      .catch(() => undefined);
    stream.onmessage = event => {
      if (!active) return;
      const candle = JSON.parse(event.data).k;
      const next = { time: Math.floor(candle.t / 1000) as UTCTimestamp, open: Number(candle.o), high: Number(candle.h), low: Number(candle.l), close: Number(candle.c) };
      candleBarsRef.current = [...candleBarsRef.current.filter(value => value.time !== next.time), next].sort((left, right) => Number(left.time) - Number(right.time));
      void cacheBars(symbol, entryInterval, [next]);
      candleDataRef.current = candleBarsRef.current.map(({ time, close }) => ({ time, close }));
      candles.update(next);
      setDrawings(current => {
        let anyOpen = false;
        const updated = current.map(drawing => {
          if (drawing.closed || !drawing.paper || (drawing.type !== 'long' && drawing.type !== 'short')) return drawing;
          anyOpen = true;
          const direction = drawing.type === 'long' ? 1 : -1;
          const targetPrice = drawing.target?.price ?? drawing.end.price;
          const stopPrice = drawing.stop?.price ?? drawing.start.price;
          // Kline high/low catches a touch even when the candle closes back inside
          // the position. If both boundaries were touched in one update, use the
          // current close as a deterministic tie-breaker.
          const targetTouched = direction === 1 ? next.high >= targetPrice : next.low <= targetPrice;
          const stopTouched = direction === 1 ? next.low <= stopPrice : next.high >= stopPrice;
          const bothTouched = targetTouched && stopTouched;
          const hitTarget = bothTouched ? (direction === 1 ? next.close >= targetPrice : next.close <= targetPrice) : targetTouched;
          const hitStop = bothTouched ? !hitTarget : stopTouched;
          const closeReason: 'TP' | 'SL' | undefined = hitTarget ? 'TP' : hitStop ? 'SL' : undefined;
          const status: Drawing['status'] = closeReason === 'TP' ? 'CLOSED - WIN' : closeReason === 'SL' ? 'CLOSED - FAILED' : 'OPEN';
          const stopDistance = Math.abs(drawing.start.price - stopPrice);
          const stopPercent = drawing.start.price > 0 ? stopDistance / drawing.start.price : 0;
          const fallbackNotional = stopPercent > 0 ? paperRiskAmount / stopPercent : 0;
          const notional = Number.isFinite(drawing.notional) && (drawing.notional ?? 0) > 0
            ? drawing.notional as number
            : Math.min(fallbackNotional, paperInitialBalance * paperLeverage);
          const realizedPnl = closeReason ? (((next.close - drawing.start.price) / drawing.start.price) * direction * notional) : drawing.pnl;
          if (closeReason && drawing.id) setVisibleClosedId(drawing.id);
          return {
            ...drawing,
            end: { time: next.time, price: next.close },
            target: drawing.target ? { ...drawing.target, time: next.time } : undefined,
            stop: drawing.stop ? { ...drawing.stop, time: next.time } : undefined,
            closed: Boolean(closeReason),
            closeReason,
            status,
            notional,
            margin: drawing.margin ?? (paperLeverage > 0 ? notional / paperLeverage : 0),
            pnl: realizedPnl,
          };
        });
        if (!anyOpen) {
          activePositionIndexRef.current = null;
          setActivePositionIndex(null);
        }
        return updated;
      });
      setViewportRevision(value => value + 1);
    };
    return () => {
      active = false;
      stream.close();
      chart.timeScale().unsubscribeVisibleTimeRangeChange(refreshDrawings);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshDrawings);
      chartRef.current = null;
      candlesRef.current = null;
      candleDataRef.current = [];
      candleBarsRef.current = [];
      loadingOlderRef.current = false;
      chart.remove();
    };
  }, [auth.accessToken, broker, symbol]);

  useEffect(() => {
    if (mobilePwa || !overviewChartContainer.current) return;
    const chart = createChart(overviewChartContainer.current, {
      autoSize: true,
      layout: { background: { color: '#080a0d' }, textColor: '#89909b' },
      grid: { vertLines: { color: '#151a20' }, horzLines: { color: '#151a20' } },
      rightPriceScale: { borderColor: '#252a31' },
      localization: { locale: 'es-MX', timeFormatter: (time: Time) => chartTimeLabel(time, timezone, true) },
      timeScale: { borderColor: '#252a31', timeVisible: true, secondsVisible: false, tickMarkFormatter: (time: Time) => chartTimeLabel(time, timezone, false) },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#64d39a', downColor: '#f27e7e', borderVisible: false, wickUpColor: '#64d39a', wickDownColor: '#f27e7e' });
    overviewChartRef.current = chart;
    overviewCandlesRef.current = candles;
    const refreshOverview = () => {
      setOverviewRevision(value => value + 1);
      const logicalRange = chart.timeScale().getVisibleLogicalRange();
      if (!logicalRange || logicalRange.from >= 50 || overviewLoadingOlderRef.current || overviewBarsRef.current.length === 0) return;
      const oldest = Number(overviewBarsRef.current[0].time);
      const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
      if (oldest <= sevenDaysAgo) return;
      overviewLoadingOlderRef.current = true;
      const previousRange = { from: logicalRange.from, to: logicalRange.to };
      const secondsPerBar = interval === '1s' ? 1 : interval === '1m' ? 60 : interval === '3m' ? 180 : interval === '5m' ? 300 : 900;
      const dayStart = Math.max(sevenDaysAgo, oldest - 86400);
      const expected = Math.ceil((oldest - dayStart) / secondsPerBar);
      const fetchChunk = (endTime: number, limit: number) => fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${Math.max(sevenDaysAgo * 1000, endTime * 1000 - 1)}`).then(response => response.json());
      const loadDay = async () => {
        const rows: any[] = [];
        let cursor = oldest;
        while (rows.length < expected && cursor > dayStart && active) {
          const batch = await fetchChunk(cursor, Math.min(1000, expected - rows.length));
          if (!Array.isArray(batch) || batch.length === 0) break;
          rows.unshift(...batch);
          cursor = Number(batch[0][0]) / 1000;
          if (batch.length < 1000) break;
        }
        return rows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) })).filter(bar => Number(bar.time) >= dayStart && Number(bar.time) < oldest).sort((left, right) => Number(left.time) - Number(right.time));
      };
      void loadDay().then(older => {
        if (!active || older.length === 0) return;
        overviewBarsRef.current = [...older, ...overviewBarsRef.current].filter((bar, index, all) => index === 0 || bar.time !== all[index - 1].time).filter(bar => Number(bar.time) >= sevenDaysAgo);
        void cacheBars(symbol, interval, overviewBarsRef.current);
        overviewCandleDataRef.current = overviewBarsRef.current.map(({ time, close }) => ({ time, close }));
        candles.setData(overviewBarsRef.current);
        chart.timeScale().setVisibleLogicalRange({ from: previousRange.from + older.length, to: previousRange.to + older.length });
        setOverviewRevision(value => value + 1);
      }).catch(() => undefined).finally(() => { overviewLoadingOlderRef.current = false; });
    };
    chart.timeScale().subscribeVisibleTimeRangeChange(refreshOverview);
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshOverview);
    let active = true;
    if (broker === 'ctrader') {
      let polling = 0;
      const loadCTrader = () => fetch(`${apiUrl}/trading/ctrader/candles/${encodeURIComponent(symbol)}?interval=${interval === '1s' ? '1m' : interval}&days=7`, { headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}, credentials: 'include' })
        .then(response => response.ok ? response.json() : Promise.reject(new Error(`cTrader ${response.status}`)))
        .then(payload => {
          if (!active) return;
          const parsed = parseCTraderCandles(payload);
          if (!parsed.length) return;
          overviewBarsRef.current = parsed;
          overviewCandleDataRef.current = parsed.map(({ time, close }) => ({ time, close }));
          candles.setData(parsed);
          if (!polling) chart.timeScale().fitContent();
          polling += 1;
          setOverviewRevision(value => value + 1);
        })
        .catch(() => undefined);
      void loadCTrader();
      const timer = window.setInterval(() => void loadCTrader(), 5_000);
      return () => { active = false; window.clearInterval(timer); chart.timeScale().unsubscribeVisibleTimeRangeChange(refreshOverview); chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshOverview); overviewChartRef.current = null; overviewCandlesRef.current = null; overviewCandleDataRef.current = []; overviewBarsRef.current = []; overviewLoadingOlderRef.current = false; chart.remove(); };
    }
    const stream = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`);
    fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=300`)
      .then(response => response.json())
      .then(rows => {
        if (!active || !Array.isArray(rows)) return;
        const parsed = rows.map(row => ({ time: Math.floor(Number(row[0]) / 1000) as UTCTimestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }));
        overviewBarsRef.current = parsed;
        void cacheBars(symbol, interval, parsed);
        overviewCandleDataRef.current = parsed.map(({ time, close }) => ({ time, close }));
        candles.setData(parsed);
        chart.timeScale().fitContent();
      }).catch(() => undefined);
    stream.onmessage = event => {
      if (!active) return;
      const candle = JSON.parse(event.data).k;
      const next = { time: Math.floor(candle.t / 1000) as UTCTimestamp, open: Number(candle.o), high: Number(candle.h), low: Number(candle.l), close: Number(candle.c) };
      overviewBarsRef.current = [...overviewBarsRef.current.filter(value => value.time !== next.time), next].sort((left, right) => Number(left.time) - Number(right.time));
      void cacheBars(symbol, interval, [next]);
      overviewCandleDataRef.current = [...overviewCandleDataRef.current.filter(value => value.time !== next.time), { time: next.time, close: next.close }];
      candles.update(next);
    };
    return () => { active = false; stream.close(); chart.timeScale().unsubscribeVisibleTimeRangeChange(refreshOverview); chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshOverview); overviewChartRef.current = null; overviewCandlesRef.current = null; overviewCandleDataRef.current = []; overviewBarsRef.current = []; overviewLoadingOlderRef.current = false; chart.remove(); };
  }, [auth.accessToken, broker, symbol, interval, timezone, mobilePwa]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      localization: { locale: 'es-MX', timeFormatter: (time: Time) => chartTimeLabel(time, timezone, true) },
      timeScale: { tickMarkFormatter: (time: Time) => chartTimeLabel(time, timezone, false) },
    });
    setViewportRevision(value => value + 1);
  }, [timezone]);

  function pointFromEvent(event: PointerEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function chartContext(canvas: ChartCanvas) {
    return canvas === 'context'
      ? { chart: overviewChartRef.current, candles: overviewCandlesRef.current }
      : { chart: chartRef.current, candles: candlesRef.current };
  }

  function chartPointFromEvent(event: PointerEvent<HTMLElement>, canvas: ChartCanvas = 'entry') {
    const point = pointFromEvent(event);
    const { chart, candles } = chartContext(canvas);
    if (!chart || !candles) return null;
    const time = chart.timeScale().coordinateToTime(point.x);
    const price = candles.coordinateToPrice(point.y);
    if (time === null || price === null) return null;
    return { time: time as UTCTimestamp, price };
  }

  function screenPoint(point: ChartPoint, canvas: ChartCanvas = 'entry') {
    const { chart, candles } = chartContext(canvas);
    if (!chart || !candles) return null;
    const x = chart.timeScale().timeToCoordinate(point.time);
    const y = candles.priceToCoordinate(point.price);
    return x === null || y === null ? null : { x, y };
  }

  function drawingHandles(drawing: Drawing, index: number, canvas: ChartCanvas = 'entry') {
    const start = screenPoint(drawing.start, canvas);
    const end = screenPoint(drawing.end, canvas);
    if (!start || !end) return [];
    if (drawing.type === 'line') return [
      { ...start, index, endpoint: 'start' as const, role: 'default' as const },
      { ...end, index, endpoint: 'end' as const, role: 'default' as const },
    ];
    if (drawing.type === 'ruler') {
      const left = Math.min(start.x, end.x);
      const right = Math.max(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const bottom = Math.max(start.y, end.y);
      return [
        { x: left, y: top, index, endpoint: 'start' as const, role: 'default' as const },
        { x: right, y: top, index, endpoint: 'end' as const, role: 'default' as const },
        { x: left, y: bottom, index, endpoint: 'start' as const, role: 'default' as const },
        { x: right, y: bottom, index, endpoint: 'end' as const, role: 'default' as const },
      ];
    }
    const stopPrice = drawing.stop?.price ?? drawing.start.price - (drawing.end.price - drawing.start.price) / 4;
    const stop = screenPoint(drawing.stop ?? { time: drawing.end.time, price: stopPrice }, canvas);
    if (!stop) return [];
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    if (drawing.paper && drawing.target) {
      const target = screenPoint(drawing.target, canvas);
      if (!target) return [];
      return [
        { x: left, y: target.y, index, endpoint: 'target' as const, role: 'target' as const },
        { x: right, y: target.y, index, endpoint: 'target' as const, role: 'target' as const },
        { x: left, y: stop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
        { x: right, y: stop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
      ];
    }
    return [
      { x: left, y: end.y, index, endpoint: 'end' as const, role: 'target' as const },
      { x: right, y: end.y, index, endpoint: 'end' as const, role: 'target' as const },
      { x: left, y: stop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
      { x: right, y: stop.y, index, endpoint: 'stop' as const, role: 'stop' as const },
    ];
  }

  function handleAt(point: { x: number; y: number }, canvas: ChartCanvas = 'entry') {
    for (let index = drawings.length - 1; index >= 0; index -= 1) {
      if (drawings[index].paper && drawings[index].closed) continue;
      if ((canvas === 'context' && drawings[index].chart !== 'context') || (canvas === 'entry' && drawings[index].chart === 'context')) continue;
      const candidates = drawingHandles(drawings[index], index, canvas).filter(candidate => !drawings[index].paper || candidate.endpoint === 'target' || candidate.endpoint === 'stop');
      const handle = candidates.find(candidate => Math.hypot(candidate.x - point.x, candidate.y - point.y) <= 12);
      if (handle) return handle;
    }
    return null;
  }

  function priceLineAt(point: { x: number; y: number }, canvas: ChartCanvas = 'entry') {
    for (let index = drawings.length - 1; index >= 0; index -= 1) {
      const drawing = drawings[index];
      if (!drawing.paper || drawing.closed || (drawing.type !== 'long' && drawing.type !== 'short')) continue;
      if ((canvas === 'context' && drawing.chart !== 'context') || (canvas === 'entry' && drawing.chart === 'context')) continue;
      const { candles } = chartContext(canvas);
      const targetY = drawing.target && candles ? candles.priceToCoordinate(drawing.target.price) : null;
      const stopY = drawing.stop && candles ? candles.priceToCoordinate(drawing.stop.price) : null;
      if (targetY !== null && targetY !== undefined && Math.abs(point.y - targetY) <= 12) return { index, endpoint: 'target' as const };
      if (stopY !== null && stopY !== undefined && Math.abs(point.y - stopY) <= 12) return { index, endpoint: 'stop' as const };
    }
    return null;
  }

  function startPriceLineDrag(event: PointerEvent<SVGLineElement>, index: number, endpoint: 'target' | 'stop', canvas: ChartCanvas) {
    event.preventDefault();
    event.stopPropagation();
    setDrawingCanvas(canvas);
    setResizeStart({ index, endpoint });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function renderPriceLineHitAreas(canvas: ChartCanvas) {
    const { candles } = chartContext(canvas);
    if (!candles) return null;
    const height = canvas === 'context' ? overviewSize.height : stageSize.height;
    const width = canvas === 'context' ? overviewSize.width : stageSize.width;
    return <g className="price-line-hit-areas">{drawings.map((drawing, index) => {
      if (!drawing.paper || drawing.closed || (drawing.type !== 'long' && drawing.type !== 'short')) return null;
      if (canvas === 'context' ? drawing.chart !== 'context' : drawing.chart === 'context') return null;
      const targetY = drawing.target ? candles.priceToCoordinate(drawing.target.price) : null;
      const stopY = drawing.stop ? candles.priceToCoordinate(drawing.stop.price) : null;
      return <g key={`price-hit-${index}`}><line x1="0" y1={targetY ?? -100} x2={width} y2={targetY ?? -100} className="price-line-hit-target" pointerEvents="stroke" onPointerDown={event => startPriceLineDrag(event, index, 'target', canvas)} /><line x1="0" y1={stopY ?? -100} x2={width} y2={stopY ?? -100} className="price-line-hit-stop" pointerEvents="stroke" onPointerDown={event => startPriceLineDrag(event, index, 'stop', canvas)} /></g>;
    })}</g>;
  }

  function renderSessionIndicator() {
    if (!showSessions || !chartRef.current) return null;
    const range = chartRef.current.timeScale().getVisibleRange();
    if (!range) return null;
    const from = timeNumber(range.from) - 2 * 86400;
    const to = timeNumber(range.to) + 2 * 86400;
    const events: Array<{ x: number; color: string; label: string; date: string }> = [];
    for (let day = new Date(from * 1000); day.getTime() / 1000 <= to; day.setUTCDate(day.getUTCDate() + 1)) {
      const year = day.getUTCFullYear();
      const month = day.getUTCMonth() + 1;
      const date = day.getUTCDate();
      MARKET_SESSIONS.forEach(session => {
        [[session.open, 'Open'], [session.close, 'Close']].forEach(([hour, type]) => {
          if (session.name === 'New York' && type === 'Close') return;
          const eventTime = timestampInTimezone(year, month, date, Number(hour), SESSION_TIMEZONE);
          const x = chartRef.current?.timeScale().timeToCoordinate(eventTime as UTCTimestamp);
          if (x !== null && x !== undefined) events.push({ x, color: session.color, label: `${session.name} ${type}`, date: sessionDateLabel(eventTime, timezone) });
        });
      });
    }
    return <g className="session-indicator">{events.map((event, index) => <g key={`${event.label}-${event.x}-${index}`}><line x1={event.x} y1="0" x2={event.x} y2={stageSize.height} stroke={event.color} className="session-line" /><text x={event.x + 4} y="18" fill={event.color} className="session-label"><tspan x={event.x + 4} dy="0">{event.label}</tspan><tspan x={event.x + 4} dy="26">{event.date}</tspan></text></g>)}</g>;
  }

  function renderInterestMarkers() {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    if (!chart || !candles) return null;
    const markers = candleDataRef.current.flatMap(candle => {
      const local = timezoneParts(Number(candle.time), SESSION_TIMEZONE);
      const hour = Number(local.hour);
      const minute = Number(local.minute);
      if (hour !== 7 || minute < 20 || minute >= 35) return [];
      const x = chart.timeScale().timeToCoordinate(candle.time);
      const y = candles.priceToCoordinate(candle.close);
      return x === null || x === undefined || y === null || y === undefined ? [] : [{ x, y }];
    });
    return <g className="ny-interest-markers">{markers.map((marker, index) => <circle key={`${marker.x}-${index}`} cx={marker.x} cy={marker.y} r="6" className="ny-interest-marker" />)}</g>;
  }

  function renderOverviewSessions() {
    void overviewRevision;
    if (!showSessions || !overviewChartRef.current) return null;
    const range = overviewChartRef.current.timeScale().getVisibleRange();
    if (!range) return null;
    const from = timeNumber(range.from) - 2 * 86400;
    const to = timeNumber(range.to) + 2 * 86400;
    const events: Array<{ x: number; color: string; label: string; date: string }> = [];
    for (let day = new Date(from * 1000); day.getTime() / 1000 <= to; day.setUTCDate(day.getUTCDate() + 1)) {
      MARKET_SESSIONS.forEach(session => [[session.open, 'Open'], [session.close, 'Close']].forEach(([hour, type]) => {
        if (session.name === 'New York' && type === 'Close') return;
        const eventTime = timestampInTimezone(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Number(hour), SESSION_TIMEZONE);
        const x = overviewChartRef.current?.timeScale().timeToCoordinate(eventTime as UTCTimestamp);
        if (x !== null && x !== undefined) events.push({ x, color: session.color, label: `${session.name} ${type}`, date: sessionDateLabel(eventTime, timezone) });
      }));
    }
    return <g className="session-indicator">{events.map((event, index) => <g key={`${event.label}-${event.x}-${index}`}><line x1={event.x} y1="0" x2={event.x} y2={overviewSize.height} stroke={event.color} className="session-line" /><text x={event.x + 4} y="18" fill={event.color} className="session-label"><tspan x={event.x + 4} dy="0">{event.label}</tspan><tspan x={event.x + 4} dy="26">{event.date}</tspan></text></g>)}</g>;
  }

  function renderOverviewInterestMarkers() {
    if (!overviewChartRef.current || !overviewCandlesRef.current) return null;
    const markers = overviewCandleDataRef.current.flatMap(candle => {
      const local = timezoneParts(Number(candle.time), SESSION_TIMEZONE);
      if (Number(local.hour) !== 7 || Number(local.minute) < 20 || Number(local.minute) >= 35) return [];
      const x = overviewChartRef.current?.timeScale().timeToCoordinate(candle.time);
      const y = overviewCandlesRef.current?.priceToCoordinate(candle.close);
      return x === null || x === undefined || y === null || y === undefined ? [] : [{ x, y }];
    });
    return <g className="ny-interest-markers">{markers.map((marker, index) => <circle key={`${marker.x}-${index}`} cx={marker.x} cy={marker.y} r="6" className="ny-interest-marker" />)}</g>;
  }

  function drawingAt(point: { x: number; y: number }, canvas: ChartCanvas = 'entry') {
    for (let index = drawings.length - 1; index >= 0; index -= 1) {
      const drawing = drawings[index];
      if (drawing.paper) continue;
      if ((canvas === 'context' && drawing.chart !== 'context') || (canvas === 'entry' && drawing.chart === 'context')) continue;
      const start = screenPoint(drawing.start, canvas);
      const end = screenPoint(drawing.end, canvas);
      if (!start || !end) continue;
      if (drawing.type === 'ruler') {
        const left = Math.min(start.x, end.x) - 8;
        const right = Math.max(start.x, end.x) + 8;
        const top = Math.min(start.y, end.y) - 8;
        const bottom = Math.max(start.y, end.y) + 8;
        if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) return index;
      } else if (drawing.type === 'line') {
        const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
        const distance = Math.abs((end.y - start.y) * point.x - (end.x - start.x) * point.y + end.x * start.y - end.y * start.x) / length;
        if (distance <= 10) return index;
      } else {
        const stopPrice = drawing.stop?.price ?? drawing.start.price - (drawing.end.price - drawing.start.price) / 4;
        const stop = screenPoint(drawing.stop ?? { time: drawing.end.time, price: stopPrice }, canvas);
        if (stop && point.x >= Math.min(start.x, end.x) - 8 && point.x <= Math.max(start.x, end.x) + 8 && point.y >= Math.min(start.y, end.y, stop.y) - 8 && point.y <= Math.max(start.y, end.y, stop.y) + 8) return index;
      }
    }
    return null;
  }

  function startDrawing(event: PointerEvent<HTMLElement>, canvas: ChartCanvas = 'entry') {
    if ((event.target as HTMLElement).closest('.price-line-hit-target, .price-line-hit-stop')) return;
    if ((event.target as HTMLElement).closest('button')) return;
    setDrawingCanvas(canvas);
    const point = pointFromEvent(event);
    const handle = handleAt(point, canvas);
    if (handle) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizeStart({ index: handle.index, endpoint: handle.endpoint });
      if (!drawings[handle.index].paper) setSelectedDrawing(handle.index);
      return;
    }
    const priceLine = priceLineAt(point, canvas);
    if (priceLine) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizeStart(priceLine);
      return;
    }
    if (!tool) {
      const hit = drawingAt(point, canvas);
      setSelectedDrawing(hit);
      setSelectedDrawings(hit === null ? [] : [hit]);
      if (hit !== null) {
        const chartPoint = chartPointFromEvent(event, canvas);
        if (chartPoint) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          setMoveStart({ index: hit, point: chartPoint, drawing: drawings[hit] });
        }
      } else {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setLassoStart(point);
        setLassoEnd(point);
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const chartPoint = chartPointFromEvent(event, canvas);
    if (chartPoint) {
      setDrawingStart(chartPoint);
      setDrawingEnd(chartPoint);
    }
  }

  function updateDrawing(event: PointerEvent<HTMLElement>) {
    if (lassoStart) {
      setLassoEnd(pointFromEvent(event));
      return;
    }
    if (moveStart) {
      const point = chartPointFromEvent(event, drawingCanvas);
      if (!point) return;
      const timeDelta = Number(point.time) - Number(moveStart.point.time);
      const priceDelta = point.price - moveStart.point.price;
      const shift = (value: ChartPoint): ChartPoint => ({ time: (Number(value.time) + timeDelta) as UTCTimestamp, price: value.price + priceDelta });
      setDrawings(current => current.map((drawing, index) => index === moveStart.index ? { ...drawing, start: shift(moveStart.drawing.start), end: shift(moveStart.drawing.end), stop: moveStart.drawing.stop ? shift(moveStart.drawing.stop) : undefined } : drawing));
      return;
    }
    if (resizeStart) {
      const point = pointFromEvent(event);
      const { candles } = chartContext(drawingCanvas);
      const price = candles?.coordinateToPrice(point.y);
      if (price === null || price === undefined) return;
      const resize = resizeStart;
      setDrawings(current => current.map((drawing, index) => {
        if (index !== resize.index || drawing.closed) return drawing;
        if (resize.endpoint === 'target' && drawing.paper && drawing.target && drawing.stop) {
          const boundedPrice = drawing.type === 'long' ? Math.max(price, drawing.stop.price) : Math.min(price, drawing.stop.price);
          return { ...drawing, target: { ...drawing.target, price: boundedPrice } };
        }
        if (resize.endpoint === 'stop' && drawing.stop) {
          const boundary = drawing.paper && drawing.target ? drawing.target.price : drawing.start.price;
          const boundedPrice = drawing.type === 'long' ? Math.min(price, boundary) : Math.max(price, boundary);
          return { ...drawing, stop: { ...drawing.stop, price: boundedPrice } };
        }
        return drawing;
      }));
      return;
    }
    if (!tool || !drawingStart || resizeStart) return;
    const point = chartPointFromEvent(event, drawingCanvas);
    if (point) setDrawingEnd(point);
  }

  function finishDrawing(event: PointerEvent<HTMLElement>) {
    if (lassoStart) {
      const end = pointFromEvent(event);
      const left = Math.min(lassoStart.x, end.x);
      const right = Math.max(lassoStart.x, end.x);
      const top = Math.min(lassoStart.y, end.y);
      const bottom = Math.max(lassoStart.y, end.y);
      const matches = drawings.map((drawing, index) => ({ drawing, index })).filter(({ drawing }) => {
        if (drawing.paper || (drawingCanvas === 'context' && drawing.chart !== 'context') || (drawingCanvas === 'entry' && drawing.chart === 'context')) return false;
        const points = [drawing.start, drawing.end, ...(drawing.stop ? [drawing.stop] : []), ...(drawing.target ? [drawing.target] : [])].map(point => screenPoint(point, drawingCanvas));
        return points.some(point => point !== null && point.x >= left && point.x <= right && point.y >= top && point.y <= bottom);
      }).map(({ index }) => index);
      setSelectedDrawings(matches);
      setSelectedDrawing(matches[0] ?? null);
      setLassoStart(null);
      setLassoEnd(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (moveStart) {
      updateDrawing(event);
      setMoveStart(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (resizeStart) {
      updateDrawing(event);
      setResizeStart(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (!tool || !drawingStart) return;
    event.preventDefault();
    event.stopPropagation();
    const end = chartPointFromEvent(event, drawingCanvas);
    if (!end) return;
    const positionEnd = tool === 'long'
      ? { ...end, price: Math.max(end.price, drawingStart.price) }
      : tool === 'short'
        ? { ...end, price: Math.min(end.price, drawingStart.price) }
        : end;
    const stopPrice = drawingStart.price - (positionEnd.price - drawingStart.price) / 4;
    const stop = tool === 'long' || tool === 'short' ? { time: positionEnd.time, price: stopPrice } : undefined;
    setDrawings(current => [...current, { type: tool, chart: drawingCanvas, start: drawingStart, end: positionEnd, stop }]);
    setDrawingStart(null);
    setDrawingEnd(null);
    setTool(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function openSimulatedPosition(type: 'long' | 'short') {
    if (!auth.accessToken || !paperReadyRef.current) {
      setPaperSyncError('La cuenta paper todavía está cargando.');
      return;
    }
    const latest = candleDataRef.current[candleDataRef.current.length - 1];
    if (!latest) return;
    const entry = latest.close;
    const direction = type === 'long' ? 1 : -1;
    const storedAssist = JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}') as { stopPercent?: number; targetPercent?: number };
    const stopDistance = Number.isFinite(storedAssist.stopPercent) && (storedAssist.stopPercent ?? 0) > 0 ? (storedAssist.stopPercent as number) / 100 : 0.00087;
    const targetDistance = Number.isFinite(storedAssist.targetPercent) && (storedAssist.targetPercent ?? 0) > 0 ? (storedAssist.targetPercent as number) / 100 : stopDistance * 4;
    const target = entry * (1 + direction * targetDistance);
    const stop = entry * (1 - direction * stopDistance);
    const intervalSeconds = 60;
    const futureTime = (Number(latest.time) + intervalSeconds * 5) as UTCTimestamp;
    const previousOpen = drawings.filter(drawing => drawing.paper && drawing.id && !drawing.closed && (drawing.type === 'long' || drawing.type === 'short'));
    try {
      await Promise.all(previousOpen.map(async drawing => {
        const response = await fetch(`${apiUrl}/trading/paper/operations/${drawing.id}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${auth.accessToken}` }, credentials: 'include',
        });
        if (!response.ok) throw new Error('No se pudo reemplazar la paper operation anterior.');
      }));
    } catch (reason) {
      setPaperSyncError(reason instanceof Error ? reason.message : 'No se pudo reemplazar la paper operation anterior.');
      return;
    }
    if (previousOpen.length) setDrawings(current => current.filter(drawing => !previousOpen.some(previous => previous.id === drawing.id)));
    const riskPercent = Number((JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}') as { riskPercent?: number }).riskPercent) || paperRiskPercent;
    const riskAmount = paperInitialBalance * riskPercent / 100;
    const stopPercent = Math.abs(entry - stop) / entry;
    const notional = Math.min(stopPercent > 0 ? riskAmount / stopPercent : 0, paperInitialBalance * paperLeverage);
    const margin = paperLeverage > 0 ? notional / paperLeverage : 0;
    const response = await fetch(`${apiUrl}/trading/paper/operations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ symbol, side: type, chart: 'entry', entry_time: Number(latest.time), entry_price: entry, current_time: Number(latest.time), current_price: entry, stop_time: Number(futureTime), stop_price: stop, target_time: Number(futureTime), target_price: target, risk_percent: riskPercent, notional, margin, pnl: 0, status: 'OPEN', close_reason: null }),
    });
    if (!response.ok) {
      setPaperSyncError('No se pudo guardar la paper operation.');
      return;
    }
    const saved = await response.json() as { id: string };
    const position: Drawing = {
      id: saved.id, symbol, type, paper: true, status: 'OPEN',
      start: { time: latest.time, price: entry },
      end: { time: latest.time, price: entry },
      stop: { time: futureTime, price: stop },
      target: { time: futureTime, price: target },
      riskPercent, notional, margin, pnl: 0,
    };
    setDrawings(current => {
      const next = [...current, position];
      setVisibleClosedId(null);
      activePositionIndexRef.current = next.length - 1;
      setActivePositionIndex(next.length - 1);
      setSelectedDrawing(null);
      return next;
    });
    setPaperSyncError('');
  }

  async function closePaperPosition(position: Drawing) {
    if (!position.id || position.closed || !auth.accessToken) return;
    const direction = position.type === 'long' ? 1 : -1;
    const priceChange = ((position.end.price - position.start.price) / position.start.price) * direction;
    const status = priceChange >= 0 ? 'CLOSED - WIN' : 'CLOSED - FAILED';
    const stopDistance = Math.abs(position.start.price - (position.stop?.price ?? position.start.price));
    const stopPercent = position.start.price > 0 ? stopDistance / position.start.price : 0;
    const notional = Number.isFinite(position.notional) && (position.notional ?? 0) > 0
      ? position.notional as number
      : Math.min(stopPercent > 0 ? paperRiskAmount / stopPercent : 0, paperInitialBalance * paperLeverage);
    const pnl = priceChange * notional;
    const response = await fetch(`${apiUrl}/trading/paper/operations/${position.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        symbol: position.symbol ?? symbol,
        side: position.type,
        chart: position.chart === 'context' ? 'context' : 'entry',
        entry_time: Number(position.start.time), entry_price: position.start.price,
        current_time: Number(position.end.time), current_price: position.end.price,
        stop_time: Number(position.stop?.time ?? position.end.time), stop_price: position.stop?.price ?? position.start.price,
        target_time: Number(position.target?.time ?? position.end.time), target_price: position.target?.price ?? position.end.price,
        risk_percent: position.riskPercent ?? paperRiskPercent, notional, margin: position.margin ?? (paperLeverage > 0 ? notional / paperLeverage : 0), pnl,
        status, close_reason: 'MANUAL',
      }),
    });
    if (!response.ok) {
      setPaperSyncError('No se pudo cerrar la paper position.');
      return;
    }
    setDrawings(current => current.map(drawing => drawing.id === position.id ? { ...drawing, closed: true, status, closeReason: 'MANUAL', notional, margin: position.margin ?? (paperLeverage > 0 ? notional / paperLeverage : 0), pnl } : drawing));
    setVisibleClosedId(position.id);
    setActivePositionIndex(null);
    setSelectedDrawing(null);
    setPaperTab('closed');
  }

  async function deletePaperPosition(position: Drawing) {
    if (!position.id || !position.closed || !auth.accessToken) return;
    const response = await fetch(`${apiUrl}/trading/paper/operations/${position.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${auth.accessToken}` }, credentials: 'include',
    });
    if (!response.ok) {
      setPaperSyncError('No se pudo borrar la paper operation cerrada.');
      return;
    }
    setDrawings(current => current.filter(drawing => drawing.id !== position.id));
    if (visibleClosedId === position.id) setVisibleClosedId(null);
  }

  function chooseTool(key: 'line' | 'ruler' | 'long' | 'short') {
    setTool(tool === key ? null : key);
  }

  const paperPositions = drawings.filter(drawing => drawing.paper && (drawing.type === 'long' || drawing.type === 'short'));
  const assist = JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}') as { leverage?: number };
  const theoreticalPaperLeverage = Number.isFinite(assist.leverage) && (assist.leverage ?? 0) > 0 ? (assist.leverage as number) : 10;
  const brokerMaxLeverage = maxLeverageFor(broker, symbol);
  const paperLeverage = Math.min(theoreticalPaperLeverage, brokerMaxLeverage);
  const paperRiskAmount = paperInitialBalance * paperRiskPercent / 100;
  const paperPnl = (position: Drawing) => {
    const maxLoss = Math.max(0, paperRiskAmount);
    if (position.closed && Number.isFinite(position.pnl)) return Math.max(-maxLoss, position.pnl as number);
    const stopDistance = Math.abs(position.start.price - (position.stop?.price ?? position.start.price));
    const stopPercent = position.start.price > 0 ? stopDistance / position.start.price : 0;
    const calculatedNotional = stopPercent > 0 ? paperRiskAmount / stopPercent : 0;
    const notional = Number.isFinite(position.notional) && (position.notional ?? 0) > 0
      ? position.notional as number
      : Math.min(calculatedNotional, paperInitialBalance * paperLeverage);
    const direction = position.type === 'long' ? 1 : -1;
    return Math.max(-maxLoss, ((position.end.price - position.start.price) / position.start.price) * direction * notional);
  };
  const realizedPnl = paperPositions.filter(position => position.closed).reduce((sum, position) => sum + paperPnl(position), 0);
  const unrealizedPnl = paperPositions.filter(position => !position.closed).reduce((sum, position) => sum + paperPnl(position), 0);
  const paperEquity = paperInitialBalance + realizedPnl + unrealizedPnl;
  const displayedPaperPositions = paperPositions.filter(position => paperTab === 'open' ? !position.closed : position.closed);
  const labAssistPanel = labRecommendation && <section className="live-lab-assist" aria-label="Recomendación MAE MFE en tiempo real"><div className="live-lab-assist-head"><div><span className="positions-kicker">MAE·MFE LIVE ASSIST</span><h2>Recomendación de la vela actual</h2></div><span>{labRecommendation.label} UTC</span></div><div className="live-lab-assist-grid"><div><small>MAE</small><strong className="value-negative">-{labRecommendation.mae.toFixed(4)}%</strong></div><div><small>MFE</small><strong className="value-positive">+{labRecommendation.mfe.toFixed(4)}%</strong></div><div><small>R:R</small><strong>{labRecommendation.rr.toFixed(2)}:1</strong></div><div><small>Leverage sugerido</small><strong>{labRecommendation.leverage.toFixed(1)}x</strong></div><div><small>Riesgo máximo</small><strong>{labRecommendation.riskAmount.toFixed(2)} USD</strong></div><div><small>Notional sugerido</small><strong>{labRecommendation.notional.toFixed(2)} USD</strong></div><div><small>Margen teórico</small><strong>{labRecommendation.margin.toFixed(2)} USD</strong></div><div><small>TP esperado</small><strong className="value-positive">+{labRecommendation.expectedProfit.toFixed(2)} USD</strong></div></div></section>;
  const positionsTable = <section className="positions-panel" aria-label="Posiciones abiertas">
    <div className="positions-panel-head"><div><span className="positions-kicker">TRADING</span><h2>Paper operations</h2></div><div className="paper-actions"><span className="paper-risk-indicator">Riesgo {paperRiskPercent.toFixed(2)}%</span><button type="button" className="paper-settings-button" onClick={() => setShowPaperSettings(true)} aria-label="Ajustar Paper">⚙</button><span className="paper-badge">PAPER</span></div></div>{paperSyncError && <p className="paper-sync-error" role="status">{paperSyncError}</p>}<div className="paper-tabs" role="tablist" aria-label="Paper operations"><button role="tab" aria-selected={paperTab === 'open'} className={paperTab === 'open' ? 'paper-tab-active' : ''} onClick={() => setPaperTab('open')}>Abiertas <b>{paperPositions.filter(position => !position.closed).length}</b></button><button role="tab" aria-selected={paperTab === 'closed'} className={paperTab === 'closed' ? 'paper-tab-active' : ''} onClick={() => setPaperTab('closed')}>Cerradas <b>{paperPositions.filter(position => position.closed).length}</b></button></div>
    <div className="paper-balance-grid"><div><small>Balance paper</small><strong>{paperEquity.toFixed(2)} USD</strong></div><div><small>Leverage máximo · {symbol}</small><strong>{brokerMaxLeverage.toFixed(0)}x</strong></div><div><small>Leverage paper efectivo</small><strong>{paperLeverage.toFixed(1)}x</strong></div><div><small>PNL realizado</small><strong>{realizedPnl.toFixed(2)} USD</strong></div><div><small>PNL abierto</small><strong>{unrealizedPnl.toFixed(2)} USD</strong></div></div>
    {displayedPaperPositions.length === 0 ? <p className="positions-empty">{paperTab === 'open' ? 'No hay operaciones abiertas.' : 'No hay operaciones cerradas.'}</p> : <div className="positions-table-scroll"><table className="positions-table"><thead><tr><th>Instrumento</th><th>Lado</th><th>Entrada</th><th>Actual</th><th>SL %</th><th>TP %</th><th>Leverage</th><th>Margen</th><th>R:R</th><th>PNL</th><th>ROE</th><th>Acción</th></tr></thead><tbody>{displayedPaperPositions.map((position, index) => {
      const direction = position.type === 'long' ? 1 : -1;
      const stopDistance = Math.abs(position.start.price - (position.stop?.price ?? position.start.price));
      const stopPercent = position.start.price > 0 ? stopDistance / position.start.price : 0;
      const calculatedNotional = stopPercent > 0 ? paperRiskAmount / stopPercent : 0;
      const notional = Number.isFinite(position.notional) && (position.notional ?? 0) > 0
        ? position.notional as number
        : Math.min(calculatedNotional, paperInitialBalance * paperLeverage);
      const margin = position.margin != null && position.margin > 0 ? position.margin : (paperLeverage > 0 ? notional / paperLeverage : 0);
      const leverage = paperLeverage;
      const priceChange = ((position.end.price - position.start.price) / position.start.price) * direction;
      const pnl = paperPnl(position);
      const roe = (pnl / margin) * 100;
      const targetPrice = position.target?.price ?? position.end.price;
      const stopPercentDisplay = ((position.stop ? position.stop.price : position.start.price) - position.start.price) / position.start.price * direction * 100;
      const targetPercentDisplay = (targetPrice - position.start.price) / position.start.price * direction * 100;
      const riskDistance = Math.abs(position.start.price - (position.stop?.price ?? position.start.price));
      const rewardDistance = Math.abs(targetPrice - position.start.price);
      const rr = riskDistance > 0 ? rewardDistance / riskDistance : 0;
      const drawingIndex = drawings.findIndex(drawing => drawing.id === position.id);
      return <tr key={`${position.start.time}-${index}`}><td>{position.symbol ?? symbol}</td><td><span className={`position-side ${position.type}`}>{position.type.toUpperCase()}</span></td><td>{position.start.price.toFixed(8)}</td><td>{position.end.price.toFixed(8)}</td><td className="value-negative">{stopPercentDisplay.toFixed(4)}%</td><td className="value-positive">+{targetPercentDisplay.toFixed(4)}%</td><td>{leverage.toFixed(1)}x</td><td>{margin.toFixed(2)} USDT</td><td>{rr.toFixed(2)}:1</td><td className={pnl >= 0 ? 'value-positive' : 'value-negative'}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(8)} USDT</td><td className={roe >= 0 ? 'value-positive' : 'value-negative'}>{roe >= 0 ? '+' : ''}{roe.toFixed(8)}%</td><td><button className="paper-edit-button" type="button" disabled={drawingIndex < 0} onClick={() => void (position.closed ? deletePaperPosition(position) : closePaperPosition(position))}>{position.closed ? 'Borrar' : 'Cerrar posición'}</button></td></tr>;
    })}</tbody></table></div>}{showPaperSettings && <div className="paper-settings-backdrop" role="presentation" onClick={() => setShowPaperSettings(false)}><section className="paper-settings-modal" role="dialog" aria-modal="true" aria-label="Ajustes Paper" onClick={event => event.stopPropagation()}><div className="paper-settings-head"><h2>Ajustes Paper</h2><button type="button" onClick={() => setShowPaperSettings(false)} aria-label="Cerrar">×</button></div><label>Depósito<input type="number" min="1" step="0.01" placeholder="Agregar USD" value={depositAmount} onChange={event => setDepositAmount(event.target.value)} /><button type="button" className="paper-deposit-button" onClick={() => { const amount = Number(depositAmount); if (!Number.isFinite(amount) || amount <= 0) return; const next = paperInitialBalance + amount; setPaperInitialBalance(next); localStorage.setItem('helloworld-paper-balance', String(next)); window.dispatchEvent(new Event('helloworld-paper-assist-updated')); setDepositAmount(''); }}>Depositar</button></label><label>Riesgo por operación (%)<input type="number" min="0.05" max="10" step="0.05" value={paperRiskPercent} onChange={event => { const value = Math.max(.05, Math.min(10, Number(event.target.value) || .05)); setPaperRiskPercent(value); const current = JSON.parse(localStorage.getItem('helloworld-paper-assist') ?? '{}'); localStorage.setItem('helloworld-paper-assist', JSON.stringify({ ...current, balance: paperInitialBalance, riskPercent: value })); }} /></label></section></div>}
  </section>;

  const renderDrawing = (drawing: Drawing, index: number | string, canvas: ChartCanvas = 'entry') => {
    void viewportRevision;
    const { chart, candles } = chartContext(canvas);
    if (!chart || !candles) return null;
    const startX = chart.timeScale().timeToCoordinate(drawing.start.time);
    const endX = chart.timeScale().timeToCoordinate(drawing.end.time);
    const startY = candles.priceToCoordinate(drawing.start.price);
    const endY = candles.priceToCoordinate(drawing.end.price);
    if (startX === null || endX === null || startY === null || endY === null) return null;
    const start = { x: startX, y: startY };
    const end = { x: endX, y: endY };
    const handles = drawingHandles(drawing, typeof index === 'number' ? index : -1, canvas);
    const handleNodes = handles.filter(handle => !drawing.paper || handle.endpoint === 'target' || handle.endpoint === 'stop').map((handle, handleIndex) => <circle key={handleIndex} cx={handle.x} cy={handle.y} r="7" className={`drawing-handle ${handle.role === 'stop' ? 'handle-stop' : handle.role === 'target' ? 'handle-target' : drawing.type === 'ruler' ? 'handle-ruler' : ''}`} />);
    const pricePercent = ((drawing.end.price - drawing.start.price) / drawing.start.price) * 100;
    const selectedClass = typeof index === 'number' && (selectedDrawing === index || selectedDrawings.includes(index)) ? 'drawing-selected' : undefined;
    if (drawing.type === 'line') return <g key={index} className={selectedClass}><line x1={start.x} y1={start.y} x2={end.x} y2={end.y} className="drawing-line" /><text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - 8} className="drawing-label">{pricePercent >= 0 ? '+' : ''}{pricePercent.toFixed(2)}%</text>{handleNodes}</g>;
    if (drawing.type === 'ruler') {
      const minutes = Math.round(Math.abs(Number(drawing.end.time) - Number(drawing.start.time)) / 60);
      const priceDelta = Math.abs(drawing.end.price - drawing.start.price);
      const left = Math.min(start.x, end.x);
      const top = Math.min(start.y, end.y);
      return <g key={index} className={selectedClass}><rect x={left} y={top} width={Math.max(1, Math.abs(end.x - start.x))} height={Math.max(1, Math.abs(end.y - start.y))} className="measurement-box" /><text x={left + 8} y={top + 18} className="measurement-label">{minutes} min · {priceDelta.toFixed(2)} · {pricePercent >= 0 ? '+' : ''}{pricePercent.toFixed(2)}%</text>{handleNodes}</g>;
    }
    const left = Math.min(start.x, end.x);
    const width = Math.max(1, Math.abs(end.x - start.x));
    const profitTop = drawing.type === 'long' ? Math.min(start.y, end.y) : start.y;
    const riskTop = drawing.type === 'long' ? start.y : Math.min(start.y, end.y);
    const profitHeight = Math.abs(start.y - end.y);
    const riskHeight = Math.abs(start.y - end.y);
    const stopPrice = drawing.stop?.price ?? drawing.start.price - (drawing.end.price - drawing.start.price) / 4;
    const stop = screenPoint(drawing.stop ?? { time: drawing.end.time, price: stopPrice }, canvas);
    if (!stop) return null;
    const targetPrice = drawing.target?.price ?? drawing.end.price;
    const targetPoint = drawing.target ? screenPoint(drawing.target, canvas) : end;
    if (!targetPoint) return null;
    const targetPercent = ((targetPrice - drawing.start.price) / drawing.start.price) * 100 * (drawing.type === 'long' ? 1 : -1);
    const riskPercent = ((stopPrice - drawing.start.price) / drawing.start.price) * 100 * (drawing.type === 'long' ? 1 : -1);
    const riskDistance = Math.abs(drawing.start.price - stopPrice);
    const rewardDistance = Math.abs((drawing.target?.price ?? drawing.end.price) - drawing.start.price);
    const stopPercentAbs = drawing.start.price > 0 ? riskDistance / drawing.start.price : 0;
    const fallbackNotional = stopPercentAbs > 0 ? paperRiskAmount / stopPercentAbs : 0;
    const paperNotional = drawing.notional && drawing.notional > 0
      ? drawing.notional
      : Math.min(fallbackNotional, paperInitialBalance * paperLeverage);
    const slAmount = riskPercent / 100 * paperNotional;
    const tpAmount = targetPercent / 100 * paperNotional;
    const livePnl = drawing.closed && Number.isFinite(drawing.pnl)
      ? Math.max(-paperRiskAmount, drawing.pnl as number)
      : Math.max(-paperRiskAmount, ((drawing.end.price - drawing.start.price) / drawing.start.price) * (drawing.type === 'long' ? 1 : -1) * paperNotional);
    const rr = riskDistance > 0 ? rewardDistance / riskDistance : 0;
    const targetLabel = `${targetPercent >= 0 ? '+' : ''}${targetPercent.toFixed(8)}%`;
    const riskLabel = `${riskPercent >= 0 ? '+' : ''}${riskPercent.toFixed(8)}%`;
    const targetTop = Math.min(start.y, targetPoint.y);
    const targetHeight = Math.abs(start.y - targetPoint.y);
    const stopTop = Math.min(start.y, stop.y);
    const stopHeight = Math.abs(start.y - stop.y);
    const paperClass = drawing.paper ? `paper-position ${drawing.type === 'long' ? 'paper-long' : 'paper-short'}` : '';
    const paperStatusLabel = drawing.closed ? (drawing.status === 'CLOSED - WIN' ? 'Closed Win' : 'Closed Failed') : 'Open';
    return <g key={index} className={`${selectedClass ?? ''} ${paperClass}`}><rect x={left} y={targetTop} width={width} height={targetHeight} className={targetPercent >= 0 ? 'position-profit' : 'position-risk'} /><rect x={left} y={stopTop} width={width} height={stopHeight} className={riskPercent <= 0 ? 'position-risk' : 'position-profit'} /><line x1={left} y1={start.y} x2={left + width} y2={start.y} className="position-entry" /><line x1={left} y1={end.y} x2={left + width} y2={end.y} className="paper-current-price" />{drawing.paper && <><text x={left + 8} y={Math.max(14, start.y - 8)} className="paper-operation-label">Paper Operation · {paperStatusLabel}</text><text x={left + 8} y={targetPoint.y - 10} className="paper-target-label">TP {targetLabel} · +{tpAmount.toFixed(2)} USDT</text><text x={left + 8} y={stop.y + 18} className="paper-stop-label">SL {riskLabel} · {slAmount.toFixed(2)} USDT</text><text x={left + width + 8} y={end.y - 8} className={`paper-current-label ${livePnl >= 0 ? 'paper-current-profit' : 'paper-current-loss'}`}>PNL {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)} USDT</text></>}{!drawing.paper && <><text x={left + 8} y={targetTop + 18} className="position-label">TP {targetLabel}</text><text x={left + 8} y={stopTop + 18} className="position-label">SL {riskLabel}</text><text x={left + 8} y={Math.max(targetTop, stopTop) + 34} className="position-label">R:R {rr.toFixed(2)}:1</text></>}{drawing.paper ? handleNodes : null}{drawing.paper ? null : handleNodes}</g>;
  };

  const chartStageView = <div ref={chartStage} className={`chart-stage ${tool ? 'drawing-mode' : ''}`} onPointerDownCapture={startDrawing} onPointerMoveCapture={updateDrawing} onPointerUpCapture={finishDrawing} onPointerCancelCapture={() => { setDrawingStart(null); setDrawingEnd(null); setMoveStart(null); setResizeStart(null); }}>
    <div ref={chartContainer} className="candlestick-chart" /><svg className="drawing-overlay" viewBox={`0 0 ${stageSize.width} ${stageSize.height}`} preserveAspectRatio="none" aria-hidden="true">{renderSessionIndicator()}{renderInterestMarkers()}{renderPriceLineHitAreas('entry')}{drawings.map((drawing, index) => (!drawing.paper || !drawing.closed || drawing.id === visibleClosedId) && drawing.chart !== 'context' ? renderDrawing(drawing, index, 'entry') : null)}{tool && drawingStart && drawingEnd && drawingCanvas === 'entry' && renderDrawing({ type: tool, chart: 'entry', start: drawingStart, end: drawingEnd }, 'preview', 'entry')}{lassoStart && lassoEnd && drawingCanvas === 'entry' && <rect x={Math.min(lassoStart.x, lassoEnd.x)} y={Math.min(lassoStart.y, lassoEnd.y)} width={Math.abs(lassoEnd.x - lassoStart.x)} height={Math.abs(lassoEnd.y - lassoStart.y)} className="selection-lasso" />}</svg><div className="chart-bottom-controls"><span className="timezone-icon" aria-hidden="true">◷</span><select className="timezone-select" value={timezone} onChange={event => setTimezone(event.target.value)} aria-label="Zona horaria">{TIMEZONES.map(([label, value]) => <option key={value} value={value}>{label}</option>)}</select></div>
    <div className="floating-order-buttons" aria-label="Abrir operación simulada"><button className="open-long-button" disabled={!paperReady} onClick={() => void openSimulatedPosition('long')}>▲ <span>Abrir Long</span></button><button className="open-short-button" disabled={!paperReady} onClick={() => void openSimulatedPosition('short')}>▼ <span>Abrir Short</span></button></div>
  </div>;

  const avatarLabel = (auth.identity?.name ?? auth.identity?.email ?? 'U').slice(0, 1).toUpperCase();
  const profileButton = <button className="profile-avatar" onClick={() => setShowProfile(true)} aria-label="Abrir perfil" title="Perfil">{avatarLabel}</button>;
  const labButton = <button className="lab-open-button" onClick={() => labSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} aria-label="Ir a GoodMorning Lab">Lab</button>;
  const desktopHeader = <div className="symbol-bar"><select className="broker-select" value={broker} onChange={event => { const next = event.target.value as 'binance' | 'ctrader'; setBroker(next); setSymbol(next === 'ctrader' ? 'AUDUSD' : 'BTCUSDT'); }} aria-label="Broker"><option value="binance">Binance</option><option value="ctrader">cTrader</option></select><select className="symbol-select" value={symbol} onChange={event => setSymbol(event.target.value)} aria-label="Símbolo">
    {brokerSymbols.map(option => <option key={option}>{option}</option>)}
  </select><select className="interval-select" value={interval} onChange={event => setInterval(event.target.value as typeof interval)} aria-label="Intervalo de contexto">{(['1s', '1m', '3m', '5m', '15m'] as const).map(value => <option key={value} value={value}>{value}</option>)}</select><span className="chart-source">{broker.toUpperCase()} · {entryInterval.toUpperCase()} ENTRADA · {interval.toUpperCase()} CONTEXTO</span><button className={`session-toggle ${showSessions ? 'session-active' : ''}`} onClick={() => setShowSessions(value => !value)} aria-label="Mostrar sesiones" title="Mostrar sesiones">Sesiones</button><div className="chart-tools" aria-label="Herramientas del gráfico">
    {labButton}<button className={!tool ? 'tool-active' : ''} onClick={() => setTool(null)} aria-label="Seleccionar y navegar" title="Seleccionar y navegar">↖</button>
    {([['line', '╱', 'Línea'], ['ruler', '▥', 'Regla'], ['long', 'L', 'Long'], ['short', 'S', 'Short']] as const).map(([key, icon, label]) => <button key={key} className={tool === key ? 'tool-active' : ''} onClick={() => chooseTool(key)} aria-label={label} title={label}>{icon}</button>)}
    <button onClick={() => setDrawings(current => current.filter(drawing => drawing.paper))} aria-label="Borrar dibujos" title="Borrar dibujos">×</button>
  </div>{profileButton}<button className="logout-button" onClick={() => void auth.logout()} aria-label="Cerrar sesión">Salir</button></div>;

  const toolOptions = [['line', '╱', 'Línea'], ['ruler', '▥', 'Medir'], ['long', 'L', 'Long'], ['short', 'S', 'Short']] as const;
  const chartsRow = <div className="charts-row"><section ref={overviewStage} className={`secondary-chart ${tool ? 'drawing-mode' : ''}`} onPointerDownCapture={event => startDrawing(event, 'context')} onPointerMoveCapture={updateDrawing} onPointerUpCapture={finishDrawing} onPointerCancelCapture={() => { setDrawingStart(null); setDrawingEnd(null); setMoveStart(null); setResizeStart(null); setLassoStart(null); setLassoEnd(null); }}><div className="chart-panel-label">5M · CONTEXTO · BTCUSDT</div><div ref={overviewChartContainer} className="overview-chart" /><svg className="overview-overlay" viewBox={`0 0 ${overviewSize.width} ${overviewSize.height}`} preserveAspectRatio="none" aria-hidden="true">{renderOverviewSessions()}{renderOverviewInterestMarkers()}{renderPriceLineHitAreas('context')}{drawings.map((drawing, index) => (!drawing.paper || !drawing.closed || drawing.id === visibleClosedId) && drawing.chart === 'context' ? renderDrawing(drawing, index, 'context') : null)}{tool && drawingStart && drawingEnd && drawingCanvas === 'context' && renderDrawing({ type: tool, chart: 'context', start: drawingStart, end: drawingEnd }, 'preview', 'context')}{lassoStart && lassoEnd && drawingCanvas === 'context' && <rect x={Math.min(lassoStart.x, lassoEnd.x)} y={Math.min(lassoStart.y, lassoEnd.y)} width={Math.abs(lassoEnd.x - lassoStart.x)} height={Math.abs(lassoEnd.y - lassoStart.y)} className="selection-lasso" />}</svg></section><section className="primary-chart"><div className="chart-panel-label">1M · AJUSTE DE ENTRADA</div>{chartStageView}</section></div>;

  return mobilePwa ? <main className="trading-shell pwa-shell">
    <header className="pwa-mobile-header"><div><span className="pwa-brand">helloworld</span><span className="pwa-market">{broker.toUpperCase()} · {entryInterval.toUpperCase()} ENTRADA · {interval.toUpperCase()} CONTEXTO</span></div><select className="pwa-symbol-select" value={broker} onChange={event => { const next = event.target.value as 'binance' | 'ctrader'; setBroker(next); setSymbol(next === 'ctrader' ? 'AUDUSD' : 'BTCUSDT'); }} aria-label="Broker"><option value="binance">Binance</option><option value="ctrader">cTrader</option></select><select className="pwa-symbol-select" value={symbol} onChange={event => setSymbol(event.target.value)} aria-label="Símbolo">{brokerSymbols.map(option => <option key={option}>{option}</option>)}</select>{profileButton}</header>
    <section className="pwa-chart-wrap">{chartStageView}</section>{positionsTable}{labAssistPanel}<BalanceSummary paperBalance={paperEquity} revision={profileRevision} /><BinanceAccountPanel revision={profileRevision} /><CTraderAccountPanel revision={profileRevision} />
    <nav className="pwa-bottom-nav" aria-label="Controles PWA"><button onClick={() => setTool(null)} className={!tool ? 'pwa-nav-active' : ''}>↖<span>Seleccionar</span></button><button onClick={() => setMobileSheet('indicators')} className={showSessions ? 'pwa-nav-active' : ''}>◉<span>Indicadores</span></button><button onClick={() => setMobileSheet('tools')} className={tool ? 'pwa-nav-active' : ''}>⌁<span>Herramientas</span></button><button onClick={() => void auth.logout()}>⇥<span>Salir</span></button></nav>
    {mobileSheet === 'indicators' && <MobileSheet title="Indicadores" onClose={() => setMobileSheet(null)}><button className={`mobile-option ${showSessions ? 'option-active' : ''}`} onClick={() => setShowSessions(value => !value)}><span><b>Sesiones de mercado</b><small>Tokyo, Londres, Nueva York y Sydney</small></span><i>{showSessions ? '✓' : ''}</i></button><label className="mobile-field">Intervalo<select value={interval} onChange={event => setInterval(event.target.value as typeof interval)}>{(['1s', '1m', '3m', '5m', '15m'] as const).map(value => <option key={value}>{value}</option>)}</select></label><label className="mobile-field">Zona horaria<select value={timezone} onChange={event => setTimezone(event.target.value)}>{TIMEZONES.map(([label, value]) => <option key={value} value={value}>{label}</option>)}</select></label></MobileSheet>}
    {mobileSheet === 'tools' && <MobileSheet title="Herramientas" onClose={() => setMobileSheet(null)}><div className="mobile-tool-grid"><button className={!tool ? 'option-active' : ''} onClick={() => { setTool(null); setMobileSheet(null); }}>↖<span>Seleccionar</span></button>{toolOptions.map(([key, icon, label]) => <button key={key} className={tool === key ? 'option-active' : ''} onClick={() => { chooseTool(key); setMobileSheet(null); }}>{icon}<span>{label}</span></button>)}<button onClick={() => { setDrawings(current => current.filter(drawing => drawing.paper)); activePositionIndexRef.current = null; setActivePositionIndex(null); }}>×<span>Borrar dibujos</span></button></div></MobileSheet>}
    {showProfile && <ProfileModal onClose={() => setShowProfile(false)} onSaved={() => setProfileRevision(value => value + 1)} />}
  </main> : <main className="trading-shell">{desktopHeader}{chartsRow}{positionsTable}{labAssistPanel}<BalanceSummary paperBalance={paperEquity} revision={profileRevision} /><BinanceAccountPanel revision={profileRevision} /><CTraderAccountPanel revision={profileRevision} /><section ref={labSection} className="lab-layout-section"><LabWindow key={`${broker}:${symbol}`} activeSymbol={symbol} broker={broker} apiUrl={apiUrl} accessToken={auth.accessToken} initialBars={candleBarsRef.current} paperBalance={paperEquity} onRecommendation={setLabRecommendation} /></section>{showProfile && <ProfileModal onClose={() => setShowProfile(false)} onSaved={() => setProfileRevision(value => value + 1)} />}</main>;
}

function App() {
  const client = useMemo(() => createAuthClient(apiUrl), []);
  const labRoute = window.location.pathname === '/lab';
  const ctraderCallbackRoute = window.location.pathname === '/ctrader/callback';
  return <PwaRuntime config={{ appName: 'helloworld', version: '0.1.12', serviceWorkerUrl: '/sw.js?v=0.1.12', updateIntervalMs: 60_000 }}><AuthProvider client={client}><AuthSessionKeeper client={client} /><AuthGuard fallback={<Access />}>{ctraderCallbackRoute ? <CTraderOAuthCallback /> : labRoute ? <LabWindow /> : <Workspace />}</AuthGuard></AuthProvider></PwaRuntime>;
}

export default App;
