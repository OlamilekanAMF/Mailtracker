# Mailtrack

Mailtrack is a small, private email-open tracker for a team. It consists of a
Manifest V3 browser extension and a Node.js backend that serves a tracking
pixel and stores email/open events in SQLite.

The extension currently supports Gmail, Outlook, Zoho Mail, and Yahoo Mail.
It is intended for internal use and can be loaded unpacked in Chrome, Edge,
or Brave; it is not a published browser-store extension.

> **Privacy note:** Open tracking is approximate, and tracking people without
> their knowledge may have legal or policy implications. Make sure your use
> follows applicable laws and your organization's policies.

## What it does

1. When you send from a supported webmail compose window, the extension adds a
   1×1 image with a unique ID to the message and registers its metadata with the
   backend.
2. The extension watches the compose window. If it closes, the message is
   marked **Sent**; if it remains open for 20 seconds, it is marked
   **Send not confirmed**.
3. When a recipient's mail client requests the image, the backend records the
   event. Loads from the sender's own compose window (before the send is
   confirmed) and opens within the configured prefetch window are excluded
   from the read count.
4. While a webmail tab is open, `extension/bounce.js` looks for delivery-failure
   notices ("Address not found", "Delivery Status Notification", ...). When one
   names an address you sent to, that email is marked **Bounced** and its
   opens are ignored.
5. The popup shows tracked messages, their status, and recorded opens. Search,
   status filters, and the team-wide view help you find messages.

## Requirements

- Node.js 18 or newer and npm
- Chrome, Edge, or Brave
- A publicly reachable **HTTPS** backend URL for tracking real emails

## Run the backend locally

From the project directory:

```powershell
cd backend
npm install
```

Create `backend/.env` and set a long, random API key. For example, generate one
with Node.js:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Put the generated value in `backend/.env`:

```dotenv
API_KEY=replace-with-your-generated-secret
PORT=3000
DB_PATH=mailtrack.db
PREFETCH_WINDOW_SEC=30
```

Start the backend from the `backend` directory:

```powershell
npm start
```

Check that it is running by opening `http://localhost:3000/health`. A healthy
backend responds with `{"ok":true}`.

Localhost is useful for checking the backend, but recipients cannot load a
pixel from your computer. To test real messages, expose the backend through a
trusted HTTPS tunnel or deploy it to a host that provides HTTPS. Use that
public HTTPS URL in the extension settings.

### Backend environment variables

| Variable | Required | Default | Description |
| --- | :---: | --- | --- |
| `API_KEY` | Yes | — | Shared secret used by the extension to access the API. |
| `PORT` | No | `3000` | HTTP port used by the backend. |
| `DB_PATH` | No | `mailtrack.db` | SQLite database path; relative paths resolve from the backend's working directory. |
| `PREFETCH_WINDOW_SEC` | No | `30` | Opens this soon after sending are classified as likely prefetches and excluded from reads. |
| `PENDING_GRACE_SEC` | No | `120` | If a send is never confirmed, opens start counting after this long. |

Use the same `API_KEY` in each teammate's extension settings. Keep it private:
anyone with this key can use the API, including its team-wide email listing.
Choose persistent storage for the SQLite database when deploying; otherwise,
restarts or redeployments may erase tracking history.

## Load the browser extension

1. Open `chrome://extensions` (or the equivalent extensions page in Edge or
   Brave).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this project's `extension` folder.
4. Open the Mailtrack extension's **Settings**.
5. Enter the backend's public HTTPS URL, the shared API key, and your own email
   address, then choose **Test connection**.
6. Leave **Tracking enabled** checked and save.
7. Reload any webmail tabs that were already open.

Each teammate loads the same `extension` folder and configures the same
backend URL and API key, but enters their own email address. The popup filters
to that owner by default. Turning on **Everyone** requests the team-wide list.

After changing extension files, return to the extensions page and reload the
unpacked extension, then reload your webmail tabs.

## Project layout

```text
backend/
  server.js       Express API, pixel endpoint, and SQLite persistence
  package.json    Backend dependencies and start script
extension/
  manifest.json   Manifest V3 configuration and supported webmail sites
  providers.js    Provider-specific webmail DOM selectors
  content.js      Send detection, pixel insertion, and status tracking
  bounce.js       Detects delivery-failure notices and marks emails Bounced
  background.js   Authenticated requests to the backend
  popup.html      Popup dashboard interface and styles
  popup.js        Dashboard rendering, search, filters, and summary
  options.html    Extension settings interface
  options.js      Save settings and test the connection
```

## API endpoints

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `GET /health` | Public | Backend health check. |
| `GET /p/:id.gif` | Public | Returns the tracking image and records a known ID's open. |
| `POST /api/emails` | API key | Registers an email before it is sent. |
| `POST /api/emails/:id/status` | API key | Updates an email's send status. |
| `GET /api/emails` | API key | Lists the latest tracked emails; accepts an optional `owner` query. |

Authenticated API requests use the `x-api-key` header.

## Known limitations

- **An open is not proof that a person read a message.** Apple Mail Privacy
  Protection, corporate gateways, and image proxies may load images
  automatically. Conversely, blocked images can make an opened message appear
  unread. The prefetch window only reduces some automatic-load false positives.
- **Your own Sent-folder views may count as opens.** Mail providers can load
  images through their proxies, so the extension cannot reliably exclude them.
- **Sent is not delivery confirmation.** It means the compose window closed.
  Bounces are detected only while a webmail tab is open and the failure notice
  is visible on screen (Gmail is the most reliable; other providers are best
  effort). Until then a bad address still shows as Sent. Inbox delivery of
  messages that do not bounce cannot be confirmed.
- **Tracking requires HTML and remote-image loading.** Plain-text messages
  cannot carry the pixel, and recipients who block remote images cannot
  generate an open event.
- **Provider integrations depend on webmail page structure.** Selector changes
  can break detection; provider selectors are in `extension/providers.js`.
  Test each provider in your own account, especially Zoho.
- **The popup is manually refreshed.** It fetches the latest list when opened
  or when you choose **Refresh**.
# Mailtracker
