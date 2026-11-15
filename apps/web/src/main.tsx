import { render } from 'solid-js/web';
import { createSignal, createEffect, onCleanup, Show, For } from 'solid-js';
import type { Device, Operation, HubEvent, CommandInput, ControlEndpoint, SavedWifi } from '../../../packages/contracts/src/index.js';
import { PhotonWordmark } from './PhotonWordmark.js';
import './style.css';

/** Uses only Photon's HTTP contract, keeping protocol and storage code out of the browser. */
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? 'Could not connect to Photon.');
  return data as T;
}

/** Draws a local vector light symbol without an icon library or external assets. */
function Bulb() {
  return <svg viewBox="0 0 48 64" fill="none" aria-hidden="true"><path d="M15 42c0-6-10-10-10-23a19 19 0 0 1 38 0c0 13-10 17-10 23v7H15z" stroke="currentColor" stroke-width="3"/><path d="M15 50h18M18 57h12M21 62h6M19 27l5 6 5-6M24 33v15" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>;
}

/** Draws an outlet symbol for smart plugs without external assets. */
function Plug() {
  return <svg viewBox="0 0 48 64" fill="none" aria-hidden="true"><rect x="6" y="3" width="36" height="54" rx="8" stroke="currentColor" stroke-width="3"/><path d="M17 19v9M31 19v9M20 40a4 4 0 0 1 8 0v3h-8zM24 57v7" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>;
}

/** Presents a light or smart-plug endpoint using confirmed state and capability-based controls. */
function ControlCard(props: { device: Device; endpoint: ControlEndpoint; pending: boolean; simulated: boolean; command: (command: CommandInput) => void }) {
  const available = () => props.device.availability === 'online' && !props.device.stale;
  const [level, setLevel] = createSignal(50);
  createEffect(() => setLevel(props.endpoint.brightness ?? 50));
  return <article class="light-card" classList={{ illuminated: available() && props.endpoint.power === true }}>
    <div class="light-card-top"><span class="status" classList={{ connected: available() }}><i/>{available() ? 'Connected' : 'Reconnecting'}</span><span class="endpoint">{props.endpoint.kind === 'plug' ? 'Outlet' : 'Light'} {props.endpoint.id}</span></div>
    <div class="lamp"><Show when={props.endpoint.kind === 'plug'} fallback={<Bulb/>}><Plug/></Show></div>
    <h2>{props.device.name}</h2>
    <Show when={props.simulated}><p class="field-help">Simulated device — controls do not operate hardware.</p></Show>
    <p class="reported-state">{!available() ? 'State unavailable' : props.endpoint.power === null ? 'Waiting for state' : props.endpoint.power ? 'On' : 'Off'}</p>
    <button class="power" disabled={!available() || props.pending || props.endpoint.power === null}
      aria-label={`${props.endpoint.power ? 'Turn off' : 'Turn on'} ${props.device.name}`}
      onClick={() => props.command({ type: 'power', value: !props.endpoint.power })}>
      <span aria-hidden="true">⏻</span>{props.pending ? 'Waiting for device…' : props.endpoint.power ? 'Turn off' : 'Turn on'}
    </button>
    <Show when={props.endpoint.brightnessSupported}>
      <div class="brightness"><label for={`brightness-${props.device.id}-${props.endpoint.id}`}>Brightness <output>{level()}%</output></label>
        <input id={`brightness-${props.device.id}-${props.endpoint.id}`} type="range" min="1" max="100" value={level()}
          disabled={!available() || props.pending} onInput={event => setLevel(Number(event.currentTarget.value))}
          onChange={() => props.command({ type: 'brightness', value: level() })}/>
      </div>
    </Show>
  </article>;
}

