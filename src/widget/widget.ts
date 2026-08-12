/**
 * Embeddable intake widget (FR-2.1, FR-2.2).
 *
 * Ships as a single self-contained IIFE served from /widget.js and embedded on
 * chambersofkoon.com.my with one script tag. No site rebuild, no framework, no
 * external requests beyond the platform and — only once someone opens the
 * panel — Cloudflare Turnstile.
 *
 * ## Two stages, in this order
 *
 * The panel opens on **the firm's enquiry form**: name, email, contact number,
 * enquiry type, an optional message, and the acceptance tick. Nothing else
 * happens until those are in. Only then does the conversation begin, and the
 * assistant spends its questions on the matter rather than on details the
 * person would have typed in ten seconds.
 *
 * This is the same set of answers the firm's old contact page required, and it
 * is deliberate: an enquiry the firm cannot reply to costs more than no
 * enquiry, because it also consumes a lawyer's attention. The form is checked
 * here for the person's benefit and again on the server for the firm's — see
 * lib/intake/details.ts, which is the authority. This file deliberately does
 * not import it: the widget loads on every page of the firm's site, and
 * pulling zod into that bundle to re-check what the server checks anyway would
 * be paid for by every visitor who never makes an enquiry.
 *
 * ## Shadow DOM
 *
 * Everything renders inside a Shadow DOM so the firm's site CSS cannot break
 * the widget and the widget cannot leak styles into the firm's site — the
 * failure mode that makes embedded chat look broken on half the pages it is
 * dropped onto. The one deliberate exception is the Turnstile container; see
 * mountTurnstile.
 *
 * Accessibility (NFR-5.1, WCAG 2.1 AA): the launcher is a real button, the
 * panel is a labelled dialog, focus is trapped while open and restored on
 * close, Escape closes, every field has a real label, errors are associated
 * with their field through aria-describedby and announced, and replies are
 * announced through an aria-live region.
 */

interface EnquiryTypeOption {
  id: string;
  label: string;
}

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
  /** Where the acceptance line points. Overridable per embed. */
  termsUrl: string;
  privacyUrl: string;
  /** The no-JavaScript form, offered when the widget cannot send. */
  fallbackUrl: string;
  /** The firm's public enquiry types. Replaced by the served list on load. */
  enquiryTypes: EnquiryTypeOption[];
}

/** The subset of the config the platform serves at runtime. */
interface RemoteConfig {
  firmName: string;
  turnstileSiteKey: string | null;
  termsUrl: string;
  privacyUrl: string;
  fallbackUrl: string;
  enquiryTypes: EnquiryTypeOption[];
}

interface TurnResponse {
  /** Null once the enquiry has been handed to a lawyer; the session is over. */
  sessionToken: string | null;
  reply: string;
  complete: boolean;
}

/** A 400 naming the fields the server refused. Codes only, never free text. */
interface FieldErrorResponse {
  error?: string;
  fields?: Record<string, string>;
}

/** What is kept between reloads: the token and when it was last used. */
interface StoredSession {
  token: string;
  lastActivity: number;
}

