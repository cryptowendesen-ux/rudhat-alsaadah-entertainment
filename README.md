# RUDHAT ALSAADAH ENTERTAINMENT

Website for a children's entertainment centre in Al Majaz 3, Sharjah, UAE.

**Stack:** Node.js + Express, MongoDB Atlas, Cloudinary (images), Resend (email), hosted on Render.

## Features
- Public website (English / Arabic) with services, prices, gallery, birthday package, FAQ and location
- Online birthday booking form saved to MongoDB, with live availability (30-minute slots)
- Email notification to the owner for every new booking; the result (sent / failed) is stored and failed e-mails are retried automatically
- Booking time must be inside the opening hours set in the admin settings, at least a few hours ahead and within one year
- Spam protection: honeypot, rate limits, a limit per phone number, pending requests release their slot after 24 hours, optional Cloudflare Turnstile captcha
- Prepaid Play Cards with QR code (`/card`), time deduction and top-up in the admin
- Closed days (holidays, maintenance): customers cannot book them and the site shows "Closed today"
- Announcement banner at the top of the website (English + Arabic, optional end date)
- Birthday booking collects the birthday child's name/age, optional allergy note and the parent/guardian declaration
- Day-before WhatsApp reminders: the dashboard lists tomorrow's confirmed parties with a one-tap WhatsApp button
- Staff accounts: the owner signs in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`; staff get their own sign-in and can only handle bookings and play cards
- Owner two-step verification (authenticator app), activity log (who did what, kept 180 days) and a one-click JSON backup download
- Strict Content-Security-Policy: inline scripts only run if their hash is allowed, so injected scripts are blocked
- Anonymous visitor statistics (visits, WhatsApp / call / map taps, booking form opens) - no cookies, no personal data
- Admin dashboard at `/admin/`: services, prices, gallery uploads, birthday package, bookings (pending / confirmed / cancelled) and settings (phone, WhatsApp, opening hours)
- Gallery images are served optimised by Cloudinary (auto format, auto quality, max width 1400px)
- SEO: sitemap, robots.txt, Open Graph, LocalBusiness JSON-LD built from the admin settings

## Run locally
1. Copy `.env.example` to `.env` and fill in the values
2. `npm install`
3. `npm start` then open http://localhost:3000

## Environment variables
| Name | Required | Purpose |
|---|---|---|
| `JWT_SECRET` | yes | Random string, 32+ characters |
| `ADMIN_EMAIL` | yes | Admin login email |
| `ADMIN_PASSWORD` | yes | Admin login password |
| `MONGODB_URI` | yes | MongoDB Atlas connection string |
| `CLOUDINARY_CLOUD_NAME` | yes | Cloudinary account |
| `CLOUDINARY_API_KEY` | yes | Cloudinary account |
| `CLOUDINARY_API_SECRET` | yes | Cloudinary account |
| `NOTIFY_EMAIL` | for email | Inbox that receives booking emails |
| `RESEND_API_KEY` | for email | Resend API key (works on Render free plan) |
| `MAIL_FROM` | no | Sender, default `Rudhat Bookings <onboarding@resend.dev>` |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | no | Alternative to Resend (Gmail SMTP). Render free plan blocks SMTP ports, so this only works on a paid plan or another host |
| `SITE_URL` | no | Public site address used in emails |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | no | Cloudflare Turnstile captcha on the booking form (both needed) |
| `PENDING_HOLD_HOURS` | no | Hours a pending request holds its slot (default 24) |
| `BOOKING_MIN_LEAD_HOURS` | no | Minimum hours before a booking starts (default 3) |
| `BOOKING_MAX_DAYS_AHEAD` | no | How many days ahead customers can book (default 365) |
| `MAX_ACTIVE_PER_PHONE` | no | Open upcoming requests per phone (default 3) |
| `DISABLE_OWNER_2FA` | no | Emergency only: set to `true` to skip the owner's 2-step code (e.g. phone lost), sign in, set it up again, then remove it |
| `TURNSTILE_FAIL_CLOSED` | no | `true` = block bookings if Cloudflare cannot be reached (default: let them through) |
| `WAIVER_REQUIRED` | no | Set to `false` to make the child name and guardian declaration optional on the booking form (default: required) |
| `PRICE_RANGE` | no | `priceRange` in the Google business data (default `AED 20+`) |

If no email settings are present, bookings are still saved and a warning is written to the log.

## Email notes
- Resend free plan without a verified domain can only send to the email address of the Resend account owner. To send to another address, verify a domain in Resend or create the Resend account with that address.
- After changing environment variables on Render, wait for the new deploy to be **Live**.
- Render logs show `Email notifications: ...` on startup and `Booking email SENT` after each booking.

## Deploy (Render)
Push to GitHub; Render builds from the `Dockerfile` (Node 22). Add the environment variables above in Render, then open the service URL.

- Set the Render health check path to `/api/health` (server is alive). `/api/ready` also checks the database and returns 503 when it is down.
- Bookings are protected by a short database lock per day, so two customers cannot take the same slot even if the service runs on several instances.
- Download a backup from the dashboard (Security > Backup) regularly, and make sure MongoDB Atlas backups are on.
- Free plan: the service sleeps when idle, so the first visit after a pause is slow.
