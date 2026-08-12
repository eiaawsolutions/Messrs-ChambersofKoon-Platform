# Embedding the enquiry widget on chambersofkoon.com.my

How the intake widget (FR-2.1) gets onto the firm's website, what has to be true on
the platform side first, how the firm approves it before it goes live, and how to take
it off again in one step.

Audience: whoever maintains the firm's WordPress site, plus the EIAAW engineer holding
the platform's environment configuration. The two halves are separated below because
they are usually two different people, and neither should need the other's access.

---

## 1. What is being installed

One `<script>` tag. It loads a self-contained bundle from the platform which mounts a
launcher button in the bottom-right corner of the page and, when clicked, an enquiry
panel.

The panel opens on **the firm's enquiry form** — name, email, contact number, enquiry
type, an optional message, and the terms and privacy acceptance. It is the same set of
answers the existing Contact Us page requires, and nothing proceeds until they are in.
Only once they are does the assistant start asking about the matter itself, which means
it spends its questions on what happened rather than on details the person has already
typed.

That is the whole reason this can replace the Contact Us page rather than sit alongside
it — see §6.

Things it deliberately does **not** do, because a firm's website is not ours to break:

- It does not load a framework, jQuery, or a stylesheet.
- It renders inside a Shadow DOM, so the site's CSS cannot affect the widget and the
  widget cannot affect the site.
- It does not modify, read or submit any existing form on the page.
- It makes no network request at all until someone clicks the launcher, apart from one
  small cached configuration fetch.
- It sets no cookie. The conversation is held in `sessionStorage` for the tab only, and
  disappears when the tab closes.

Removing the tag removes the widget completely. There is nothing else to uninstall.

---

## 2. Platform side — do this first

The widget will refuse to work until these are set on the platform. This is intentional:
the public enquiry endpoint is the only unauthenticated write surface in the system, so
it is locked to the firm's own origin rather than open to the web.

| Variable                    | Value                                                             | Notes                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WIDGET_ALLOWED_ORIGINS`    | `https://chambersofkoon.com.my,https://www.chambersofkoon.com.my` | Comma-separated, scheme included, no trailing slash. **Both** the apex and `www` forms, or whichever the site does not redirect away from will fail.          |
| `WIDGET_PUBLIC_KEY`         | the value that goes in `data-key`                                 | Not a secret — it is visible in the page source. It stops casual reuse of the endpoint, nothing more; the origin allow-list and rate limits do the real work. |
| `TERMS_URL` / `PRIVACY_URL` | the firm's live policy pages                                      | Served to the widget at runtime, so revising them never requires a website edit.                                                                              |
| `TERMS_VERSION`             | e.g. `2026-08`                                                    | Recorded against every acceptance. **Bump it whenever either policy is revised** — an acceptance is only evidence if it records what was accepted (PDPA s.6). |
| `TURNSTILE_ENABLED`         | `true` in UAT and production                                      | See §3.                                                                                                                                                       |
| `TURNSTILE_SITE_KEY`        | Cloudflare Turnstile site key                                     | Public. Served to the widget at runtime.                                                                                                                      |
| `TURNSTILE_SECRET_KEY`      | `secret://chambersofkoon-prod/prod/TURNSTILE_SECRET_KEY`          | Never a raw value in the environment — see the EIAAW deploy contract.                                                                                         |

The app's own origin (`APP_BASE_URL`) is always permitted, so the preview page in §4
works without listing it.

---

## 3. Cloudflare Turnstile

The bot check is required by FR-2.3. Two keys are involved and they are not
interchangeable:

- The **site key** is public, goes to the browser, and is served to the widget by the
  platform. Nothing needs to be pasted into the firm's website for it.
- The **secret key** stays on the server and is resolved from Infisical.

In the Cloudflare dashboard, the Turnstile widget must list **both** the firm's domain
and the platform's own domain in its allowed hostnames — the second is what makes the
approval preview in §4 work.

Set `TURNSTILE_ENABLED=false` only in local development. When it is `true`, the platform
refuses any enquiry turn arriving without a valid token.

**If the enquirer's browser cannot run the challenge** — an extension blocking
Cloudflare, a corporate proxy, an offline moment — the widget does not fail silently and
does not dead-end them. It says the security check could not be completed and links to
`/enquiry`, the plain server-rendered form, which has no JavaScript dependency and is
protected by rate limiting and a honeypot instead. Worth knowing before a partner asks
what happens to a client behind a strict corporate firewall.

