# Camera West Trade-In Manager
## Web App Setup Guide — Cloudflare Pages + Magic Link Auth

---

## How it works

```
Staff iPad/browser
  └── cw-tradein.pages.dev
        ├── /              → Login page (enter email)
        ├── /app           → Trade-In Manager (auth required)
        └── /api/*         → Cloudflare Functions (serverless)
              ├── /api/auth/request  → sends magic link email
              ├── /api/auth/verify   → validates token, sets cookie
              ├── /api/auth/session  → checks if logged in
              └── /api/search        → searches Shopify catalog
```

Staff flow:
1. Go to the URL → enter their Camera West email
2. Click the link in their email → they're in for 8 hours
3. Link expires after one use — always fresh and secure

---

## What you need

- A **Cloudflare account** (free) → cloudflare.com
- A **GitHub account** (free) → github.com
- Your Shopify **pre-owned collection ID**
- A Shopify **Admin API token** (from a Custom App)
- About 20 minutes

---

## Step 1 — Get Shopify credentials

### Create app in Shopify Dev Dashboard
1. Go to **partners.shopify.com** (or Shopify Dev Dashboard)
2. **Apps → Create app** → name it `Trade-In Search`
3. **Configure API scopes** → enable `read_products`, `read_collections`, `read_customers`, `write_customers`
4. Set the **App URL** to your Pages URL (e.g. `https://cw-tradein-app.pages.dev`)
5. Set **Allowed redirection URL(s)** to `https://cw-tradein-app.pages.dev/api/auth/shopify-callback`
6. Note your **Client ID** and **Client Secret** (`shpss_...`)

> **Don't install the app from the Partner Dashboard yet.** You'll do that
> through the app's OAuth flow in Step 6 below.

### Collection ID
1. **Shopify Admin → Products → Collections** → click your pre-owned collection
2. Copy the number from the URL: `.../collections/`**`123456789`**

---

## Step 2 — Push to GitHub

1. Go to **github.com → New repository**
   - Name: `cw-tradein-app`
   - Visibility: **Private**
   - Click **Create repository**

2. On your computer, open Terminal:

```bash
# Download and unzip the app files first, then:
cd cw-tradein-webapp

git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/cw-tradein-app.git
git push -u origin main
```

---

## Step 3 — Deploy to Cloudflare Pages

1. Go to **dash.cloudflare.com → Workers & Pages → Create application**
2. Click **Pages → Connect to Git**
3. Connect your GitHub account → select `cw-tradein-app`
4. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `public`
5. Click **Save and Deploy**

Your app will be live at `https://cw-tradein-app.pages.dev`
(you can add a custom domain later, e.g. `tradein.camerawest.com`)

---

## Step 4 — Create the KV Namespace

The app stores auth tokens in Cloudflare KV (key-value store).

1. **Cloudflare Dashboard → Workers & Pages → KV**
2. Click **Create a namespace**
3. Name: `CW_TRADEIN_AUTH`
4. Click **Add**

Now bind it to your Pages project:
1. Go to **Workers & Pages → cw-tradein-app → Settings → Functions**
2. Under **KV namespace bindings**, click **Add binding**
3. Variable name: `AUTH_KV`
4. KV namespace: `CW_TRADEIN_AUTH`
5. Click **Save**

---

## Step 5 — Set Environment Variables

In **Workers & Pages → cw-tradein-app → Settings → Environment variables**:

**Production variables:**

| Variable | Value | Secret? |
|----------|-------|---------|
| `APP_URL` | `https://cw-tradein-app.pages.dev` | No |
| `FROM_EMAIL` | `noreply@camerawest.com` | No |
| `SHOPIFY_STORE` | `camera-west.myshopify.com` | No |
| `SHOPIFY_CLIENT_ID` | Your app's API key | No |
| `SHOPIFY_CLIENT_SECRET` | `shpss_xxxx...` | **Yes — click Encrypt** |
| `COLLECTION_ID` | `123456789` | No |

> **Token management:** The app uses Shopify's offline access tokens, which
> never expire. The token is obtained once during the OAuth install flow
> (Step 6) and stored in KV. No refresh token rotation is needed.

Click **Save and Deploy** — Cloudflare will redeploy automatically.

---

## Step 6 — Connect Shopify via OAuth

Now that the app is deployed with your credentials, complete the Shopify
OAuth install to get an access token:

1. Visit **`https://cw-tradein-app.pages.dev/api/auth/shopify-install`**
2. You'll be redirected to Shopify — log in as the store owner
3. Click **Install app** to approve the permissions
4. Shopify redirects back to your app and stores the access token in KV
5. You should see a **"Shopify Connected Successfully"** page

> If you get an error about redirect URIs, make sure you added
> `https://cw-tradein-app.pages.dev/api/auth/shopify-callback`
> to your app's **Allowed redirection URL(s)** in the Partner Dashboard.

---

## Step 7 — Add staff email addresses

Staff emails are stored in KV. Add them through the Cloudflare dashboard:

1. **Cloudflare Dashboard → Workers & Pages → KV → CW_TRADEIN_AUTH**
2. Click **Add entry**
3. Key: `allowed_emails`
4. Value:
```json
["staff1@camerawest.com","staff2@camerawest.com","manager@camerawest.com"]
```
5. Click **Add entry**

**To add a new staff member later:** edit that same KV entry and add their email to the array.

**To remove access:** remove their email from the array. Their existing session expires within 8 hours.

---

## Step 8 — Set up email sending (MailChannels)

MailChannels is free on Cloudflare Workers and requires no account. However, it requires
your sending domain (`camerawest.com`) to have a DNS record authorizing Cloudflare to send.

Add this DNS TXT record in your domain's DNS settings:

```
Type:  TXT
Name:  _mailchannels
Value: v=mc1 cfid=cw-tradein-app.pages.dev
```

> If you manage DNS through Cloudflare, add this in **Cloudflare Dashboard → your domain → DNS**.
> If elsewhere (GoDaddy, etc.), add it there.

This usually takes a few minutes to propagate.

---

## Step 9 — Test it

1. Go to `https://cw-tradein-app.pages.dev`
2. Enter your email address (must be in the `allowed_emails` KV list)
3. Check your inbox — click the sign-in link
4. You should land on the Trade-In Manager

---

## Custom Domain (Optional)

To use `tradein.camerawest.com` instead of the `.pages.dev` URL:

1. **Cloudflare → Workers & Pages → cw-tradein-app → Custom domains**
2. Click **Set up a custom domain**
3. Enter `tradein.camerawest.com`
4. If your domain is on Cloudflare, the DNS record is added automatically
5. Update `APP_URL` environment variable to `https://tradein.camerawest.com`

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Email not arriving | Check DNS TXT record is set, allow 5-10 min to propagate |
| "Invalid or expired link" | Links expire in 15min and are one-use — request a new one |
| "Not on staff list" | Check KV entry — email must match exactly (lowercase) |
| Search returns no results | Verify `COLLECTION_ID` is the numeric ID from the URL |
| App shows login after clicking link | Check `APP_URL` env var matches your actual URL exactly |
| KV binding error | Make sure the binding variable name is exactly `AUTH_KV` |

---

## Managing staff access

| Action | How |
|--------|-----|
| Add staff member | Add email to `allowed_emails` KV array |
| Remove staff member | Remove email from array — session expires within 8hrs |
| Force immediate logout | Delete `session:*` entries from KV (or change their email) |
| See who's logged in | Browse KV entries starting with `session:` |