/** Shows recorded protocol transitions and elapsed waiting time without inventing future steps. */
function CommissioningTimeline(props: { operation: Operation }) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!['accepted', 'running'].includes(props.operation.status)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const latest = () => props.operation.timeline?.at(-1);
  const waiting = () => latest()?.status === 'running' && ['accepted', 'running'].includes(props.operation.status);
  return <Show when={props.operation.timeline?.length}>
    <section class="commissioning-timeline" aria-label="Matter setup timeline">
      <h4>Matter setup timeline</h4>
      <Show when={waiting()}><p class="stage-wait" role="status">Waiting at this stage for {Math.max(0, Math.floor((now() - Date.parse(latest()!.at)) / 1000))} s</p></Show>
      <ol><For each={props.operation.timeline}>{event => <li class={`stage-event stage-${event.status}`}>
        <div class="stage-heading"><strong>{event.title}</strong><span class="stage-status">{event.status === 'running' ? 'started' : event.status}</span></div>
        <p>{event.detail}</p>
        <div class="stage-meta"><time dateTime={event.at} title={new Date(event.at).toLocaleTimeString()}>+{Math.max(0, (Date.parse(event.at) - Date.parse(props.operation.createdAt)) / 1000).toFixed(1)} s</time><code>{event.stage}</code></div>
      </li>}</For></ol>
      <a href={`/api/v1/operations/${encodeURIComponent(props.operation.id)}`} target="_blank" rel="noopener noreferrer">Open diagnostic JSON</a>
    </section>
  </Show>;
}

