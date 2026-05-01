# Live Location Tracker

Real-time location sharing app where authenticated users publish their browser location over Socket.IO, the server writes every valid update to Kafka, a socket consumer broadcasts Kafka events back to clients, and a separate database processor consumes the same topic for location history persistence.

## Tech Stack

- Node.js + Express
- Socket.IO
- Apache Kafka through KafkaJS
- OIDC/OAuth 2.0 style auth-code flow with PKCE
- Optional Google OAuth 2.0 sign in as an upstream identity provider
- RS256 JWT access token / ID token
- Leaflet + OpenStreetMap tiles
- JSON file storage for demo users and JSONL history for the database processor simulation

## Project Structure

```text
live_location_tracker/
  docker-compose.yml          # Local Kafka broker
  package.json                # Commands and dependencies
  .env.example                # Required environment variables
  public/index.html           # Leaflet UI and OAuth client
  src/server.js               # Express, OIDC endpoints, Socket.IO, Kafka producer and socket broadcaster consumer
  src/database-processor.js   # Separate Kafka consumer group for persistence/logging
  src/kafka-admin.js          # Creates location-updates topic
  src/kafka-client.js         # KafkaJS client
  src/auth-store.js           # Demo user store and auth-code store
  src/google-oauth.js         # Google OAuth start/callback helpers
  src/oidc.js                 # Discovery, JWKS, token signing and verification
  src/location-events.js      # Validation and duplicate-event handling
  data/                       # Runtime users/history files, ignored by git
```

## Setup Steps

Commands used for this project:

```bash
cd /home/raghav/workspace/web_dev_cohort26
mkdir -p live_location_tracker/src live_location_tracker/public live_location_tracker/data
cd live_location_tracker
npm install
cp .env.example .env
npm run infra:up
npm run kafka:setup
npm run dev
```

In a second terminal:

```bash
cd /home/raghav/workspace/web_dev_cohort26/live_location_tracker
npm run processor
```

Open:

```text
http://localhost:8000
```

For a two-user demo, open the app in two different browsers or one normal window plus one private/incognito window, create two accounts, and start sharing in both.

Google OAuth is optional. The local email/password auth works without Google credentials. To enable the Google button, fill `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in `.env`, then restart `npm run dev`.

## Environment Variables

Copy `.env.example` to `.env`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Express and Socket.IO port | `8000` |
| `PUBLIC_BASE_URL` | Browser-visible app origin | `http://localhost:8000` |
| `KAFKA_CLIENT_ID` | KafkaJS client ID | `live-location-tracker` |
| `KAFKA_BROKERS` | Comma-separated Kafka brokers | `localhost:9092` |
| `KAFKA_LOCATION_TOPIC` | Location event topic | `location-updates` |
| `KAFKA_SSL` | Enable TLS for managed Kafka | `false` |
| `KAFKA_USERNAME` | Managed Kafka SASL username/API key | empty |
| `KAFKA_PASSWORD` | Managed Kafka SASL password/API secret | empty |
| `KAFKA_SASL_MECHANISM` | Kafka SASL mechanism | `plain` |
| `OIDC_ISSUER` | JWT issuer claim | `http://localhost:8000` |
| `OIDC_CLIENT_ID` | Browser OAuth client ID | `live-location-web` |
| `OIDC_REDIRECT_URI` | OAuth callback URI | `http://localhost:8000/callback` |
| `TOKEN_TTL_SECONDS` | Token lifetime | `3600` |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID | empty |
| `GOOGLE_CLIENT_SECRET` | Google OAuth web client secret | empty |
| `GOOGLE_REDIRECT_URI` | Google callback registered in Google Cloud | `http://localhost:8000/auth/google/callback` |
| `LOCATION_UPDATE_INTERVAL_MS` | Browser send interval | `5000` |
| `STALE_USER_AFTER_MS` | Remove offline users after this time | `30000` |
| `MAX_LOCATION_ACCURACY_METERS` | Reject low-quality location payloads | `1000` |
| `LOCATION_HISTORY_FILE` | JSONL history output | `./data/location-history.jsonl` |

## OIDC Auth Setup

This project includes a development OIDC/OAuth provider in `src/server.js` and `src/oidc.js`.

- Discovery: `GET /.well-known/openid-configuration`
- JWKS: `GET /.well-known/jwks.json`
- Authorization endpoint: `GET /oauth/authorize`
- Token endpoint: `POST /oauth/token`
- Userinfo endpoint: `GET /oauth/userinfo`

The browser generates a PKCE verifier and challenge. On sign in or sign up, the server creates a short-lived authorization code. The browser is redirected to `/callback?code=...&state=...`, checks state, exchanges the code plus verifier at `/oauth/token`, stores the returned bearer token, and then calls `/oauth/userinfo`.

Socket.IO receives the same bearer token in the handshake:

```js
io({ auth: { token } });
```

The server verifies the RS256 token before accepting the socket. Location events use `claims.sub` as `userId`; the socket ID is only metadata.

## Google OAuth 2.0 Setup

