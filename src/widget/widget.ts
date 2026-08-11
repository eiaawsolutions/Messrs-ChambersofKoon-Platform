/**
 * Embeddable intake widget (FR-2.1, FR-2.2).
 *
 * Ships as a single self-contained IIFE served from /widget.js and embedded on
 * chambersofkoon.com.my with one script tag. No site rebuild, no framework, no
 * external requests.
 *
 * Everything renders inside a Shadow DOM so the firm's site CSS cannot break
 * the widget and the widget cannot leak styles into the firm's site — the
 * failure mode that makes embedded chat look broken on half the pages it is
 * dropped onto.
 *
 * Accessibility (NFR-5.1, WCAG 2.1 AA): the launcher is a real button, the
 * panel is a labelled dialog, focus is trapped while open and restored on
 * close, Escape closes, and replies are announced through an aria-live region.
 */

interface WidgetConfig {
  apiBase: string;
  publicKey: string;
  turnstileSiteKey: string | null;
  firmName: string;
  /**
   * Office to route the enquiry to. Set per embed when a page belongs to one
   * office; without it the platform routes on the triage classification alone
   * and falls back to Kuala Lumpur.
   */
  office: string | null;
}

interface TurnResponse {
  /** Null once the enquiry has been handed to a lawyer; the session is over. */
  sessionToken: string | null;
  reply: string;
  complete: boolean;
}

/** What is kept between reloads: the token and when it was last used. */
interface StoredSession {
  token: string;
  lastActivity: number;
}