/** The part of Cloudflare's explicit-rendering API this widget uses. */
interface TurnstileApi {
  render: (
    container: HTMLElement,
    params: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
      execution?: 'render' | 'execute';
      appearance?: 'always' | 'execute' | 'interaction-only';
      size?: 'normal' | 'flexible' | 'compact';
      theme?: 'auto' | 'light' | 'dark';
    },
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

(function initWidget(): void {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;

  const src = new URL(script.src, window.location.href);

  /**
   * Attributes actually present on the embed tag. A page that names its office
   * or overrides a policy URL must keep that value when the served
   * configuration arrives a moment later, so remote values are only applied
   * where the tag said nothing.
   */
  const fromTag = {
    firm: script.dataset.firm,
    turnstile: script.dataset.turnstile,
    terms: script.dataset.terms,
    privacy: script.dataset.privacy,
    fallback: script.dataset.fallback,
  };

  /**
   * The firm's four public enquiry types.
   *
   * Duplicated from lib/intake/enquiry-types.ts as a starting value only —
   * /api/public/widget-config serves the authoritative list and replaces this
   * before anyone can submit. It exists so a visitor whose config fetch is
   * blocked still sees a usable form rather than an empty dropdown, the same
   * arrangement already used for the firm name and the policy links.
   */
  const DEFAULT_ENQUIRY_TYPES: EnquiryTypeOption[] = [
    { id: 'family_matrimonial', label: 'Family and Matrimonial' },
    { id: 'corporate_commercial', label: 'Corporate & Commercial' },
    { id: 'dispute_resolution', label: 'Dispute Resolution' },
    { id: 'property_land', label: 'Property & Land' },
  ];

  const config: WidgetConfig = {
    apiBase: src.origin,
    publicKey: script.dataset.key ?? '',
    turnstileSiteKey: fromTag.turnstile ?? null,
    firmName: fromTag.firm ?? 'Chambers of Koon',
    office: script.dataset.office ?? null,
    termsUrl: safeUrl(fromTag.terms, `${src.origin}/terms-conditions`),
    privacyUrl: safeUrl(fromTag.privacy, `${src.origin}/privacy-policy`),
    fallbackUrl: safeUrl(fromTag.fallback, `${src.origin}/enquiry`),
    enquiryTypes: DEFAULT_ENQUIRY_TYPES,
  };

  /**
   * Only http(s) reaches an href. These come from the embed tag on the firm's
   * own site or from the platform's own configuration endpoint, so this is not
   * the front line — but a mistyped or tampered `data-terms` must not be able
   * to put `javascript:` into a link the enquirer is being asked to click
   * before consenting.
   */
  function safeUrl(value: string | undefined, fallback: string): string {
    if (!value) return fallback;
    try {
      const parsed = new URL(value, window.location.href);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : fallback;
    } catch {
      return fallback;
    }
  }

  const STORAGE_KEY = 'cok_intake_session_v2';
  /** The v1 key lived in localStorage forever. Purged on sight; see below. */
  const LEGACY_STORAGE_KEY = 'cok_intake_session';
  const MOUNT_ID = 'cok-intake-widget';
  const TURNSTILE_MOUNT_ID = 'cok-intake-turnstile';
  const TURNSTILE_SCRIPT_PREFIX = 'https://challenges.cloudflare.com/turnstile/';
  const TURNSTILE_SCRIPT_URL = `${TURNSTILE_SCRIPT_PREFIX}v0/api.js?render=explicit`;

  /** How long to wait for Cloudflare's script before giving up on it. */
  const TURNSTILE_LOAD_TIMEOUT_MS = 10_000;
  /** How long a send waits for a challenge already in flight. */
  const TURNSTILE_TOKEN_TIMEOUT_MS = 8_000;

  /**
   * Client-side session lifetime, matching SESSION_IDLE_WINDOW_MINUTES on the
   * server. The server is the authority — this only avoids sending a token
   * that is certain to be refused.
   */
  const SESSION_IDLE_WINDOW_MS = 120 * 60 * 1000;

  const MAX_MESSAGE_LENGTH = 4000;

  /**
   * The server's rejection codes, in this panel's own words.
   *
   * The server returns a code and never a rendered sentence, so nothing an
   * enquirer typed can be reflected back into the page. The copy here is
   * shorter than the fallback form's for the same code — a 400px panel is not
   * a full-width page, and a wrapped four-line error under a text box reads as
   * a fault rather than a correction.
   */
  const ERROR_COPY: Record<string, string> = {
    name_required: 'Enter your name.',
    name_too_short: 'Enter your full name.',
    email_required: 'Enter an email address.',
    email_invalid: 'Check this email address.',
    phone_required: 'Enter a contact number.',
    phone_invalid: 'Enter a number we can call, including the prefix.',
    type_required: 'Choose the type of enquiry.',
    type_unknown: 'Choose one of the listed types.',
    message_too_long: 'Please shorten this to under 4,000 characters.',
    too_long: 'This is longer than the field allows.',
  };

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
  /** True while the opening form is being submitted. */
  let submitting = false;
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
    height: min(640px, calc(100vh - 40px));
    display: flex; flex-direction: column;
    background: #fbfaf7; border: 1px solid #e2ded5; border-radius: 10px;
    box-shadow: 0 12px 44px rgba(19,26,36,.24); overflow: hidden;
  }
  .panel[hidden] { display: none; }

  header {
    flex: none;
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

  /* ---------- Stage 1: the firm's enquiry form ---------- */
  .details { flex: 1; overflow-y: auto; padding: 16px 18px 18px; display: block; }
  .details[hidden] { display: none; }
  .intro { margin: 0 0 14px; font-size: 13.5px; color: #5a6472; }
  .field { margin: 0 0 12px; }
  .field label { display: block; font-size: 12.5px; font-weight: 600; margin: 0 0 4px; }
  .req { color: #96311f; font-weight: 400; }
  .field input, .field select, .field textarea {
    width: 100%; font: inherit; font-size: 14px; padding: 9px 11px;
    border: 1px solid #cec8ba; border-radius: 5px; background: #fff; color: #131a24;
  }
  .field textarea { resize: vertical; min-height: 72px; max-height: 180px; }
  .field input:focus, .field select:focus, .field textarea:focus {
    outline: 2px solid #1f4460; outline-offset: -1px; border-color: #1f4460;
  }
  .field.bad input, .field.bad select, .field.bad textarea { border-color: #96311f; background: #fdf5f3; }
  .err { margin: 4px 0 0; font-size: 12px; color: #96311f; }
  .err[hidden] { display: none; }
  .optional { font-weight: 400; color: #8d95a1; }

  .submit {
    width: 100%; margin-top: 4px; padding: 11px 16px; border: none; border-radius: 5px;
    background: #a9772e; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
  }
  .submit:hover:not(:disabled) { background: #8d6326; }
  .submit:disabled { opacity: .55; cursor: not-allowed; }
  .submit:focus-visible { outline: 3px solid #1f4460; outline-offset: 2px; }

  .formerr {
    margin: 0 0 12px; padding: 9px 11px; border-radius: 5px;
    background: #fbe9e5; border: 1px solid #e4bcb2; color: #7e2c1c; font-size: 12.5px;
  }
  .formerr[hidden] { display: none; }

  /* ---------- Stage 2: the conversation ---------- */
  .log { flex: 1; overflow-y: auto; padding: 16px 18px; }
  .log[hidden] { display: none; }
  .msg { margin: 0 0 12px; padding: 10px 13px; border-radius: 10px; max-width: 88%; white-space: pre-wrap; }
  .msg.bot { background: #fff; border: 1px solid #e2ded5; border-bottom-left-radius: 3px; }
  .msg.me { background: #1f4460; color: #fff; margin-left: auto; border-bottom-right-radius: 3px; }
  .msg a { color: #1f4460; }
  .typing { color: #8d95a1; font-style: italic; font-size: 13.5px; margin: 0 0 12px; }

  .summary {
    margin: 0 0 14px; padding: 11px 13px; border-radius: 8px;
    background: #fff; border: 1px solid #e2ded5; border-left: 3px solid #2f6d4f;
    font-size: 12.5px; color: #5a6472;
  }
  .summary strong { display: block; color: #131a24; font-size: 13px; margin-bottom: 4px; }
  .summary dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; }
  .summary dt { color: #8d95a1; }
  .summary dd { margin: 0; word-break: break-word; }

  .composer { display: flex; gap: 8px; padding: 12px; background: #fff; border-top: 1px solid #e2ded5; }
  .composer[hidden] { display: none; }
  .composer textarea {
    flex: 1; resize: none; font: inherit; padding: 9px 11px;
    border: 1px solid #cec8ba; border-radius: 5px; background: #fff; color: #131a24;
    max-height: 120px; min-height: 42px;
  }
  .composer textarea:focus { outline: 2px solid #1f4460; outline-offset: -1px; border-color: #1f4460; }
  .send {
    flex: none; padding: 0 16px; border: none; border-radius: 5px;
    background: #1f4460; color: #fff; font: inherit; font-weight: 500; cursor: pointer;
  }
  .send:disabled { opacity: .5; cursor: not-allowed; }
  .send:focus-visible { outline: 3px solid #a9772e; outline-offset: 2px; }

  /* ---------- Consent ---------- */
  .consent {
    display: flex; gap: 9px; align-items: flex-start;
    margin: 14px 0 12px; padding: 11px 12px;
    background: #fff; border: 1px solid #e2ded5; border-radius: 5px;
    font-size: 12px; color: #5a6472; line-height: 1.45;
  }
  .consent input { flex: none; margin: 2px 0 0; width: 16px; height: 16px; accent-color: #1f4460; }
  .consent a { color: #1f4460; }
  .consent.nudge { border-color: #96311f; background: #fdf6ee; animation: nudge .4s ease; }
  @keyframes nudge { 0%,100% { transform: none } 25% { transform: translateX(-3px) } 75% { transform: translateX(3px) } }

  .note { flex: none; padding: 10px 18px 12px; margin: 0; font-size: 11.5px; color: #8d95a1; background: #fbfaf7; }

  .handover { flex: none; padding: 14px 18px 16px; background: #fff; border-top: 1px solid #e2ded5; }
  .handover[hidden] { display: none; }
  .handover p { margin: 0 0 10px; font-size: 13px; color: #5a6472; }
  .restart {
    width: 100%; padding: 10px 14px; border: 1px solid #1f4460; border-radius: 5px;
    background: #fff; color: #1f4460; font: inherit; font-weight: 500; cursor: pointer;
  }
  .restart:hover { background: #f3f6f8; }
  .restart:focus-visible { outline: 3px solid #a9772e; outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
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

    <form class="details" novalidate>
      <p class="intro">
        Please share your details so the right lawyer can follow up.
        Fields marked <span class="req">*</span> are required.
      </p>

      <p class="formerr" role="alert" hidden></p>

      <div class="field" data-field="contactName">
        <label for="cok-name">Your name <span class="req" aria-hidden="true">*</span></label>
        <input id="cok-name" type="text" autocomplete="name" maxlength="200"
          aria-required="true" aria-describedby="cok-name-err">
        <p class="err" id="cok-name-err" hidden></p>
      </div>

      <div class="field" data-field="contactEmail">
        <label for="cok-email">Your email <span class="req" aria-hidden="true">*</span></label>
        <input id="cok-email" type="email" autocomplete="email" maxlength="320"
          aria-required="true" aria-describedby="cok-email-err">
        <p class="err" id="cok-email-err" hidden></p>
      </div>

      <div class="field" data-field="contactPhone">
        <label for="cok-phone">Contact number <span class="req" aria-hidden="true">*</span></label>
        <input id="cok-phone" type="tel" autocomplete="tel" maxlength="40"
          aria-required="true" aria-describedby="cok-phone-err">
        <p class="err" id="cok-phone-err" hidden></p>
      </div>

      <div class="field" data-field="enquiryType">
        <label for="cok-type">Enquiry type <span class="req" aria-hidden="true">*</span></label>
        <select id="cok-type" aria-required="true" aria-describedby="cok-type-err"></select>
        <p class="err" id="cok-type-err" hidden></p>
      </div>

      <div class="field" data-field="message">
        <label for="cok-message">Your message <span class="optional">(optional)</span></label>
        <textarea id="cok-message" rows="3" maxlength="${MAX_MESSAGE_LENGTH}"
          placeholder="Tell us briefly what has happened." aria-describedby="cok-message-err"></textarea>
        <p class="err" id="cok-message-err" hidden></p>
      </div>

      <div class="consent">
        <input type="checkbox" id="cok-consent">
        <label for="cok-consent">
          I accept the
          <a class="terms-link" href="${escapeHtml(config.termsUrl)}" target="_blank" rel="noopener noreferrer">terms &amp; conditions</a>
          and
          <a class="privacy-link" href="${escapeHtml(config.privacyUrl)}" target="_blank" rel="noopener noreferrer">privacy policy</a>.
        </label>
      </div>

      <button class="submit" type="submit">Submit enquiry</button>
    </form>

    <div class="log" role="log" aria-live="polite" aria-atomic="false" hidden></div>

    <form class="composer" hidden>
      <label class="sr" for="cok-input" style="position:absolute;left:-9999px;">Your message</label>
      <textarea id="cok-input" rows="1" placeholder="Type your reply…" autocomplete="off"></textarea>
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
  const detailsForm = root.querySelector('.details') as HTMLFormElement;
  const composer = root.querySelector('.composer') as HTMLFormElement;
  const input = root.querySelector('#cok-input') as HTMLTextAreaElement;
  const sendBtn = root.querySelector('.send') as HTMLButtonElement;
  const submitBtn = root.querySelector('.submit') as HTMLButtonElement;
  const formError = root.querySelector('.formerr') as HTMLElement;
  const handoverBox = root.querySelector('.handover') as HTMLElement;
  const restartBtn = root.querySelector('.restart') as HTMLButtonElement;
  const consentBox = root.querySelector('.consent') as HTMLElement;
  const consentInput = root.querySelector('#cok-consent') as HTMLInputElement;
  const subLabel = root.querySelector('.sub') as HTMLElement;
  const termsLink = root.querySelector('.terms-link') as HTMLAnchorElement;
  const privacyLink = root.querySelector('.privacy-link') as HTMLAnchorElement;
  const typeSelect = root.querySelector('#cok-type') as HTMLSelectElement;

  const nameInput = root.querySelector('#cok-name') as HTMLInputElement;
  const emailInput = root.querySelector('#cok-email') as HTMLInputElement;
  const phoneInput = root.querySelector('#cok-phone') as HTMLInputElement;
  const messageInput = root.querySelector('#cok-message') as HTMLTextAreaElement;

  /** Field name as the server knows it, to the control that holds it. */
  const CONTROLS: Record<string, HTMLElement> = {
    contactName: nameInput,
    contactEmail: emailInput,
    contactPhone: phoneInput,
    enquiryType: typeSelect,
    message: messageInput,
  };

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

  // ---------------------------------------------------------------------------
  // Enquiry type list
  // ---------------------------------------------------------------------------

  /**
   * Options are built with createElement, not innerHTML.
   *
   * The labels arrive over the network. They come from the platform's own
   * configuration endpoint and are the firm's own words, but a list rendered
   * as markup is a list that can carry markup, and there is no reason for this
   * one to be able to.
   */
  function renderEnquiryTypes(): void {
    const previous = typeSelect.value;
    typeSelect.replaceChildren();

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select enquiry type';
    typeSelect.appendChild(placeholder);

    for (const type of config.enquiryTypes) {
      const option = document.createElement('option');
      option.value = type.id;
      option.textContent = type.label;
      typeSelect.appendChild(option);
    }

    // Keep a choice already made when the served list arrives mid-typing.
    if (previous && config.enquiryTypes.some((t) => t.id === previous)) {
      typeSelect.value = previous;
    }
  }

  renderEnquiryTypes();

  /**
   * Runtime configuration, fetched once per page.
   *
   * Applied only where the embed tag was silent, so a page that pins its
   * office or overrides a policy URL keeps what it asked for. Failure is
   * survivable: the built-in defaults already point at the firm's own domain,
   * and a widget with a slightly stale policy link is better than no widget.
   */
  async function loadRemoteConfig(): Promise<void> {
    let remote: Partial<RemoteConfig>;
    try {
      const response = await fetch(`${config.apiBase}/api/public/widget-config`, {
        method: 'GET',
        credentials: 'omit',
      });
      if (!response.ok) return;
      remote = (await response.json()) as Partial<RemoteConfig>;
    } catch {
      return;
    }

    if (fromTag.firm === undefined && typeof remote.firmName === 'string') {
      config.firmName = remote.firmName;
      subLabel.textContent = remote.firmName;
    }
    if (fromTag.turnstile === undefined && typeof remote.turnstileSiteKey === 'string') {
      config.turnstileSiteKey = remote.turnstileSiteKey;
    }
    if (fromTag.terms === undefined && typeof remote.termsUrl === 'string') {
      config.termsUrl = safeUrl(remote.termsUrl, config.termsUrl);
      termsLink.href = config.termsUrl;
    }
    if (fromTag.privacy === undefined && typeof remote.privacyUrl === 'string') {
      config.privacyUrl = safeUrl(remote.privacyUrl, config.privacyUrl);
      privacyLink.href = config.privacyUrl;
    }
    if (fromTag.fallback === undefined && typeof remote.fallbackUrl === 'string') {
      config.fallbackUrl = safeUrl(remote.fallbackUrl, config.fallbackUrl);
    }

    // The served list is authoritative: it is the same source the server
    // validates against, so a widget rendering it can never offer a type that
    // is then refused.
    if (Array.isArray(remote.enquiryTypes) && remote.enquiryTypes.length > 0) {
      const valid = remote.enquiryTypes.filter(
        (t): t is EnquiryTypeOption => typeof t?.id === 'string' && typeof t?.label === 'string',
      );
      if (valid.length > 0) {
        config.enquiryTypes = valid;
        renderEnquiryTypes();
      }
    }
  }

  const configLoaded = loadRemoteConfig();

  function addMessage(text: string, who: 'bot' | 'me'): void {
    const el = document.createElement('p');
    el.className = `msg ${who}`;
    // textContent, never innerHTML — model output is untrusted at render time
    // just as user input is (OWASP LLM02: insecure output handling).
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  /**
   * A refusal the enquirer can act on.
   *
   * Reached when the bot check cannot run at all — Cloudflare blocked by an
   * extension, a corporate proxy, or an offline moment. The server refuses a
   * turn with no token when the check is switched on, so sending anyway would
   * produce a bare failure. The plain form (FR-2.2) has no such dependency, so
   * point at it rather than leaving someone with a real matter stuck at a
   * challenge they cannot pass.
   */
  function fallbackLink(): HTMLAnchorElement {
    const link = document.createElement('a');
    link.href = config.fallbackUrl; // validated by safeUrl
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'enquiry form';
    return link;
  }

  function addFallbackNotice(): void {
    const el = document.createElement('p');
    el.className = 'msg bot';
    el.appendChild(
      document.createTextNode(
        'We could not complete the security check in this browser, so that message was not sent. ' +
          'You can send your enquiry using our ',
      ),
    );
    el.appendChild(fallbackLink());
    el.appendChild(document.createTextNode(' instead, or call the office.'));
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

  // ---------------------------------------------------------------------------
  // Bot check
  // ---------------------------------------------------------------------------

  let turnstileWidgetId: string | undefined;
  let turnstileMount: HTMLElement | null = null;
  let turnstileBootstrap: Promise<boolean> | null = null;
  /** A challenge already solved and not yet spent. Tokens are single-use. */
  let readyToken: string | null = null;
  let tokenWaiters: Array<(token: string | null) => void> = [];

  function turnstileApi(): TurnstileApi | undefined {
    return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
  }

  function settleWaiters(token: string | null): void {
    const waiting = tokenWaiters;
    tokenWaiters = [];
    waiting.forEach((resolve) => resolve(token));
  }

  /**
   * Wait for Cloudflare's API object rather than only for the script's load
   * event: the firm's site may already load Turnstile for its own form, in
   * which case there is a script tag but no load event left to listen for.
   */
  function whenTurnstileApi(timeoutMs: number): Promise<TurnstileApi | undefined> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = (): void => {
        const api = turnstileApi();
        if (api) {
          resolve(api);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(undefined);
          return;
        }
        window.setTimeout(poll, 100);
      };
      poll();
    });
  }

  /**
   * The Turnstile container lives in the light DOM, not the widget's shadow
   * root.
   *
   * Turnstile attaches elements relative to `document` and does not support
   * being rendered inside a shadow root — inside one it fails silently, which
   * would present as every enquiry being refused with no visible cause. It is
   * positioned just above the panel so that on the rare occasion Cloudflare
   * asks for an interaction, the enquirer can see and complete it;
   * `interaction-only` keeps it collapsed and invisible the rest of the time.
   */
  function mountTurnstile(): HTMLElement {
    if (turnstileMount) return turnstileMount;
    const mount = document.createElement('div');
    mount.id = TURNSTILE_MOUNT_ID;
    mount.style.cssText =
      'position:fixed;right:20px;bottom:96px;z-index:2147483001;' +
      'display:flex;justify-content:flex-end;';
    document.body.appendChild(mount);
    turnstileMount = mount;
    return mount;
  }

  /**
   * Load Cloudflare's script and render the widget once, lazily.
   *
   * Deferred until the panel opens: a visitor who never makes an enquiry
   * should not have a third-party script pulled onto the firm's site on their
   * behalf.
   */
  function ensureTurnstile(): Promise<boolean> {
    if (turnstileBootstrap) return turnstileBootstrap;

    turnstileBootstrap = (async (): Promise<boolean> => {
      await configLoaded;
      const siteKey = config.turnstileSiteKey;
      if (!siteKey) return false;

      if (!turnstileApi() && !document.querySelector(`script[src^="${TURNSTILE_SCRIPT_PREFIX}"]`)) {
        const tag = document.createElement('script');
        tag.src = TURNSTILE_SCRIPT_URL;
        tag.async = true;
        tag.defer = true;
        document.head.appendChild(tag);
      }

      const api = await whenTurnstileApi(TURNSTILE_LOAD_TIMEOUT_MS);
      if (!api) return false;

      try {
        turnstileWidgetId = api.render(mountTurnstile(), {
          sitekey: siteKey,
          // Solved while the enquirer is still filling the form, so the first
          // send is not held up by a challenge that could have run already.
          execution: 'render',
          appearance: 'interaction-only',
          size: 'flexible',
          theme: 'light',
          callback: (token: string) => {
            readyToken = token;
            settleWaiters(token);
          },
          'error-callback': () => {
            readyToken = null;
            settleWaiters(null);
          },
          'expired-callback': () => {
            readyToken = null;
            if (turnstileWidgetId !== undefined) {
              try {
                api.reset(turnstileWidgetId);
              } catch {
                /* nothing useful to do; the next send falls back */
              }
            }
          },
        });
      } catch {
        return false;
      }

      return turnstileWidgetId !== undefined;
    })();

    return turnstileBootstrap;
  }

  /**
   * A token that has not been spent, or null.
   *
   * Null means one of two very different things, and the caller distinguishes
   * them by whether a site key is configured: no site key means the server is
   * not checking, so send without one; a site key with no token means the
   * check is on and cannot be satisfied, so do not send at all.
   */
  async function takeToken(): Promise<string | null> {
    if (!(await ensureTurnstile())) return null;

    if (readyToken !== null) {
      const token = readyToken;
      readyToken = null;
      return token;
    }

    return new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (token: string | null): void => {
        if (settled) return;
        settled = true;
        readyToken = null;
        resolve(token);
      };
      tokenWaiters.push(finish);
      window.setTimeout(() => finish(null), TURNSTILE_TOKEN_TIMEOUT_MS);
    });
  }

  /** Spend-and-replace: start the next challenge as soon as one is used. */
  function primeNextToken(): void {
    const api = turnstileApi();
    if (!api || turnstileWidgetId === undefined) return;
    try {
      api.reset(turnstileWidgetId);
    } catch {
      /* the next send falls back to the form */
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 1 — the enquiry form
  // ---------------------------------------------------------------------------

  function fieldWrapper(field: string): HTMLElement | null {
    return root.querySelector(`.field[data-field="${field}"]`);
  }

  function clearFieldErrors(): void {
    formError.hidden = true;
    formError.textContent = '';
    for (const field of Object.keys(CONTROLS)) {
      const wrapper = fieldWrapper(field);
      const message = root.querySelector(`#${CONTROLS[field]?.id}-err`);
      wrapper?.classList.remove('bad');
      CONTROLS[field]?.removeAttribute('aria-invalid');
      if (message instanceof HTMLElement) {
        message.hidden = true;
        message.textContent = '';
      }
    }
    consentBox.classList.remove('nudge');
  }

  /**
   * Show the codes against their fields and move focus to the first one.
   *
   * Focus matters more than it looks: on a phone the panel is scrolled and the
   * offending field is usually off screen, so an error the person cannot see
   * reads as a button that simply does not work.
   */
  function showFieldErrors(fields: Record<string, string>): void {
    clearFieldErrors();
    let first: HTMLElement | null = null;

    // Indexed rather than destructured: the bundle targets Safari 13 for older
    // iPhones, and esbuild cannot downlevel destructuring in a for-of there.
    for (const field of Object.keys(fields)) {
      const code = fields[field] ?? '';
      const control = CONTROLS[field];
      if (!control) continue;
      const wrapper = fieldWrapper(field);
      const message = root.querySelector(`#${control.id}-err`);
      wrapper?.classList.add('bad');
      control.setAttribute('aria-invalid', 'true');
      if (message instanceof HTMLElement) {
        message.textContent = ERROR_COPY[code] ?? 'Please check this.';
        message.hidden = false;
      }
      if (!first) first = control;
    }

    if (first) {
      first.focus();
    } else {
      // A code for a field this panel does not render. Say something true
      // rather than nothing at all.
      formError.textContent = 'Some details need correcting. Please review the form.';
      formError.hidden = false;
    }
  }

  function showFormError(text: string): void {
    formError.textContent = text;
    formError.hidden = false;
    formError.scrollIntoView({ block: 'nearest' });
  }

  /**
   * A first pass, for the person filling the form. Not a security control —
   * lib/intake/details.ts re-checks everything and is the authority. This
   * exists so an obvious omission is caught without a round trip, and so the
   * rules stay loose enough that anything arguable is decided by the server
   * rather than refused here.
   */
  function validateLocally(): Record<string, string> {
    const errors: Record<string, string> = {};
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const phone = phoneInput.value.trim();

    if (name.length === 0) errors.contactName = 'name_required';
    else if (name.length < 2) errors.contactName = 'name_too_short';

    if (email.length === 0) errors.contactEmail = 'email_required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.contactEmail = 'email_invalid';

    if (phone.length === 0) errors.contactPhone = 'phone_required';
    else if (!/^\+?\d{8,15}$/.test(phone.replace(/[\s()./-]/g, '')))
      errors.contactPhone = 'phone_invalid';

    if (typeSelect.value.length === 0) errors.enquiryType = 'type_required';

    if (messageInput.value.trim().length > MAX_MESSAGE_LENGTH) errors.message = 'message_too_long';

    return errors;
  }

  /** What the firm received, shown back so the person can see it landed. */
  function renderSummary(): void {
    const chosen = config.enquiryTypes.find((t) => t.id === typeSelect.value);
    const rows: Array<{ label: string; value: string }> = [
      { label: 'Name', value: nameInput.value.trim().replace(/\s+/g, ' ') },
      { label: 'Email', value: emailInput.value.trim() },
      { label: 'Number', value: phoneInput.value.trim() },
      { label: 'Type', value: chosen?.label ?? typeSelect.value },
    ];

    const box = document.createElement('div');
    box.className = 'summary';

    const heading = document.createElement('strong');
    heading.textContent = 'Enquiry received';
    box.appendChild(heading);

    const list = document.createElement('dl');
    for (const row of rows) {
      const dt = document.createElement('dt');
      dt.textContent = row.label;
      const dd = document.createElement('dd');
      dd.textContent = row.value;
      list.appendChild(dt);
      list.appendChild(dd);
    }
    box.appendChild(list);
    log.appendChild(box);
  }

  function showChatStage(): void {
    detailsForm.hidden = true;
    log.hidden = false;
    composer.hidden = false;
  }

  function showFormStage(): void {
    detailsForm.hidden = false;
    log.hidden = true;
    composer.hidden = true;
    handoverBox.hidden = true;
  }

  detailsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;

    clearFieldErrors();

    const localErrors = validateLocally();
    if (Object.keys(localErrors).length > 0) {
      showFieldErrors(localErrors);
      return;
    }

    // Refuse rather than send and let the server 400 — the enquirer should see
    // why, next to the box they need to tick, not as a failure afterwards.
    if (!consentInput.checked) {
      consentBox.classList.remove('nudge');
      void consentBox.offsetWidth; // reflow, so a second attempt animates again
      consentBox.classList.add('nudge');
      consentInput.focus();
      return;
    }

    submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    try {
      const turnstileToken = await takeToken();

      if (config.turnstileSiteKey && !turnstileToken) {
        showFormError(
          'We could not complete the security check in this browser. Please use our enquiry ' +
            'form instead, or call the office.',
        );
        const link = fallbackLink();
        formError.appendChild(document.createTextNode(' '));
        formError.appendChild(link);
        return;
      }

      const response = await fetch(`${config.apiBase}/api/public/enquiry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-widget-key': config.publicKey },
        body: JSON.stringify({
          details: {
            contactName: nameInput.value,
            contactEmail: emailInput.value,
            contactPhone: phoneInput.value,
            enquiryType: typeSelect.value,
            message: messageInput.value,
          },
          termsAccepted: true as const,
          ...(turnstileToken ? { turnstileToken } : {}),
          ...(config.office ? { office: config.office } : {}),
        }),
      });

      if (response.status === 400) {
        const body = (await response.json().catch(() => ({}))) as FieldErrorResponse;
        if (body.fields && Object.keys(body.fields).length > 0) {
          showFieldErrors(body.fields);
        } else {
          showFormError('Please check the details above and try again.');
        }
        return;
      }

      if (!response.ok) {
        showFormError(
          response.status === 429
            ? 'We have received a lot of enquiries from this connection. Please try again ' +
                'shortly, or call the office if it is urgent.'
            : 'Sorry — that did not go through. Please try again, or call the office.',
        );
        return;
      }

      const data = (await response.json()) as TurnResponse;

      // Rendered before the stage swaps so the panel does not flash an empty
      // transcript on a slow phone.
      renderSummary();
      sessionToken = data.sessionToken ?? null;
      writeSession(sessionToken);
      showChatStage();
      addMessage(data.reply, 'bot');

      if (data.complete) {
        markHandedOver();
      } else {
        input.focus();
      }
    } catch {
      showFormError('Sorry — we could not reach the firm just now. Please try again.');
    } finally {
      submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit enquiry';
      primeNextToken();
    }
  });

  // ---------------------------------------------------------------------------
  // Stage 2 — the conversation
  // ---------------------------------------------------------------------------

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
    composer.hidden = true;
    handoverBox.hidden = false;
    restartBtn.focus();
  }

  /**
   * A fresh enquiry starts at the form again, with an empty consent box.
   *
   * The person at the keyboard may not be the person who accepted last time,
   * and their details belong to the enquiry the firm already holds — carrying
   * either forward would attach one person's consent to another's matter.
   */
  function restart(): void {
    handedOver = false;
    sessionToken = null;
    writeSession(null);
    log.replaceChildren();
    consentInput.checked = false;
    detailsForm.reset();
    renderEnquiryTypes();
    clearFieldErrors();
    showFormStage();
    nameInput.focus();
  }

  function openPanel(): void {
    if (open) return;
    open = true;
    lastFocused = document.activeElement;
    panel.hidden = false;
    launcher.hidden = true;

    if (handedOver) {
      restartBtn.focus();
    } else if (sessionToken) {
      // A reload mid-conversation. The transcript is deliberately not fetched
      // back — that would mean an unauthenticated endpoint reading a family-law
      // conversation out to whoever holds the token — so the panel claims only
      // what this tab knows: that there is something to carry on with. The
      // form is not shown again; those details are already on the enquiry.
      if (log.childElementCount === 0) {
        addMessage('Welcome back. Carry on below when you are ready.', 'bot');
      }
      showChatStage();
      input.focus();
    } else {
      showFormStage();
      nameInput.focus();
    }

    // Start the challenge now so it is solved before the form is submitted.
    void ensureTurnstile();
  }

  function closePanel(): void {
    if (!open) return;
    open = false;
    panel.hidden = true;
    launcher.hidden = false;
    // The Turnstile container is deliberately left mounted and displayed: it
    // is zero-size while collapsed, and hiding it would also hide a challenge
    // Cloudflare had decided to ask for.
    (lastFocused instanceof HTMLElement ? lastFocused : launcher).focus();
  }

  launcher.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);
  restartBtn.addEventListener('click', restart);
  // Ticking it clears the prompt to tick it.
  consentInput.addEventListener('change', () => consentBox.classList.remove('nudge'));

  // Correcting a field clears its error, so the panel stops shouting at
  // someone who is already fixing it.
  for (const field of Object.keys(CONTROLS)) {
    const control = CONTROLS[field];
    if (!control) continue;
    control.addEventListener('input', () => {
      const wrapper = fieldWrapper(field);
      if (!wrapper?.classList.contains('bad')) return;
      wrapper.classList.remove('bad');
      control.removeAttribute('aria-invalid');
      const message = root.querySelector(`#${control.id}-err`);
      if (message instanceof HTMLElement) {
        message.hidden = true;
        message.textContent = '';
      }
    });
  }

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

  // Enter sends; Shift+Enter adds a newline. Only in the composer — Enter in
  // the form's own fields submits it, which is what a form should do.
  input.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });

  composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message || sending || handedOver) return;

    // The conversation cannot start here any more: the form opens the enquiry
    // and mints the session. Without one there is nothing to append to, so
    // send the person back to the form rather than silently dropping it.
    if (!sessionToken) {
      showFormStage();
      showFormError('Please complete your details first.');
      nameInput.focus();
      return;
    }

    sending = true;
    sendBtn.disabled = true;
    addMessage(message, 'me');
    input.value = '';
    input.style.height = 'auto';
    setTyping(true);

    try {
      const turnstileToken = await takeToken();

      // A site key with no token means the check is switched on and this
      // browser cannot satisfy it. The server would refuse the turn, so say
      // something useful here instead of relaying a bare error.
      if (config.turnstileSiteKey && !turnstileToken) {
        setTyping(false);
        addFallbackNotice();
        return;
      }

      const response = await fetch(`${config.apiBase}/api/public/enquiry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-widget-key': config.publicKey },
        body: JSON.stringify({
          sessionToken,
          message,
          ...(turnstileToken ? { turnstileToken } : {}),
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
      // The token just sent is spent, so start earning the next one now.
      primeNextToken();
      // Never back into the composer once it has been closed — markHandedOver
      // has already moved focus to the only control still available.
      if (!handedOver) input.focus();
    }
  });
})();
