# Vercel Environment Variables Setup Guide

## Quick Answer

**No, you do NOT need to add `VITE_API_URL` to Vercel environment variables!**

Here's why:

## How It Works

### In Your Setup

Your frontend uses **relative API paths** like `/api/login`, `/api/prescriptions`, etc.

The `vercel.json` file handles routing these requests to your Koyeb backend:

```json
{
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://meaningful-andy-atlascare-deploy-827fa93f.koyeb.app/api/:path*"
    }
  ]
}
```

### Request Flow

```
User Browser
    ↓
https://atlascaretech.vercel.app/api/login
    ↓ (Vercel rewrites this to ↓)
https://meaningful-andy-atlascare-deploy-827fa93f.koyeb.app/api/login
    ↓
Your Koyeb Backend
```

## Environment Variables You DON'T Need on Vercel

❌ `VITE_API_URL` - Not needed because vercel.json handles routing
❌ `VITE_BACKEND_URL` - Not needed
❌ Any API URL variables - Not needed

## Environment Variables You MIGHT Need on Vercel (Optional)

These are only if your frontend code specifically uses them:

✅ **If you have any Hedera-related frontend configs:**
```
VITE_HEDERA_NETWORK=testnet
```

✅ **If you have any feature flags:**
```
VITE_ENABLE_ANALYTICS=true
```

✅ **If you have any public API keys (non-sensitive):**
```
VITE_PUBLIC_KEY=your-public-key
```

## Environment Variables You NEED on Koyeb (Backend)

On your Koyeb deployment, make sure you have:

```bash
# Required
HEDERA_ACCOUNT_ID=0.0.YOUR_ACCOUNT_ID
HEDERA_PRIVATE_KEY=YOUR_PRIVATE_KEY
JWT_SECRET=your-jwt-secret-min-32-characters-long
SIGNATURE_SALT=your-signature-salt
CNDP_SALT=your-cndp-salt

# Recommended for CORS
FRONTEND_URL=https://atlascaretech.vercel.app

# Optional (if using email)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
```

## Vercel Deployment Settings

When deploying to Vercel, use these settings:

| Setting | Value |
|---------|-------|
| Framework Preset | Vite |
| Root Directory | `frontend` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` |

**Environment Variables Section:** Leave empty (unless you have specific frontend configs)

## How to Add Environment Variables on Vercel (If Needed)

1. Go to your project on Vercel
2. Click **Settings** → **Environment Variables**
3. Add variables in format:
   - **Key**: `VITE_YOUR_VARIABLE`
   - **Value**: `your-value`
   - **Environment**: Select Production, Preview, and/or Development

**Important**: All Vite environment variables must start with `VITE_` to be exposed to the frontend.

## Summary

✅ **Your current setup is complete** - no environment variables needed on Vercel
✅ **vercel.json handles all API routing** automatically
✅ **Just deploy and it will work** - the rewrites configuration does everything

## Testing After Deployment

After deploying to Vercel:

1. Open `https://atlascaretech.vercel.app`
2. Open browser DevTools (F12) → Network tab
3. Try logging in
4. You should see requests to `/api/login` succeed
5. In the Network tab, you'll see the request goes to your Vercel domain, but Vercel forwards it to Koyeb

If you see any errors, check:
- Vercel deployment logs
- Koyeb backend logs
- Browser console for CORS errors