(function initWidget(): void {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;

  const src = new URL(script.src, window.location.href);
  const config: WidgetConfig = {
    apiBase: src.origin,
    publicKey: script.dataset.key ?? '',
    turnstileSiteKey: script.dataset.turnstile ?? null,
    firmName: script.dataset.firm ?? 'Chambers of Koon',
    office: script.dataset.office ?? null,
  };

  const STORAGE_KEY = 'cok_intake_session_v2';
  /** The v1 key lived in localStorage forever. Purged on sight; see below. */
  const LEGACY_STORAGE_KEY = 'cok_intake_session';
  const MOUNT_ID = 'cok-intake-widget';

  /**
   * Client-side session lifetime, matching SESSION_IDLE_WINDOW_MINUTES on the
   * server. The server is the authority — this only avoids sending a token
   * that is certain to be refused.
   */
  const SESSION_IDLE_WINDOW_MS = 120 * 60 * 1000;

  if (document.getElementById(MOUNT_ID)) return; // never mount twice

  /**
   * Why sessionStorage and not localStorage.
   *
   * The token says "append to that conversation". Held in localStorage it
   * outlives the enquiry, the tab and the person: a second enquirer on a
   * shared machine — or the same person back months later with an unrelated
   * matter — sent their first message into someone else's transcript, and the
   * lawyer received one brief describing two enquiries. sessionStorage is
   * scoped to the tab and cleared when it closes, which is the honest lifetime
   * of a single enquiry. The idle stamp handles a tab left open all day.
   */
  function readSession(): string | null {
    try {
      // Retire any v1 token still sitting in localStorage from before the fix.
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);

      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const stored = JSON.parse(raw) as Partial<StoredSession>;
      if (typeof stored.token !== 'string' || typeof stored.lastActivity !== 'number') return null;
      if (Date.now() - stored.lastActivity > SESSION_IDLE_WINDOW_MS) {
        window.sessionStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return stored.token;
    } catch {
      // Private browsing, blocked storage or malformed JSON: the conversation
      // simply does not resume across reloads. Not worth failing over.
      return null;
    }
  }

  function writeSession(token: string | null): void {
    try {
      if (token === null) {
        window.sessionStorage.removeItem(STORAGE_KEY);
        return;
      }
      const stored: StoredSession = { token, lastActivity: Date.now() };
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      /* storage blocked; conversation continues in-memory */
    }
  }

  let sessionToken: string | null = readSession();
  let open = false;
  let sending = false;
  /** True once the firm has the enquiry: nothing more may be added to it. */
  let handedOver = false;
  let lastFocused: Element | null = null;

  const host = document.createElement('div');
  host.id = MOUNT_ID;
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;right:0;';
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
<style>
  :host, * { box-sizing: border-box; }
  .wrap {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 15px; line-height: 1.55; color: #131a24;
  }
  .launcher {
    position: fixed; right: 20px; bottom: 20px;
    display: inline-flex; align-items: center; gap: 10px;
    padding: 13px 20px; border: none; border-radius: 999px;
    background: #1f4460; color: #fff; font: inherit; font-weight: 500;
    cursor: pointer; box-shadow: 0 6px 20px rgba(19,26,36,.22);
    transition: background-color .15s ease, transform .15s ease;
  }
  .launcher:hover { background: #17364d; }
  .launcher:active { transform: translateY(1px); }
  .launcher:focus-visible { outline: 3px solid #a9772e; outline-offset: 3px; }
  .launcher[hidden] { display: none; }

  .panel {
    position: fixed; right: 20px; bottom: 20px;
    width: min(400px, calc(100vw - 32px));
    height: min(600px, calc(100vh - 40px));
    display: flex; flex-direction: column;
    background: #fbfaf7; border: 1px solid #e2ded5; border-radius: 10px;
    box-shadow: 0 12px 44px rgba(19,26,36,.24); overflow: hidden;
  }
  .panel[hidden] { display: none; }

  header {
    padding: 16px 18px; background: #fff;
    border-bottom: 2px solid #a9772e;
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  }
  .title { font-family: Georgia, "Times New Roman", serif; font-size: 17px; margin: 0; }
  .sub { margin: 3px 0 0; font-size: 12.5px; color: #5a6472; }
  .close {
    flex: none; border: none; background: transparent; cursor: pointer;
    font-size: 22px; line-height: 1; color: #5a6472; padding: 2px 6px; border-radius: 4px;
  }
  .close:hover { background: #f3f1ec; color: #131a24; }
  .close:focus-visible { outline: 2px solid #1f4460; outline-offset: 1px; }

  .log { flex: 1; overflow-y: auto; padding: 16px 18px; }
  .msg { margin: 0 0 12px; padding: 10px 13px; border-radius: 10px; max-width: 88%; white-space: pre-wrap; }
  .msg.bot { background: #fff; border: 1px solid #e2ded5; border-bottom-left-radius: 3px; }
  .msg.me { background: #1f4460; color: #fff; margin-left: auto; border-bottom-right-radius: 3px; }
  .typing { color: #8d95a1; font-style: italic; font-size: 13.5px; margin: 0 0 12px; }

  form { display: flex; gap: 8px; padding: 12px; background: #fff; border-top: 1px solid #e2ded5; }
  textarea {
    flex: 1; resize: none; font: inherit; padding: 9px 11px;
    border: 1px solid #cec8ba; border-radius: 5px; background: #fff; color: #131a24;
    max-height: 120px; min-height: 42px;
  }
  textarea:focus { outline: 2px solid #1f4460; outline-offset: -1px; border-color: #1f4460; }
  .send {
    flex: none; padding: 0 16px; border: none; border-radius: 5px;
    background: #1f4460; color: #fff; font: inherit; font-weight: 500; cursor: pointer;
  }
  .send:disabled { opacity: .5; cursor: not-allowed; }
  .send:focus-visible { outline: 3px solid #a9772e; outline-offset: 2px; }

  form[hidden] { display: none; }

  .note { padding: 0 18px 12px; margin: 0; font-size: 11.5px; color: #8d95a1; }

  .handover { padding: 14px 18px 16px; background: #fff; border-top: 1px solid #e2ded5; }
  .handover[hidden] { display: none; }
  .handover p { margin: 0 0 10px; font-size: 13px; color: #5a6472; }
  .restart {
    width: 100%; padding: 10px 14px; border: 1px solid #1f4460; border-radius: 5px;
    background: #fff; color: #1f4460; font: inherit; font-weight: 500; cursor: pointer;
  }
  .restart:hover { background: #f3f6f8; }
  .restart:focus-visible { outline: 3px solid #a9772e; outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  @media (max-width: 480px) {
    .panel { right: 8px; left: 8px; bottom: 8px; width: auto; height: calc(100vh - 16px); }
    .launcher { right: 12px; bottom: 12px; }
  }
</style>

<div class="wrap">
  <button class="launcher" type="button" aria-haspopup="dialog">
    <span aria-hidden="true">&#9993;</span>
    <span>Make an enquiry</span>
  </button>

  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="cok-title" hidden>
    <header>
      <div>
        <h2 class="title" id="cok-title">Enquiry</h2>
        <p class="sub">${escapeHtml(config.firmName)}</p>
      </div>
      <button class="close" type="button" aria-label="Close enquiry panel">&times;</button>
    </header>

    <div class="log" role="log" aria-live="polite" aria-atomic="false"></div>

    <form>
      <label class="sr" for="cok-input" style="position:absolute;left:-9999px;">Your message</label>
      <textarea id="cok-input" rows="1" placeholder="Tell us what has happened…"
        autocomplete="off"></textarea>
      <button class="send" type="submit">Send</button>
    </form>
    <div class="handover" hidden>
      <p>
        This enquiry is now with the firm and nothing further can be added to it. If you have a
        separate matter, you can start a new enquiry.
      </p>
      <button class="restart" type="button">Start a new enquiry</button>
    </div>

    <p class="note">
      We cannot give legal advice here. Nothing you send creates a solicitor-client relationship.
    </p>
  </div>
</div>`;

  document.body.appendChild(host);

  const launcher = root.querySelector('.launcher') as HTMLButtonElement;
  const panel = root.querySelector('.panel') as HTMLElement;
  const closeBtn = root.querySelector('.close') as HTMLButtonElement;
  const log = root.querySelector('.log') as HTMLElement;
  const form = root.querySelector('form') as HTMLFormElement;
  const input = root.querySelector('textarea') as HTMLTextAreaElement;
  const sendBtn = root.querySelector('.send') as HTMLButtonElement;
  const handoverBox = root.querySelector('.handover') as HTMLElement;
  const restartBtn = root.querySelector('.restart') as HTMLButtonElement;

  function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => {
      const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return map[c] ?? c;
    });
  }

  function addMessage(text: string, who: 'bot' | 'me'): void {
    const el = document.createElement('p');
    el.className = `msg ${who}`;
    // textContent, never innerHTML — model output is untrusted at render time
    // just as user input is (OWASP LLM02: insecure output handling).
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function setTyping(on: boolean): void {
    const existing = root.querySelector('.typing');
    if (on && !existing) {
      const el = document.createElement('p');
      el.className = 'typing';
      el.textContent = 'Typing…';
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    } else if (!on && existing) {
      existing.remove();
    }
  }

  function focusables(): HTMLElement[] {
    return Array.from(
      panel.querySelectorAll<HTMLElement>('button, textarea, [href], input, select'),
    ).filter((el) => !el.hasAttribute('disabled') && !el.closest('[hidden]'));
  }

  function greet(): void {
    addMessage(
      `Hello. I can take some details about your matter so the right lawyer at ${config.firmName} ` +
        `can help. What has happened?`,
      'bot',
    );
  }

  /**
   * The enquiry has reached a lawyer. Close the composer rather than leaving
   * it open: a reply typed after the handover would have opened a second
   * enquiry the person did not know they were making, and before the session
   * fix it silently joined itself to the finished one instead.
   */
  function markHandedOver(): void {
    handedOver = true;
    sessionToken = null;
    writeSession(null);
    form.hidden = true;
    handoverBox.hidden = false;
    restartBtn.focus();
  }

  function restart(): void {
    handedOver = false;
    sessionToken = null;
    writeSession(null);
    log.replaceChildren();
    handoverBox.hidden = true;
    form.hidden = false;
    greet();
    input.focus();
  }

  function openPanel(): void {
    if (open) return;
    open = true;
    lastFocused = document.activeElement;
    panel.hidden = false;
    launcher.hidden = true;
    (handedOver ? restartBtn : input).focus();

    if (log.childElementCount === 0) greet();
  }

  function closePanel(): void {
    if (!open) return;
    open = false;
    panel.hidden = true;
    launcher.hidden = false;
    (lastFocused instanceof HTMLElement ? lastFocused : launcher).focus();
  }

  launcher.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);
  restartBtn.addEventListener('click', restart);

  // Escape closes; Tab is trapped inside the dialog while it is open.
  root.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
      return;
    }
    if (e.key !== 'Tab') return;

    const items = focusables();
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = root.activeElement as HTMLElement | null;

    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // Enter sends; Shift+Enter adds a newline.
  input.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });

  async function turnstileToken(): Promise<string | undefined> {
    const w = window as unknown as {
      turnstile?: { execute: (a: unknown, b: unknown) => Promise<string> };
    };
    if (!config.turnstileSiteKey || !w.turnstile) return undefined;
    try {
      return await w.turnstile.execute(undefined, { sitekey: config.turnstileSiteKey });
    } catch {
      return undefined;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message || sending || handedOver) return;

    sending = true;
    sendBtn.disabled = true;
    addMessage(message, 'me');
    input.value = '';
    input.style.height = 'auto';
    setTyping(true);

    try {
      const response = await fetch(`${config.apiBase}/api/public/enquiry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-widget-key': config.publicKey },
        body: JSON.stringify({
          sessionToken: sessionToken ?? undefined,
          message,
          turnstileToken: await turnstileToken(),
          ...(config.office ? { office: config.office } : {}),
        }),
      });

      setTyping(false);

      if (!response.ok) {
        addMessage(
          response.status === 429
            ? 'We have received a lot of messages from this connection. Please try again shortly, ' +
                'or call the office if it is urgent.'
            : 'Sorry — that did not go through. Please try again, or call the office.',
          'bot',
        );
        return;
      }

      const data = (await response.json()) as TurnResponse;

      // The server is authoritative about which conversation this is. It
      // returns a fresh token whenever it decided the presented one could not
      // continue — a handed-over or long-idle enquiry — so the browser's copy
      // is always replaced rather than kept alongside.
      sessionToken = data.sessionToken ?? null;
      writeSession(sessionToken);

      addMessage(data.reply, 'bot');
      if (data.complete) markHandedOver();
    } catch {
      setTyping(false);
      addMessage(
        'Sorry — we could not reach the firm just now. Please try again, or call the office.',
        'bot',
      );
    } finally {
      sending = false;
      sendBtn.disabled = false;
      // Never back into the composer once it has been closed — markHandedOver
      // has already moved focus to the only control still available.
      if (!handedOver) input.focus();
    }
  });
})();
