# Universe for Android

One APK per Universe app (Universe, Nova, Orbit, Pulsar, Jupiter, Inventory). Each is a full-screen shell around your deployed site, plus a resizable home-screen widget that reads the app's own widget endpoints (the same ones the Universe dashboard uses). No server changes.

## Build (no Android Studio needed)
1. Copy `android/` and `.github/` into the root of your Universe repo and commit.
2. GitHub > Settings > Secrets and variables > Actions > **Variables** > New variable: `UNIVERSE_URL` = `https://your-site.vercel.app` (https, no trailing slash).
3. Actions > **Build Android APKs** > Run workflow. Download the `universe-apks` artifact (a zip of six APKs).
4. Install the APKs (allow "install unknown apps"). Open an app, sign in once. Long-press the home screen > Widgets > pick the app.

Local build: `cd android && gradle assembleDebug -PuniverseUrl=https://your-site.vercel.app` (Gradle 8.9, JDK 17, Android SDK 34).

## How the widget gets its data
After you sign in inside the app, the WebView's `universe_sid` session cookie is copied into app-private storage. A WorkManager job (about every 15 minutes while a widget exists, or when you tap the refresh arrow) calls the app's widget endpoints with it and redraws the widget. Your session lasts 7 days, so after that the widget says "Open <app> and sign in" until you sign in again.

Widget data per app: Nova (summary + attention list), Jupiter (summary + recently played), Pulsar (summary), Inventory (summary + recent). Universe and Orbit have no widget: Orbit sits behind your Finance PIN and a home-screen widget would bypass it.

## Known limits
- **Never compiled or run.** Written without an Android SDK. Expect to fix small things on the first build; the workflow log will say exactly what.
- Jupiter: the lock-screen / notification player controls come from Chrome's Media Session support and do not exist in a plain WebView. Background audio may stop when Android freezes the app. A widget with play/pause/next needs a native player (Media3 service) - not built.
- Not handled: web notifications, camera capture, blob downloads (e.g. PDF export), and Android's "install app" prompts inside the shell.
- Debug-signed with the committed `debug.keystore` (so updates install over old builds). Fine for your own phone; never publish that key's APK to the Play Store.