/** Owns the setup/login/dashboard browser journey and a single recoverable event stream. */
function App() {
  const [loading, setLoading] = createSignal(true);
  const [initialized, setInitialized] = createSignal(false);
  const [authenticated, setAuthenticated] = createSignal(false);
  const [authenticationRequired, setAuthenticationRequired] = createSignal(true);
  const [mode, setMode] = createSignal('hardware');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [connected, setConnected] = createSignal(false);
  const [devices, setDevices] = createSignal<Device[]>([]);
  const [operations, setOperations] = createSignal<Operation[]>([]);
  const [onboardingId, setOnboardingId] = createSignal<string>();
  const [savedWifi, setSavedWifi] = createSignal<SavedWifi>({ saved: false, importAvailable: false });
  const [useSavedWifi, setUseSavedWifi] = createSignal(false);
  const [transport, setTransport] = createSignal<'ble' | 'on-network'>('ble');
  let dialog!: HTMLDialogElement;

  /** Loads access status without starting device-management work in the browser. */
  async function initialize() {
    try {
      const [setup, session] = await Promise.all([
        api<{ initialized: boolean; mode: string; authenticationRequired?: boolean }>('/setup'), api<{ authenticated: boolean }>('/session'),
      ]);
      setInitialized(setup.initialized); setMode(setup.mode); setAuthenticated(session.authenticated);
      setAuthenticationRequired(setup.authenticationRequired !== false);
    } catch (failure) { setError((failure as Error).message); }
    finally { setLoading(false); }
  }
  void initialize();

  /** Loads only saved-network metadata; the password stays on the hub. */
  async function loadSavedWifi() {
    try {
      const network = await api<SavedWifi>('/wifi');
      if (authenticated()) { setSavedWifi(network); setUseSavedWifi(network.saved); }
    } catch { /* Manual network entry remains available if metadata cannot be loaded. */ }
  }

  createEffect(() => { if (authenticated()) void loadSavedWifi(); });

  /** Imports a user-requested Keychain entry without returning its password to the browser. */
  async function importWifi(form: HTMLFormElement) {
    setBusy(true); setError('');
    const ssid = String(new FormData(form).get('ssid') ?? '');
    try {
      const network = await api<SavedWifi>('/wifi/import', 'POST', ssid ? { ssid } : {});
      const password = form.elements.namedItem('wifiPassword');
      if (password instanceof HTMLInputElement) password.value = '';
      setSavedWifi(network); setUseSavedWifi(network.saved);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  /** Forgets the remembered network while leaving running operations unchanged. */
  async function forgetWifi() {
    setBusy(true); setError('');
    try { setSavedWifi(await api<SavedWifi>('/wifi', 'DELETE')); setUseSavedWifi(false); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  createEffect(() => {
    if (!authenticated()) return;
    const stream = new EventSource('/api/v1/events');
    stream.onmessage = message => {
      const event = JSON.parse(message.data) as HubEvent;
      if (event.type === 'snapshot') { setDevices(event.data.devices); setOperations(event.data.operations); setConnected(true); }
      if (event.type === 'device') setDevices(items => [...items.filter(item => item.id !== event.data.id), event.data]);
      if (event.type === 'operation') setOperations(items => [...items.filter(item => item.id !== event.data.id), event.data]);
    };
    stream.onerror = () => {
      setConnected(false);
      void api<{ authenticated: boolean }>('/session').then(session => {
        if (!session.authenticated) { stream.close(); setAuthenticated(false); setDevices([]); setOperations([]); }
      }).catch(() => {});
    };
    onCleanup(() => { stream.close(); setConnected(false); });
  });

  /** Creates the owner or signs in, clearing password fields after every attempt. */
  async function access(event: SubmitEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const form = event.currentTarget as HTMLFormElement;
    const fields = new FormData(form);
    const password = String(fields.get('password'));
    try {
      if (!initialized()) {
        await api('/setup', 'POST', { token: String(fields.get('token')), password }); setInitialized(true);
      }
      await api('/session', 'POST', { password }); setAuthenticated(true);
    } catch (failure) { setError((failure as Error).message); }
    finally { form.reset(); setBusy(false); }
  }

  /** Clears setup secrets on submission and follows backend confirmation without canceling on close. */
  async function addDevice(event: SubmitEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const form = event.currentTarget as HTMLFormElement;
    const fields = new FormData(form);
    try {
      const request = api<Operation>('/commissioning', 'POST', { code: String(fields.get('code')), country: String(fields.get('country')).toUpperCase(),
        transport: mode() === 'hardware' ? transport() : 'on-network',
        ...(mode() === 'hardware' && transport() === 'ble' ? useSavedWifi() ? { useSavedWifi: true }
          : { ssid: String(fields.get('ssid')), wifiPassword: String(fields.get('wifiPassword')), rememberWifi: fields.get('rememberWifi') === 'on' } : {}),
      });
      form.reset();
      const connection = form.elements.namedItem('transport');
      if (connection instanceof HTMLSelectElement) connection.value = transport();
      const operation = await request;
      setOnboardingId(operation.id);
      setOperations(items => items.some(item => item.id === operation.id) ? items : [...items, operation]);
      void loadSavedWifi();
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  /** Sends a desired state while leaving displayed state to device reports. */
  async function command(device: Device, endpoint: ControlEndpoint, value: CommandInput) {
    setError('');
    try { await api(`/devices/${encodeURIComponent(device.id)}/endpoints/${endpoint.id}/commands`, 'POST', value); }
    catch (failure) { setError((failure as Error).message); }
  }

  /** Revokes the server session before clearing local state. */
  async function logout() {
    try { await api('/session', 'DELETE'); setAuthenticated(false); setDevices([]); setOperations([]); }
    catch (failure) { setError((failure as Error).message); }
  }

  const pending = (id: string) => operations().some(operation => operation.deviceId === id && ['accepted', 'running'].includes(operation.status));
  const commissioning = () => operations().some(operation => operation.kind === 'commissioning' && ['accepted', 'running'].includes(operation.status));
  const dialogOperation = () => operations().find(operation => operation.id === onboardingId());
  const addLabel = () => mode() === 'fake' ? 'Add a simulated device' : 'Add a device';

  /** Reopens ongoing setup after closing the dialog or reloading the browser. */
  function openOnboarding() {
    setError('');
    setOnboardingId(operations().find(operation => operation.kind === 'commissioning' && ['accepted', 'running'].includes(operation.status))?.id);
    dialog.showModal();
  }

  return <div class="app-shell">
    <header><a href="/" class="brand" aria-label="Photon"><PhotonWordmark/></a><span class="local-label">Your home, connected locally</span>
      <Show when={authenticated() && authenticationRequired()}><button class="text-button" onClick={() => void logout()}>Sign out</button></Show>
    </header>
    <Show when={!loading() && !authenticationRequired()}><aside class="mode-notice" role="note">Password-free local testing — setup and login are skipped.</aside></Show>
    <Show when={!loading() && mode() !== 'hardware'}><aside class="mode-notice" role="note">
      {mode() === 'fake' ? 'UI preview — no physical devices are connected.' : 'Matter simulator — connects to a separate test-device process, not a physical light.'}
    </aside></Show>
    <Show when={!loading()} fallback={<main><p role="status">Connecting to Photon…</p></main>}>
      <Show when={authenticated()} fallback={
        <main class="access"><div class="access-intro"><div class="intro-lamp"><Bulb/></div>
          <h1>{initialized() ? 'Welcome home.' : 'A home of your own.'}</h1>
          <p>{initialized() ? 'Sign in to your local hub.' : 'Create the owner account to connect your first device.'}</p></div>
          <form class="access-form" onSubmit={event => void access(event)}>
            <h2>{initialized() ? 'Sign in' : 'Set up Photon'}</h2>
            <Show when={!initialized()}><label>Setup token<input name="token" required autocomplete="off" spellcheck={false}/></label><p class="field-help">Get a token using the local setup-token command on your hub.</p></Show>
            <label>Password<input name="password" type="password" required minLength={initialized() ? 1 : 12} maxLength={256} autocomplete={initialized() ? 'current-password' : 'new-password'}/></label>
            <Show when={!initialized()}><p class="field-help">Use at least 12 characters. No email or cloud account needed.</p></Show>
            <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
            <button class="primary" disabled={busy()}>{busy() ? 'Please wait…' : initialized() ? 'Sign in' : 'Create owner account'}</button>
          </form>
        </main>
      }>
        <main class="dashboard">
          <div class="page-title"><div><span class="status" classList={{ connected: connected() }}><i/>{connected() ? 'Hub connected' : 'Reconnecting to hub'}</span><h1>Home controls</h1><p>Your lights and smart plugs, controlled locally.</p></div>
            <button class="primary" onClick={openOnboarding}>{commissioning() ? 'View setup progress' : `+ ${addLabel()}`}</button>
          </div>
          <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
          <Show when={devices().length} fallback={<section class="empty"><div class="empty-bulb"><Bulb/></div><h2>Let’s turn something on.</h2><p>{mode() === 'fake' ? 'Choose “Add a simulated device” to preview the controls.' : 'Put your Matter device into pairing mode, then choose “Add a device” to get started.'}</p></section>}>
            <div class="devices"><For each={devices()}>{device => <Show when={device.endpoints.length} fallback={<article class="unavailable"><h2>{device.name}</h2><p>Waiting for the device to reconnect…</p></article>}>
              <For each={device.endpoints}>{endpoint => <ControlCard device={device} endpoint={endpoint} simulated={mode() === 'fake'} pending={pending(device.id)} command={value => void command(device, endpoint, value)}/>}</For>
            </Show>}</For></div>
          </Show>
          <Show when={operations().length}><section class="activity" aria-live="polite"><h2>Recent activity</h2><For each={operations().slice(-6).reverse()}>{operation =>
            <div class="activity-row"><span class="operation-icon" aria-hidden="true">{operation.status === 'completed' ? '✓' : ['failed', 'interrupted'].includes(operation.status) ? '!' : '◌'}</span><div class="activity-content"><strong>{mode() === 'fake' ? 'Simulated: ' : ''}{operation.kind === 'commissioning' ? 'Add device' : 'Control device'}</strong><p>{operation.progress}</p>
              <Show when={operation.kind === 'commissioning' && operation.timeline?.length}><details><summary>View setup details</summary><CommissioningTimeline operation={operation}/></details></Show>
            </div><span class="operation-status">{operation.status}</span></div>
          }</For></section></Show>
          <footer>Local control. Device connections stay active when you close this page.<br/><span>Offline trust snapshot in use. Current certificate revocation freshness is unavailable.</span></footer>
        </main>
      </Show>
    </Show>
    <dialog ref={dialog} aria-labelledby="add-title" onClose={() => setError('')}>
      <div class="dialog-title"><h2 id="add-title">{addLabel()}</h2><button class="text-button" aria-label="Close add device" onClick={() => dialog.close()}>×</button></div>
      <Show when={dialogOperation()} fallback={<>
      <p>{mode() === 'hardware' ? transport() === 'on-network'
        ? 'Keep the device and Photon on the same local network. Generate a fresh Matter sharing code in the app that already controls the device to open its commissioning window.'
        : 'Keep the new device near your hub and put it into pairing mode.' : mode() === 'fake' ? 'This creates a simulated light without contacting hardware. Use test code 34970112332.' : 'Start the Matter simulator and enter its setup code.'}</p>
      <form onSubmit={event => void addDevice(event)}>
        <Show when={mode() === 'hardware'}><label>Connection method<select name="transport" value={transport()} onChange={event => setTransport(event.currentTarget.value as 'ble' | 'on-network')}>
          <option value="ble">New device: Bluetooth + Wi-Fi</option><option value="on-network">Already set up on Wi-Fi</option>
        </select></label></Show>
        <label>Matter setup code<input name="code" required autocomplete="off" inputmode="numeric" placeholder={transport() === 'on-network' && mode() === 'hardware' ? 'Enter a fresh sharing code from the existing app' : 'Enter the code printed on your device'}/></label>
        <Show when={mode() === 'hardware' && transport() === 'ble'}>
          <Show when={savedWifi().saved}><label class="wifi-choice"><input type="checkbox" checked={useSavedWifi()} onChange={event => setUseSavedWifi(event.currentTarget.checked)}/>Use saved Wi-Fi: {savedWifi().ssid}</label>
            <button type="button" class="text-button" disabled={busy()} onClick={() => void forgetWifi()}>Forget saved Wi-Fi</button>
          </Show>
          <Show when={!useSavedWifi()}><label>Wi-Fi name<input name="ssid" required maxLength={32} autocomplete="off"/></label><label>Wi-Fi password<input name="wifiPassword" type="password" maxLength={64} autocomplete="off"/></label>
            <label class="wifi-choice"><input name="rememberWifi" type="checkbox"/>Remember this Wi-Fi on the hub</label>
            <p class="field-help">Optional. Stored in the hub’s protected local data directory and reused without sending the password back to this browser.</p>
          </Show>
          <Show when={savedWifi().importAvailable}><button type="button" class="text-button" disabled={busy()} onClick={event => void importWifi(event.currentTarget.form!)}>Import from Mac Keychain</button><p class="field-help">May ask for macOS permission. Enter the Wi-Fi name first if macOS hides it.</p></Show>
        </Show>
        <label>Country code<input name="country" required pattern="[A-Za-z]{2}" maxLength={2} placeholder="US" autocomplete="country"/></label>
        <p class="field-help">Two-letter country code for the device’s radio configuration.</p>
        <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
        <button class="primary" disabled={busy()}>{busy() ? 'Starting…' : mode() === 'fake' ? 'Simulate connection' : 'Connect device'}</button>
      </form>
      </>}>
        {operation => <section class="setup-progress" aria-live="polite">
          <h3>{operation().status === 'completed' ? mode() === 'fake' ? 'Simulated device added' : 'Device connected' : ['failed', 'interrupted'].includes(operation().status) ? 'Setup not confirmed' : 'Connecting to the device…'}</h3>
          <p>{operation().progress}</p>
          <CommissioningTimeline operation={operation()}/>
          <Show when={['accepted', 'running'].includes(operation().status)} fallback={
            <button class="primary" onClick={() => operation().status === 'completed' ? dialog.close() : setOnboardingId(undefined)}>{operation().status === 'completed' ? 'Done' : 'Back to setup'}</button>
          }><p class="field-help">You can close this dialog. Photon continues setup in the background; view progress here or in recent activity.</p></Show>
        </section>}
      </Show>
    </dialog>
  </div>;
}

render(() => <App/>, document.getElementById('root')!);
