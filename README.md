# Vikrant Control Room API

Shared backend for the Vikrant Restoration & Development Control Room dashboard.
Stores the whole dashboard state (BOQ, schedule, approvals, risks, tasks, photo
metadata) as one document in MongoDB, and stores photographs in Cloudinary.

## Endpoints

- `GET  /api/health` — liveness check
- `GET  /api/state` — fetch the shared dashboard state
- `PUT  /api/state` — overwrite the shared dashboard state (body: `{ "state": {...} }`)
- `POST /api/photos` — upload a photo (multipart form: `photo` file + `area` field)
- `DELETE /api/photos/<publicId>` — remove a photo from Cloudinary

## Run locally

```
cd backend
npm install
cp .env.example .env      # then fill in your real MongoDB/Cloudinary values
npm start
```

Server listens on `http://localhost:4000` by default.

## Deploy to Render (free tier)

1. Push this repo to GitHub (already done if you're reading this from the deployed site).
2. Go to https://dashboard.render.com → **New** → **Web Service** → connect the
   `asl_vikrant_FE` repo.
3. Set **Root Directory** to `backend`.
4. Build command: `npm install`. Start command: `npm start`.
5. Under **Environment**, add these variables (copy the real values from your local
   `backend/.env` — never commit that file):
   - `MONGO_URI`
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
   - `ALLOWED_ORIGINS` — set to `https://aartech01.github.io` (add more origins,
     comma-separated, if you serve the frontend from elsewhere too)
6. Deploy. Render gives you a URL like `https://vikrant-control-room-api.onrender.com`.
7. Open `index.html` (repo root) and edit the `API_BASE` constant near the top of the
   `<script>` block to that URL, then commit and push — GitHub Pages redeploys
   automatically.

Note: Render's free tier sleeps after 15 minutes of inactivity and takes ~30–60s to
wake on the next request — the dashboard's sync indicator will show "syncing" during
that wake-up, then settle to "live".
