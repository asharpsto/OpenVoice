import { TUNE_CHANNEL, TUNE_ROUTE } from './channel.js';
import { readPath, specByName, writePath, type TuneSpec } from './registry.js';

/**
 * The tuning harness (SPEC §7): slider overlay, hot reload, write-back.
 *
 * The generic half is this file and the Vite plugin; what is specific to this
 * game lives in `registry.ts`, so the harness stays reusable.
 *
 * Dev only. `main.ts` imports it behind `import.meta.env.DEV`, so it does not
 * reach a production build.
 */

export interface HarnessOptions {
  specs: TuneSpec[];
  /** Called after any change, so the game can rebuild anything derived. */
  onChange?: (spec: TuneSpec) => void;
}

const SAVE_DEBOUNCE_MS = 400;

export function mountTuneHarness(options: HarnessOptions): HTMLElement {
  const { specs } = options;
  const root = document.createElement('div');
  root.id = 'tune-overlay';
  root.innerHTML = `<style>
    #tune-overlay {
      position: fixed; top: 8px; right: 8px; width: 292px; max-height: calc(100vh - 16px);
      overflow-y: auto; z-index: 40; padding: 10px 12px 12px;
      background: rgba(11, 14, 19, .92); border: 1px solid #263041; border-radius: 6px;
      font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e8eef5;
    }
    #tune-overlay.collapsed > *:not(header) { display: none; }
    #tune-overlay header {
      display: flex; justify-content: space-between; align-items: center;
      cursor: pointer; user-select: none; letter-spacing: .08em; text-transform: uppercase;
      color: #8b9bb0; font-size: 10px; padding-bottom: 6px;
    }
    #tune-overlay h3 {
      margin: 10px 0 4px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
      color: #8b9bb0; border-bottom: 1px solid #263041; padding-bottom: 3px;
    }
    #tune-overlay .field { display: grid; grid-template-columns: 1fr 54px; gap: 4px 8px; align-items: center; }
    #tune-overlay .field > label { color: #93a3b8; overflow: hidden; text-overflow: ellipsis; }
    #tune-overlay .field > output { text-align: right; color: #e8eef5; }
    #tune-overlay input[type=range] { grid-column: 1 / -1; width: 100%; accent-color: #ff2e63; margin: 0 0 4px; }
    #tune-overlay .status { margin-top: 8px; color: #5d6b80; min-height: 1.5em; }
    #tune-overlay .status.error { color: #ff2e63; }
  </style>`;

  const header = document.createElement('header');
  header.innerHTML = '<span>Tuning</span><span>[t]</span>';
  header.addEventListener('click', () => root.classList.toggle('collapsed'));
  root.appendChild(header);

  const status = document.createElement('div');
  status.className = 'status';

  const controls = new Map<string, HTMLInputElement>();
  const outputs = new Map<string, HTMLOutputElement>();

  for (const spec of specs) {
    const heading = document.createElement('h3');
    heading.textContent = `${spec.name}.json`;
    root.appendChild(heading);

    for (const field of spec.fields) {
      const key = `${spec.name}.${field.path}`;
      const wrap = document.createElement('div');
      wrap.className = 'field';

      const label = document.createElement('label');
      label.textContent = field.path;
      const output = document.createElement('output');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = String(field.step);
      const current = readPath(spec.raw, field.path);
      input.value = String(current ?? field.min);
      output.textContent = format(current ?? field.min);

      input.addEventListener('input', () => {
        const value = Number(input.value);
        output.textContent = format(value);
        const previous = readPath(spec.raw, field.path);
        writePath(spec.raw, field.path, value);
        try {
          spec.apply();
        } catch (error) {
          // Reject the change rather than run on tuning that will not load.
          if (previous !== undefined) writePath(spec.raw, field.path, previous);
          input.value = String(previous ?? field.min);
          output.textContent = format(previous ?? field.min);
          setStatus(status, String(error), true);
          return;
        }
        setStatus(status, '');
        options.onChange?.(spec);
        scheduleSave(spec, status);
      });

      wrap.append(label, output, input);
      root.appendChild(wrap);
      controls.set(key, input);
      outputs.set(key, output);
    }
  }

  root.appendChild(status);
  document.body.appendChild(root);

  window.addEventListener('keydown', (event) => {
    if (event.key === 't' && !(event.target instanceof HTMLInputElement)) {
      root.classList.toggle('collapsed');
    }
  });

  // Hot reload: someone edited the file in an editor while the game is running.
  if (import.meta.hot) {
    import.meta.hot.on(TUNE_CHANNEL, (payload: { name: string; value: Record<string, unknown> }) => {
      const spec = specByName(payload.name);
      if (!spec) return;
      spec.raw = payload.value;
      try {
        spec.apply();
      } catch (error) {
        setStatus(status, `${payload.name}.json: ${String(error)}`, true);
        return;
      }
      for (const field of spec.fields) {
        const key = `${spec.name}.${field.path}`;
        const value = readPath(spec.raw, field.path);
        if (value === undefined) continue;
        const input = controls.get(key);
        const output = outputs.get(key);
        if (input) input.value = String(value);
        if (output) output.textContent = format(value);
      }
      setStatus(status, `reloaded ${payload.name}.json`);
      options.onChange?.(spec);
    });
  }

  return root;
}

const timers = new Map<string, number>();

/** Write-back, debounced: dragging a slider must not be one request per pixel. */
function scheduleSave(spec: TuneSpec, status: HTMLElement): void {
  const existing = timers.get(spec.name);
  if (existing !== undefined) clearTimeout(existing);
  timers.set(
    spec.name,
    window.setTimeout(() => {
      const body = JSON.stringify(spec.raw, null, 2);
      fetch(`${TUNE_ROUTE}${spec.name}`, { method: 'POST', body })
        .then((response) => {
          setStatus(
            status,
            response.ok ? `saved ${spec.name}.json` : `save failed: ${response.status}`,
            !response.ok,
          );
        })
        .catch((error: unknown) => setStatus(status, `save failed: ${String(error)}`, true));
    }, SAVE_DEBOUNCE_MS),
  );
}

function setStatus(element: HTMLElement, text: string, isError = false): void {
  element.textContent = text;
  element.classList.toggle('error', isError);
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
