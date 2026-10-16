# Authentication and account access

The public landing page (`/`) and authentication routes (`/login`, `/register`,
`/forgot-password`) implement the Penpot `03 · Authentication` and
`04 · Landing` specifications. Dashboard routes are protected by a client-side
session guard and every API route continues to enforce authorization server-side.

## Supported flows

- Email/password → six-digit email challenge → session
- Email registration → verified email challenge → account + session
- Google OAuth 2.0 Authorization Code flow with state and PKCE
- Iranian mobile (`09…`, `989…`, or `+989…`) → normalized E.164 number → ParsGreen SMS challenge
- Password login for 2FA-enabled accounts → TOTP or one-time recovery code
- Password recovery → email challenge → new password

OTP values are HMAC-protected at rest. Challenge tokens are random and only
their SHA-256 hashes are stored. A new challenge invalidates the previous one,
and expiry, resend cooldown, resend ceiling, and attempt ceiling are all enforced
by the API.

The older direct `/auth/register` and `/auth/login` endpoints remain available
only outside production for existing tests and local tooling; production rejects
them so email OTP or TOTP cannot be bypassed.

## Local setup

1. Copy `.env.example` to `.env` and `backend/.env.example` to
   `backend/.env.local`.
2. Keep `AUTH_DELIVERY_MODE=log` only for local development. The API then
   includes `developmentCode` in challenge responses so the complete flow can be
   tested without sending email or SMS.
3. Start infrastructure and apply migrations:

   ```text
   docker compose -f docker-compose.dev.yml up -d
   cd backend
   npm run db:migrate
   npm run dev
   ```

4. In another terminal, run `npm run dev` from the project root.

## Production delivery

Set `AUTH_DELIVERY_MODE=live`. Production deliberately refuses log-mode OTP
delivery.

Email requires `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
`SMTP_PASSWORD`, and `SMTP_FROM`.

ParsGreen requires `PARSGREEN_SIGNATURE` and `PARSGREEN_FROM`. The provider URL
is configurable through `PARSGREEN_ENDPOINT`; the default targets the ParsGreen
`SendGroupSMS` SOAP service. `sendParsGreenSms()` is also the shared server-side
entry point for other transactional/service notifications. Provider credentials
must never use a `VITE_*` name or enter frontend code.

Google requires a Web OAuth client with:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` registered exactly in Google Cloud
- `FRONTEND_URL` pointing to the deployed SPA origin

The normal production callback is expected to resemble
`https://cloud.example.com/api/v1/auth/google/callback`.

## 2FA lifecycle

Authenticated users can enable or disable TOTP from `/settings`. Setup returns a
Base32 secret and eight one-time recovery codes. Recovery codes are only shown
once and stored as HMAC hashes. Disabling 2FA requires the current password.

## API route summary

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/v1/auth/register/start` | Start verified email registration |
| POST | `/api/v1/auth/login/start` | Validate password and select email/TOTP challenge |
| POST | `/api/v1/auth/phone/start` | Send ParsGreen SMS login challenge |
| POST | `/api/v1/auth/challenge/verify` | Verify email or SMS challenge |
| POST | `/api/v1/auth/challenge/resend` | Resend after server cooldown |
| POST | `/api/v1/auth/2fa/verify` | Verify TOTP login |
| POST | `/api/v1/auth/2fa/recovery` | Consume a recovery code |
| POST | `/api/v1/auth/password/forgot` | Start password recovery |
| POST | `/api/v1/auth/password/reset` | Verify code and replace password |
| GET | `/api/v1/auth/google/start` | Create state/PKCE authorization request |
| GET | `/api/v1/auth/google/callback` | Validate callback and create a session |
