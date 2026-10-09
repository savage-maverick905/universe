# Tasks (example application)

A deliberately tiny app that shows every integration point: manifest, data, permissions, API, dashboard widget, AI tool, report, install/disable.
It lives in `docs/examples/tasks/` so it does not appear in your Apps list. To try it for real, copy the folder to `apps/tasks/` and restart the server (see `docs/ADDING_A_NEW_APPLICATION.txt`). `tests/example-app.test.js` runs this exact folder through the real ecosystem code, so it cannot silently go stale.

Data: collection `tasks_items` (id, ownerId, title, done). Each user sees only their own tasks.