---

## 4. Approval before go-live

Send the firm this link:

```
https://<app-domain>/preview/widget
```

It is a page on the platform dressed as a firm web page, with the real widget on it,
hitting the real endpoint. It carries the approval checklist and needs no account, so
the partners, the webmaster and any external agency can all review it.

Two things to make clear when sending it:

1. **Enquiries made on the preview are real.** A conversation taken through to the end
   creates an enquiry and notifies the duty lawyer. Agree in advance which test
   enquiries get removed afterwards.
2. Ask them to try it on a phone as well as a desktop browser. The panel goes
   full-screen below 480px and that is the version most enquirers will see.

Do not proceed to §5 without a written approval from the firm.

---

## 5. WordPress installation

The snippet, with the real values substituted:

```html
<script src="https://<app-domain>/widget.js" data-key="<public-key>" defer></script>
```

It belongs immediately before the closing `</body>` tag, on every page. Pick **one** of
the following — doing two will not mount the widget twice (the bundle guards against
that), but it makes the tag harder to find and remove later.

### Option A — a code-snippets plugin (recommended)

Using **WPCode**, **Code Snippets**, or similar:

1. Add a new snippet, type **HTML Snippet**.
2. Paste the tag.
3. Set location to **Site Wide Footer**.
4. Set it **Active** and save.

Recommended because it survives theme updates and can be switched off from the admin
screen without touching a file — which is also the rollback in §9.

### Option B — theme footer

Only via a **child theme**. Editing the parent theme's `footer.php` means the next theme
update silently removes the widget.

In the child theme's `footer.php`, immediately before `</body>`. Alternatively, in the
child theme's `functions.php`:

```php
add_action( 'wp_footer', function () {
    echo '<script src="https://<app-domain>/widget.js" data-key="<public-key>" defer></script>';
}, 100 );
```

### Option C — page builder

- **Elementor**: Site Settings → Custom Code → new snippet, location **Body — End**.
- **Divi**: Theme Options → Integration → _Add code to the `<body>`_.
- **Astra / GeneratePress / Kadence**: the theme's own hooks panel, `wp_footer`.

### Caching

If the site runs a caching or optimisation plugin (WP Rocket, LiteSpeed, W3 Total
Cache, Autoptimize), after installing:

- Purge the full page cache, or the tag will be missing for cached visitors.
- **Exclude `widget.js` from JavaScript combining, minification and "delay JS until
  interaction"**. Combining rewrites the tag in ways that lose `data-key`; delaying
  execution is harmless but means the launcher appears late.

### Optional per-page attributes

Only if the firm wants them. Everything else comes from the platform.

| Attribute                             | Effect                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `data-office="KL" \| "PJ" \| "IPOH"`  | Routes enquiries from that page to one office. Without it, routing follows the triage classification and falls back to Kuala Lumpur. |
| `data-firm="…"`                       | Overrides the displayed firm name.                                                                                                   |
| `data-terms="…"` / `data-privacy="…"` | Overrides the policy links for that page.                                                                                            |

An attribute set on the tag always wins over the platform's value, so a page pinned to
an office keeps its setting.

---

## 6. Replacing the Contact Us page

The widget's opening screen asks for the same things the Contact Us form asks for, and
records the acceptance with its version — so the old form is no longer the only way in,
and keeping both means two inboxes, two formats, and one of them silently not being
watched.

Two ways to retire it. Pick one and tell the firm which:

**A — Keep the page, replace the form (recommended).** Leave `/contact-us` in the
navigation, keep the address, map, office hours and phone numbers, and delete only the
form. Add a short line in its place — "Send us an enquiry using the button at the bottom
of any page" — and leave the widget to do the rest. Nothing that ranks in search
disappears, and anyone who came for a phone number still finds one.

**B — Point the page at the plain form.** Replace the form with a link to
`https://<app-domain>/enquiry`. This is the same enquiry form, server-rendered, and it
reaches the same queue. Prefer this if the firm wants a page they can link to directly
from a letter or an email signature.

Do not simply delete `/contact-us`. It is linked from directories the firm does not
control, and a 404 on it costs more than the page ever did.

### Before you retire anything

- [ ] The widget's own submissions are arriving in the intake queue — confirm with a test
      enquiry on the preview page (§4), not on the live site.
