# TrinketBot — Marketplace Module

A standalone Node.js Discord bot that handles marketplace listing creation for
the Haus of Trinkets server. Runs on GitHub Actions alongside the existing
Python bot (separate repo).

## Why a separate bot?

Discord's newer modal API (select menus + file uploads inside modals) is only
available in discord.js v14+. The Python discord.py library does not support
these features yet. This bot handles only the marketplace flow; everything else
stays in the Python bot.

## How it works

1. The Python bot's existing **"Create Listing"** panel button
   (`custom_id: create_marketplace_listing`) is left exactly as-is in Discord.
2. When a user clicks it, **this bot intercepts the interaction** — the Python
   bot no longer responds to it (its marketplace code is removed).
3. This bot runs the full listing flow and posts the finished forum thread.
4. Cooldowns and thread IDs persist in `cooldowns.json` / `threads.json`,
   committed back to the repo automatically by the workflow.

## Listing flow

| Step | Type | What it collects |
|------|------|-----------------|
| 1 | Modal | Number of items (1–10), general info |
| 2 | Modal | Payment methods (select, 1–3), shipping policy (select) |
| 3…N | Modal (×N) | Per item: name, price, notes, packaging condition, item condition |
| N+1 | Ephemeral message | Tag selection |
| N+2 | Modal | Photo file uploads (1–10) + handwritten note confirmation |

---

## Setup

### 1. Create the GitHub repo

```
git init
git add .
git commit -m "initial commit"
gh repo create trinketbot-marketplace --private --push --source=.
```

Or create the repo on github.com and push manually.

### 2. Create a second Discord bot account

- Go to https://discord.com/developers/applications
- Click **New Application** → name it (e.g. "TrinketBot Marketplace")
- Go to **Bot** → **Add Bot**
- Under **Privileged Gateway Intents**, no extra intents are needed
- Click **Reset Token** and copy the token — you won't see it again

### 3. Invite the new bot to your server

Replace `CLIENT_ID` with your new bot's application ID:

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&permissions=326417776640&scope=bot%20applications.commands
```

Required permissions (already encoded above):
- View Channels
- Send Messages
- Create Public Threads
- Send Messages in Threads
- Embed Links
- Attach Files
- Read Message History
- Manage Threads

### 4. Add the token as a GitHub Secret

1. Go to your repo on GitHub
2. **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `MARKETPLACE_TOKEN`
5. Value: the bot token from step 2

### 5. Enable GitHub Actions

Actions are enabled by default on new repos. The workflow file is at
`.github/workflows/bot.yml`.

To trigger it manually the first time:
1. Go to your repo → **Actions** tab
2. Click **Marketplace Bot** in the left sidebar
3. Click **Run workflow** → **Run workflow**

After that it runs automatically on every push to `main` and restarts itself
every 5 hours via a cron schedule (working around GitHub's 6-hour job limit).

### 6. Remove marketplace code from the Python bot

See the section below for exactly what to delete.

---

## Keeping data persistent across restarts

Because GitHub Actions spins up a fresh container each run, `cooldowns.json`
and `threads.json` need to be committed back to the repo to persist. Add this
step to the end of `.github/workflows/bot.yml` if you want automatic commits:

```yaml
      - name: Save state
        if: always()
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add cooldowns.json threads.json || true
          git diff --staged --quiet || git commit -m "chore: persist cooldown/thread state"
          git push || true
```

> **Note:** Without this, cooldowns reset every 5 hours (users could bypass
> the 14-day limit). Add the save step above if that matters to you.

---

## What to remove from the Python bot (main.py)

### Classes (delete entire class definitions)
- `MarketplaceModal`
- `MarketplaceConditionView`
- `MarketplaceModal2`
- `MarketplaceConditionPaymentView`
- `MarketplaceTagView`
- `MarketplacePhotoModal`
- `MarketplacePanelView`

### Functions (delete entirely)
- `create_marketplace_listing()`
- `load_shop_cooldowns()` and `save_shop_cooldowns()`
- `load_shop_threads()` and `save_shop_threads()`

### Global variables (delete these lines)
```python
SHOP_COOLDOWNS_FILE = "shop_cooldowns.json"
SHOP_THREADS_FILE = "shop_threads.json"
shop_cooldowns = load_shop_cooldowns()
shop_threads = load_shop_threads()
```

### Slash command (delete entire block)
```python
@bot.tree.command(name="setup_marketplace", ...)
async def setup_marketplace(...):
    ...
```

### In on_ready() (delete this one line)
```python
bot.add_view(MarketplacePanelView())
```

### Constants you can safely keep
```python
MARKETPLACE_FORUM_ID        # used by other things
MARKETPLACE_PANEL_CHANNEL_ID
MARKETPLACE_TAG_IDS
```

---

## File reference

| File | Purpose |
|------|---------|
| `index.js` | All bot logic |
| `package.json` | Node dependencies |
| `.github/workflows/bot.yml` | GitHub Actions workflow |
| `.gitignore` | Excludes node_modules, .env |
| `cooldowns.json` | Auto-created on first run |
| `threads.json` | Auto-created on first run |