The app can also use Google as an upstream OAuth/OIDC provider. Google proves the user's identity, then this backend creates or finds a local app user and issues the same app-owned RS256 token used by Socket.IO.

Steps:

1. Go to Google Cloud Console.
2. Create or select a project.
3. Configure the OAuth consent screen.
4. Create OAuth client credentials with application type `Web application`.
5. Add this authorized redirect URI:

```text
http://localhost:8000/auth/google/callback
```

6. Put the credentials in `.env`:

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:8000/auth/google/callback
```

7. Restart the app server:

```bash
npm run dev
```

Google sign-in flow:

1. Browser creates local OAuth `state`, PKCE verifier, and challenge.
2. Browser opens `/auth/google/start?...`.
3. Server creates its own Google PKCE verifier and redirects to Google.
4. Google redirects back to `/auth/google/callback`.
5. Server exchanges the Google code for Google tokens and calls Google userinfo.
6. Server upserts a local user with `provider: "google"` and the Google `sub`.
7. Server creates a local authorization code and redirects to `/callback`.
8. Browser exchanges that local code at `/oauth/token`.
9. Browser connects Socket.IO with the app token.

This keeps the socket server independent from Google tokens. Socket.IO only trusts tokens issued by this backend, so every location event still has a stable local `userId`.

## Deployment on Render

Recommended deployment shape:

- Render Web Service for `src/server.js`
- Render Background Worker for `src/database-processor.js`
- Managed Kafka from Confluent Cloud, Aiven, Redpanda Cloud, Upstash Kafka, or another provider

Do not use the local `docker-compose.yml` Kafka broker on Render. It is only for local development.

### Managed Kafka

Create a Kafka cluster with your provider and create this topic:

```text
location-updates
```

Use 3 partitions for a realistic demo. Copy the provider's bootstrap server, username/API key, and password/API secret into Render env vars.

For most managed Kafka providers:

```env
KAFKA_SSL=true
KAFKA_USERNAME=your-provider-api-key
KAFKA_PASSWORD=your-provider-api-secret
KAFKA_SASL_MECHANISM=plain
```

Some providers use a different SASL mechanism such as `scram-sha-256` or `scram-sha-512`. Use exactly what the provider gives you.

### Render Web Service

Create a new Render Web Service from the Git repo.

Use these settings:

```text
Root Directory: live_location_tracker
Build Command: npm install
Start Command: npm run start
```

Render provides `PORT` automatically. The app also reads `RENDER_EXTERNAL_URL`, but setting the public URLs explicitly is clearer for demos.

Web Service environment variables:

```env
NODE_ENV=production

PUBLIC_BASE_URL=https://your-app-name.onrender.com

OIDC_ISSUER=https://your-app-name.onrender.com
OIDC_CLIENT_ID=live-location-web
OIDC_REDIRECT_URI=https://your-app-name.onrender.com/callback
TOKEN_TTL_SECONDS=3600

GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=https://your-app-name.onrender.com/auth/google/callback

KAFKA_CLIENT_ID=live-location-tracker
KAFKA_BROKERS=your-managed-kafka-bootstrap-host:9092
KAFKA_LOCATION_TOPIC=location-updates
KAFKA_SSL=true
KAFKA_USERNAME=your-kafka-username-or-api-key
KAFKA_PASSWORD=your-kafka-password-or-api-secret
KAFKA_SASL_MECHANISM=plain

LOCATION_UPDATE_INTERVAL_MS=5000
STALE_USER_AFTER_MS=30000
MAX_LOCATION_ACCURACY_METERS=1000
LOCATION_HISTORY_FILE=./data/location-history.jsonl
```

If your Kafka provider gives multiple bootstrap servers, put them in one comma-separated value:

```env
KAFKA_BROKERS=broker-1:9092,broker-2:9092,broker-3:9092
```

### Render Background Worker

Create a Render Background Worker from the same repo.

Use these settings:

```text
Root Directory: live_location_tracker
Build Command: npm install
Start Command: npm run processor
```

Worker environment variables:

```env
NODE_ENV=production

KAFKA_CLIENT_ID=live-location-tracker-processor
KAFKA_BROKERS=your-managed-kafka-bootstrap-host:9092
KAFKA_LOCATION_TOPIC=location-updates
KAFKA_SSL=true
KAFKA_USERNAME=your-kafka-username-or-api-key
KAFKA_PASSWORD=your-kafka-password-or-api-secret
KAFKA_SASL_MECHANISM=plain

