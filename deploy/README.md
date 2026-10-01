# Running the meal planner on microk8s

One pod, one volume, no inbound ports. The agent dials out to Slack over Socket
Mode and to Kroger over HTTPS, so there is no Service, no Ingress and no
certificate to manage.

Everything irreplaceable — two years of purchase history, the recipe library,
the cart ledger, the Kroger refresh token the app rotates for itself — lives on
one PVC on local SSD.

## 1. Move the secrets to a shared vault

A 1Password service account can only be granted vaults its creator can share,
and a personal vault is not one of those. Both items have to live in the `tynet`
vault:

- `slack.mealplanner` — `bot_token`, `app_token`, `user_id`, `allowed_users`,
  `channel_id`. **Already moved.**
- `kroger.developer` — `client_id`, `client_secret`. **Still in `Private`** —
  move it, or `kroger-credentials` will never sync and the pod will start with
  no Kroger access.

Moving an item changes its `op://` path, so `.env.op` tracks the vault too. The
Slack references there already point at `tynet`; the Kroger ones still say
`Private` and should be changed in the same breath as the move.

When you create the service account, check that `tynet` appears in its vault
list. If it does not, service accounts are turned off for that vault.

## 2. Install the 1Password operator

Everything from here runs **on the Pi**. Copy the repo over (or clone it there)
and work from `deploy/`.

Check the node before changing anything:

```sh
./install.sh preflight
```

It fails loudly on the two things that bite a Pi specifically:

- **Memory cgroup off.** On a Pi this is disabled unless it was turned on in the
  boot cmdline, and without it any pod with a memory limit — this one has one —
  is killed at startup with an error that never mentions the Pi. Fix is one line
  in `/boot/firmware/cmdline.txt` plus a reboot; the script prints it.
- **Storage on the SD card.** `hostpath-storage` writes under the snap common
  dir on the root filesystem. If root is the SD card, the database and every
  SQLite write land there — slow, and it wears the card out. The script names
  the backing device so you can see where it is actually going.

Then:

```sh
./install.sh operator
```

This enables the addons, installs the chart with Connect switched off, and asks
for the service account token with `read -rs` — not echoed, not in your shell
history, never through this chat. It also verifies the operator really received
`OP_SERVICE_ACCOUNT_TOKEN` and sets it directly if the chart's value name has
moved again, which it has before.

## 3. Build the image on the Mac and ship it

The node is arm64, so the image must be arm64. From the repo root on your Mac:

```sh
./deploy/build-image.sh pi.lan              # push to the node's registry
./deploy/build-image.sh pi.lan --tarball    # or ship it over ssh, no registry
```

It refuses to ship an image built for the wrong architecture. That check is
there because the failure otherwise surfaces much later, as `exec format error`
in a crash loop, long after the push looked fine — `better-sqlite3` is native
code, so a mismatched build cannot be papered over.

The Deployment refers to `localhost:32000/meal-planner:0.1.0`. That is correct
even when you push to `pi.lan:32000`: containerd resolves it on the node, where
the registry is local.

## 4. Seed the volume

The database and the Kroger refresh token already exist on your Mac. A fresh
start would lose two years of history and force a re-auth.

**Stop the bot first.** Copying a database with a live WAL gives you a torn
copy — this is the step in the whole process with a real, irreversible cost.

```sh
# On the Mac, with the bot stopped:
sqlite3 ~/.claude-grocery/claude-grocery.db 'PRAGMA wal_checkpoint(TRUNCATE);'
scp ~/.claude-grocery/claude-grocery.db \
    ~/.config/claude-grocery/kroger-token.json \
    ~/src/claude-grocery-kroger-agent/data/week-events.json \
    pi.lan:~/claude-grocery-kroger-agent/deploy/seed/

# On the Pi:
./install.sh seed
```

`deploy/seed/` is gitignored — the database and the token must never end up in
the repo.

## 5. Deploy

```sh
./install.sh deploy
./install.sh status
```

`deploy` waits for the operator to produce both Secrets and, if they never
arrive, prints the three things that actually cause it — item still in
`Private`, vault not granted to the service account, item name not matching
`itemPath` — along with the operator's own log.

The `--push` arg in `deployment.yaml` makes it post the week on start, which is
the real smoke test: if a plan shows up in Slack, every piece of this worked.
Remove it once a timer exists.

## What is deliberately not here

**No Service, no Ingress.** Nothing connects in.

**No HorizontalPodAutoscaler, and `replicas: 1` is an invariant.** Two instances
mean duplicate Slack events and two processes adding to the same cart. The Cart
API only adds — it cannot read the cart back or clear it — so a doubled order is
fixed by hand or not at all. For the same reason the update strategy is
`Recreate`: a rolling update would overlap the pods.

**No CronJob for the Saturday push.** The plan being edited currently lives in
the bot's memory, so a second process could not post or approve it — it would
race the one holding the socket. Until the pending plan is persisted to SQLite,
the timer has to run inside the process. That change is worth making on its own:
it also means a restart or a reschedule stops losing a week someone was
part-way through editing.

**No probes.** See the comment in `deployment.yaml`.

## On 1Password Environments

[Environments](https://www.1password.dev/environments/local-env-file) are a good
replacement for `op run --env-file=.env.op` on a laptop, but the local workflow
mounts the file through a named pipe behind an interactive authorization prompt,
on Mac and Linux desktops only, and is explicitly not built for concurrent
unattended readers. A pod has nobody to approve the prompt.

So: Environments locally if you like them, `OnePasswordItem` in the cluster. The
values are the same either way — only the way they are read differs.

## Why this operator and not External Secrets

External Secrets would also work, and its 1Password SDK provider needs no
Connect server either. The official operator wins here on two specifics: it
restarts the deployment itself when an item changes, which otherwise means
running Stakater Reloader as well, and it is one less layer between a secret and
the thing using it. External Secrets earns its keep when secrets come from
several backends at once; here they all come from 1Password.

The tradeoff taken on purpose: the operator maps a whole item to a Secret and
cannot cherry-pick fields across items, which is why there are two Secrets here
and why `deployment.yaml` maps them field by field.
