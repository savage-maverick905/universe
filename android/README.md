# Universe for Android (v2)

One APK per Universe app (Universe, Nova, Orbit, Pulsar, Jupiter, Inventory): a black, native-feeling shell around your deployed site.

## Build (no Android Studio needed)
1. Copy `android/` and `.github/` into your repo and commit.
2. GitHub > Settings > Secrets and variables > Actions > **Variables**: `UNIVERSE_URL` = `https://your-site.vercel.app`.
3. Actions > **Build Android APKs** > Run workflow. Download `universe-apks`, install, open each app and sign in once.
4. Uninstall the old APKs first if the launcher still shows old widget names.

Everything that differs per app (name, widgets, data endpoints, notification feeds) is one table at the top of `app/build.gradle`.

## Widgets (long-press home screen > Widgets > the app)
| App | Widgets |
|---|---|
| Jupiter | Now playing (4x2, art + progress + prev/play/next), Mini player (4x1), Overview, Stats, Recently played |
| Nova | Overview, Stats, Needs attention, New task |
| Inventory | Overview, Stats, Recent items, Add item |
| Pulsar | Overview, Stats, New page |
| Orbit, Universe | none (Orbit is behind your PIN) |

## Music controls
Jupiter reports what is playing to the shell; the shell shows a media notification (lock screen, shade, headset buttons) and drives the player widgets. Back moves the app to the background while music plays.

## Notifications
Nova and Orbit nudges become real Android notifications, checked every minute while the app is open and about every 15 minutes in the background. The Universe APK covers any app whose own APK is not installed. Inventory, Pulsar and Jupiter have no server-side nudge feed yet.

## Known limits
- **Never compiled here** (no Android SDK). Expect to fix small things on the first build; the workflow log says what.
- If Android kills the app process, the music stops and the player widgets show the last track until you reopen Jupiter.
- Debug-signed with the committed keystore. Fine for your phone; never publish it.

Icons: `python3 scripts/make-icons.py` regenerates every web and Android icon.