LOCATION_HISTORY_FILE=./data/location-history.jsonl
```

The worker uses consumer group `database-processor`, so it consumes the same Kafka topic independently from the socket broadcaster consumer.

### Google OAuth on Render

After Render gives the web service URL, add this exact redirect URI in Google Cloud Console:

```text
https://your-app-name.onrender.com/auth/google/callback
```

Then make these Render env vars match exactly:

```env
PUBLIC_BASE_URL=https://your-app-name.onrender.com
OIDC_ISSUER=https://your-app-name.onrender.com
OIDC_REDIRECT_URI=https://your-app-name.onrender.com/callback
GOOGLE_REDIRECT_URI=https://your-app-name.onrender.com/auth/google/callback
```

### Deployment Limitations

- The demo user store uses `data/users.json`, which is ephemeral on Render unless a persistent disk is attached.
- The JSONL location history is also ephemeral unless a persistent disk is attached.
- For a production deployment, move users and location history to Postgres or another database.
- With multiple web service instances, Socket.IO needs a shared adapter such as Redis. Keep one web instance for this classroom demo.

## Socket Event Flow

1. User logs in and the browser stores a bearer token.
2. Browser connects to Socket.IO with `auth.token`.
3. Server verifies the token and attaches claims to the socket.
4. User clicks `Start sharing`.
5. Browser asks for geolocation permission.
6. Browser emits `client:location:update` every `LOCATION_UPDATE_INTERVAL_MS`.
7. Server validates latitude, longitude, accuracy, and duplicate `eventId`.
8. Server publishes the normalized event to Kafka.
9. Socket broadcaster consumer reads Kafka and emits `server:location:update`.
10. Browser creates or moves Leaflet markers.

Handled socket events:

- `client:location:update`
- `server:location:update`
- `server:active-users`
- `server:user:online`
- `server:user:offline`
- `server:user:stale`
- `server:location:error`

## Kafka Event Flow

Topic:

```text
location-updates
```

Producer:

- `src/server.js`
- Receives authenticated socket events
- Publishes one normalized JSON event per valid location update
- Uses `userId` as the Kafka message key so a user's ordered movement naturally lands in the same partition

Consumer group 1:

```text
socket-broadcaster-8000
```

- Runs inside `src/server.js`
- Consumes `location-updates`
- Broadcasts events to connected Socket.IO clients

Consumer group 2:

```text
database-processor
```

- Runs in `src/database-processor.js`
- Consumes the same `location-updates` topic independently
- Batches events and appends them to `data/location-history.jsonl`

Kafka is part of the actual path. The server does not broadcast directly from the socket handler after receiving the browser event. It publishes to Kafka first, and only the Kafka consumer broadcasts the update.

## Why Kafka Helps Here

Direct database writes on every socket event become expensive because location updates are frequent, bursty, and often redundant. If 10,000 users send a location every 5 seconds, the backend sees 2,000 writes per second before retries, indexes, analytics, or fan-out are considered.

Kafka lets the socket server accept high-throughput events quickly, preserve ordered movement per user key, and let independent consumer groups do different jobs:

- one group fans out fresh positions to live sockets
- one group batches writes for history
- another future group could run trip analytics, alerts, geofencing, or fraud checks

This is similar to rider/customer tracking systems: the live UI needs fresh position events quickly, while historical storage and analytics can be processed asynchronously and in batches.

## Database Processor / Persistence Thinking

The included database processor simulates persistence by writing JSON Lines to:

```text
data/location-history.jsonl
```

It batches up to 25 events or flushes every 5 seconds. In production this would become a real database writer, for example:

- append raw history to a time-series table
- store only latest location in a fast lookup table
- downsample old points for long-term history
- batch inserts instead of doing heavy writes in the socket request path

## Invalid Data, Duplicates, Disconnects, and Stale Users

- Invalid latitude/longitude is rejected.
- Accuracy outside `MAX_LOCATION_ACCURACY_METERS` is rejected.
- Duplicate `userId:eventId` pairs are ignored for 2 minutes.
- Socket authentication failures reject the connection.
- Disconnects emit `server:user:offline`.
- Offline users are removed after `STALE_USER_AFTER_MS` with `server:user:stale`.
- The client removes stale markers from the map.

## Frontend Map Experience

- Leaflet renders the map with OpenStreetMap tiles.
- Current user and other users appear in the visible users list.
- Markers are created once and then moved with `marker.setLatLng(...)`.
- The current user's map is centered after the first location update.
- A second browser window can show live movement from another account.

## Demo Video Link

Add the final unlisted YouTube demo link here before submission:

```text
TODO: https://youtube.com/...
```

Suggested demo checklist:

1. Start Kafka with `npm run infra:up`.
2. Create the Kafka topic with `npm run kafka:setup`.
3. Start the app with `npm run dev`.
4. Start persistence with `npm run processor`.
5. Sign in as two users in separate browser sessions, using either local auth or Google auth.
6. Start location sharing and show markers updating.
7. Show terminal logs proving Kafka consumer and database processor activity.
8. Open `data/location-history.jsonl` to show persisted events.

## Assumptions and Limitations

- This is a classroom/demo OIDC provider. Google OAuth is supported as an upstream provider, but production apps should still harden sessions, secrets, consent configuration, logging, and key rotation.
- RSA keys are generated on server startup, so tokens from an old server process stop working after restart.
- Demo users are stored in `data/users.json`; use Postgres or another real user store in production.
- Browser geolocation requires permission and works best on HTTPS or `localhost`.
- JSONL history simulates persistence. It is intentionally simple so the Kafka flow is easy to inspect.
- OpenStreetMap tiles are loaded from the public CDN, so the browser needs internet access for map tiles.
- Horizontal scaling the socket server would require shared presence state or rooms plus a Socket.IO adapter.