- [ ] Someone at the firm is still watching wherever the old form's email went, for at
      least one full month. Directory listings and cached pages keep sending to it.
- [ ] The firm's privacy policy describes the widget. It collects the same fields, but a
      policy that only mentions "our contact form" is now describing something that no
      longer exists.
- [ ] `TERMS_VERSION` has been bumped if either policy was revised as part of this. An
      acceptance is only evidence if it records what was accepted.

### What does not change

Enquiries from both routes land in the same queue, carry the same acceptance record, and
are triaged the same way. The firm does not have to choose one; retiring the old form is
about not maintaining two.

---

## 7. Go-live checklist

Work down it. Every item is one someone has previously got wrong.

- [ ] Firm's written approval of the preview received.
- [ ] `WIDGET_ALLOWED_ORIGINS` contains both apex and `www`, with `https://`, no
      trailing slash.
- [ ] `WIDGET_PUBLIC_KEY` in the environment matches `data-key` in the pasted tag
      exactly.
- [ ] `TURNSTILE_ENABLED=true`, site key set, secret key resolving from Infisical.
- [ ] Turnstile dashboard lists the firm's domain **and** the platform domain.
- [ ] `TERMS_URL`, `PRIVACY_URL` point at live pages that return 200.
- [ ] `TERMS_VERSION` matches the currently published policies.
- [ ] Duty-lawyer notification address is correct — a real enquiry is about to arrive.
- [ ] Tag installed site-wide, page cache purged, `widget.js` excluded from JS
      combining.

Then verify on the live site, not on staging:

- [ ] Launcher appears on the home page and on one interior page.
- [ ] Browser console is clean — no CORS error, no CSP violation, no 401/403.
- [ ] A full conversation completes and reaches the handover message.
- [ ] The enquiry appears in the platform's intake queue.
- [ ] The duty lawyer received the notification.
- [ ] Same again on a real phone.
- [ ] Keyboard only: Tab reaches the launcher, Enter opens it, focus stays inside the
      panel, Escape closes it and returns focus to the launcher.

---

## 8. Troubleshooting

| Symptom                                                     | Cause                                              | Fix                                                                                                                                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launcher never appears                                      | Tag not in the rendered HTML                       | View source and search for `widget.js`. Usually a page cache not purged, or a builder snippet left inactive.                                                                           |
| Launcher appears, sending fails, console shows a CORS error | Origin not allow-listed                            | The origin in the console message must appear in `WIDGET_ALLOWED_ORIGINS` character for character. `www` vs apex is the usual culprit.                                                 |
| `401` on send                                               | `data-key` does not match `WIDGET_PUBLIC_KEY`      | Compare both. A JS-combining plugin that rewrote the tag also produces this.                                                                                                           |
| Every send returns the security-check message               | Turnstile enabled but unreachable or misconfigured | Check the site key is served (`/api/public/widget-config`), the domain is listed in the Turnstile dashboard, and no site-wide script blocker is stripping `challenges.cloudflare.com`. |
| `429` after a few messages                                  | Rate limit                                         | Expected under testing: 40 turns per IP per hour, 8 new conversations per IP per day. It resets on its own.                                                                            |
| Widget looks unstyled or oversized                          | Shadow DOM stripped by an optimisation plugin      | Exclude `widget.js` from JS optimisation entirely.                                                                                                                                     |
| Firm name or policy links wrong                             | Platform configuration, not the website            | Fix `FIRM_NAME` / `TERMS_URL` / `PRIVACY_URL` on the platform. The change reaches visitors within five minutes; no website edit.                                                       |

---

## 9. Rollback

Removing the widget is one step and needs no deploy:

- **Option A**: deactivate the snippet in WPCode / Code Snippets.
- **Option B**: remove the tag from the child theme and purge the cache.
- **Option C**: delete the custom-code entry in the builder.

Then purge the page cache. The launcher disappears on the next page load.

To disable it from the platform side instead — useful when the webmaster is unavailable
— clear `WIDGET_ALLOWED_ORIGINS`. The bundle still loads but every enquiry is refused,
which is worse for anyone mid-conversation than removing the tag. Prefer removing the
tag; use this only when you cannot.

In both cases the enquiries already taken are unaffected, and `/enquiry` continues to
work as a linkable form — it is worth putting that URL in the firm's email signatures
regardless of whether the widget is live.
